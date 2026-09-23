// Emoji pack management over /api/custom/chat/emoji. Everything except reads is multipart (one
// server parsing path; rename and image change aren't two endpoints). Only changed fields are sent:
// PATCH must not blank what wasn't asked. Conversion here is for static images only: the browser
// canvas can't build animations (a third of the pack), so animated ones are prepared by
// the (private) emoji-pack builder and the panel accepts the finished .webp.

import { authedFetch } from '../../pocketbase/pocketbase';
import { EMOJI_API, reloadEmojiPack } from './registry';

// Shortcode bounds live in three more places — keep in sync: chatEmojiNameRe (chat_emoji.go),
// SHORTCODE (Shoutbox/richText.tsx), SHORTCODE_MIN/MAX (emoji-pack builder).
export const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

// Same cap as the collection schema and chat_emoji.go.
export const EMOJI_MAX_BYTES = 512000;

// Static target side, equal to STATIC_SIZE in build.py, or panel uploads look off in sharpness.
const STATIC_SIZE = 128;

export interface EmojiPatch {
  name?: string;
  pack?: string;
  source?: string;
  quick?: boolean;
  hidden?: boolean;
  w?: number;
  h?: number;
  file?: Blob;
}

function toForm(patch: EmojiPatch): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v instanceof Blob) fd.append(k, v, 'emoji.webp');
    else fd.append(k, String(v));
  }
  return fd;
}

async function send(url: string, method: string, body?: BodyInit): Promise<void> {
  const res = await authedFetch(url, { method, body });
  if (!res.ok) {
    // Server replies with a human message (name taken, wrong format) — show it instead of "500".
    const data = await res.json().catch(() => null) as { message?: string } | null;
    throw new Error(data?.message || `Request failed (${res.status})`);
  }
  // One pack for everyone and edits must show immediately — refetch whole, not patch locally, so
  // the panel never diverges from the server.
  await reloadEmojiPack();
}

export const createEmoji = (patch: EmojiPatch): Promise<void> =>
  send(EMOJI_API, 'POST', toForm(patch));

export const updateEmoji = (id: string, patch: EmojiPatch): Promise<void> =>
  send(`${EMOJI_API}/${id}`, 'PATCH', toForm(patch));

export const deleteEmoji = (id: string): Promise<void> =>
  send(`${EMOJI_API}/${id}`, 'DELETE');

// 'up'/'down' swap with neighbor, 'top' to start. Neighbor computed on the server by global order,
// not on-screen: the panel filter mustn't change an arrow's meaning.
export const moveEmoji = (id: string, dir: 'up' | 'down' | 'top'): Promise<void> =>
  send(`${EMOJI_API}/move`, 'POST', JSON.stringify({ id, dir }));

export interface PreparedEmoji {
  blob: Blob;
  w: number;
  h: number;
  converted: boolean;
}

const isWebp = (f: File) => f.type === 'image/webp' || /\.webp$/i.test(f.name);
const isAnimatedSource = (f: File) => f.type === 'image/gif' || /\.(gif|apng)$/i.test(f.name);

// Default name from filename, same as build.py, so one image gets the same shortcode via script or
// panel.
export function suggestName(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

// Finished webp passes through (build.py already encoded it; re-encoding loses twice). png/jpg →
// 128px webp via canvas. GIF deliberately rejected with a reason: canvas takes one frame, silently
// breaking animation.
export async function prepareEmoji(file: File): Promise<PreparedEmoji> {
  if (isWebp(file)) {
    if (file.size > EMOJI_MAX_BYTES) {
      throw new Error(`This one is ${Math.round(file.size / 1024)} KB — the limit is `
        + `${EMOJI_MAX_BYTES / 1024} KB. Re-run build.py to squeeze it.`);
    }
    const { w, h } = await imageSize(file);
    return { blob: file, w, h, converted: false };
  }
  if (isAnimatedSource(file)) {
    throw new Error('Animated files must be converted to animated WebP first (emoji-pack builder) — '
      + 'the browser can only keep one frame. Drop the finished .webp here.');
  }
  const bitmap = await createImageBitmap(file);
  // Fit into the square without stretching.
  const scale = Math.min(STATIC_SIZE / bitmap.width, STATIC_SIZE / bitmap.height, 1);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', 0.82);  // same quality as STATIC_Q
  });
  if (!blob) throw new Error('Could not convert this image');
  if (blob.size > EMOJI_MAX_BYTES) {
    throw new Error('Converted file is still too big — try a smaller source.');
  }
  return { blob, w, h, converted: true };
}

function imageSize(file: Blob): Promise<{ w: number; h: number }> {
  return createImageBitmap(file).then((b) => {
    const size = { w: b.width, h: b.height };
    b.close();
    return size;
  }).catch(() => ({ w: 0, h: 0 }));
}
