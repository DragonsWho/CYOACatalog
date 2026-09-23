// First frame of an animated emoji for "don't animate emoji". Browsers can't stop <img> animation
// (no CSS, no attribute), so we capture the first frame and substitute it. createImageBitmap(blob)
// returns exactly the first frame per spec. Drawing a live <img> on canvas lies: the animation has
// advanced and the "frozen" emoji freezes on a random grimace. Cached for the tab's lifetime
// (dozens of repeats in the feed); the image comes from Cloudflare cache, so no real extra request.

import { EmojiDef, emojiUrl } from './registry';

const frames = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

async function snap(emoji: EmojiDef): Promise<string | null> {
  const res = await fetch(emojiUrl(emoji));
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return null; }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

// Synchronous lookup so re-renders don't flash the animation for a tick while a promise resolves.
export const frozenFrame = (id: string): string | undefined => frames.get(id);

// Errors swallowed: show it animated rather than not at all.
export function freezeEmojiFrame(emoji: EmojiDef): Promise<string | null> {
  const done = frames.get(emoji.id);
  if (done) return Promise.resolve(done);
  let p = pending.get(emoji.id);
  if (!p) {
    p = snap(emoji)
      .catch(() => null)
      .then((url) => {
        if (url) frames.set(emoji.id, url);
        pending.delete(emoji.id);
        return url;
      });
    pending.set(emoji.id, p);
  }
  return p;
}
