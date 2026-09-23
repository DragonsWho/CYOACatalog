// Pictures a player uploaded onto cards inside the game. Native ICC builds carry them INLINE as a
// `/IMG#<data-url>` suffix (the engine reads via FileReader, shrinks on canvas, stores base64 in
// `choice.image`). Even a small avatar is 55–110 KB of base64 and alone exceeds the comment mirror
// cap (30 000 chars). So before saving we replace data URLs with links to our copy: bytes go to
// `build_images` (`/api/custom/build-image`, build_images.go), the build keeps a short path. The
// engine doesn't care — it renders cards from plain URLs too (same branch as externally hosted
// art), so `code` stays a valid native build string. sha256 dedup makes this cheap: "Update my
// build" after every edit only probes the hash after the first time.

import { pb } from '../../../pocketbase/pocketbase';
import type { CheatBuild } from './buildComment';

const ENDPOINT = '/api/custom/build-image';

// Same limit as the backend: don't upload a file that will be refused; show the error before
// sending.
const MAX_IMAGE_BYTES = 2 << 20;

// Returns null for anything that isn't an image data URL — including already-replaced links.
function decodeDataUrl(src: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/is.exec(src.trim());
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1].toLowerCase() };
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Dimensions in the filename (`640x480.webp`), same trick as chat: the thread knows proportions
// before loading, no layout jump.
function measure(blob: Blob): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v: { w: number; h: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// The backend returns a PATH (`/api/files/...`) — behind Cloudflare it doesn't know its
// scheme/host. Expanding is mandatory: the link goes into the build string, which lives inside the
// game on `<slug>.cyoa.cafe` (or anywhere pasted), where a relative path resolves to a foreign
// origin.
function absolute(url: string): string {
  return url.startsWith('/') ? window.location.origin + url : url;
}

// Probe for an existing upload with this content: cheaper than sending the bytes.
async function probe(hash: string): Promise<string | null> {
  const res = await fetch(`${ENDPOINT}?hash=${hash}`, {
    headers: { Authorization: pb.authStore.token },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { url?: string };
  return data.url ? absolute(data.url) : null;
}

async function upload(bytes: Uint8Array, mime: string): Promise<string> {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const size = await measure(blob);
  const name = `${size ? `${size.w}x${size.h}` : 'build-image'}${EXT[mime] || '.png'}`;
  const fd = new FormData();
  fd.append('image', new File([blob], name, { type: mime }));
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: pb.authStore.token },
    body: fd,
  });
  const data = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
  if (!res.ok || !data.url) throw new Error(data.message || 'Could not upload the image');
  return absolute(data.url);
}

// The same picture appears on several cards: memoize within one save.
async function hostOne(src: string, cache: Map<string, string>): Promise<string> {
  const known = cache.get(src);
  if (known) return known;
  const decoded = decodeDataUrl(src);
  if (!decoded) return src;
  if (decoded.bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`One of the pictures is too big (max ${MAX_IMAGE_BYTES >> 20} MB)`);
  }
  const hash = await sha256Hex(decoded.bytes);
  const url = (await probe(hash)) || (await upload(decoded.bytes, decoded.mime));
  cache.set(src, url);
  return url;
}

// Replace all player pictures with links in BOTH `code` and `summary`, with the same value: `code`
// goes back into the engine on load, `summary` shows in the thread — if they diverged, the thread
// card and the game would show different pictures. If upload fails (quota, network, refusal) the
// build is saved WITHOUT the picture: losing a picture is bad, losing the whole build (the only
// record of an hour of clicking) is worse. What was lost is returned in `warning` for the caller to
// say out loud.
export async function resolveBuildImages(
  build: CheatBuild,
): Promise<{ build: CheatBuild; warning?: string }> {
  const summary = build.summary;
  const withImages = (summary?.choices || []).filter((c) => c.img && c.img.startsWith('data:'));
  if (!withImages.length) return { build };

  const cache = new Map<string, string>();
  const replace = new Map<string, string>();
  let failed = 0;
  let reason = '';
  for (const c of withImages) {
    const src = c.img as string;
    if (replace.has(src)) continue;
    try {
      replace.set(src, await hostOne(src, cache));
    } catch (e) {
      failed++;
      reason = e instanceof Error ? e.message : String(e);
    }
  }

  let code = build.code;
  const choices = (summary?.choices || []).map((c) => {
    if (!c.img || !c.img.startsWith('data:')) return c;
    const url = replace.get(c.img);
    // In the build string the picture has escaped commas (`/CHAR#`) — replace exactly the form the
    // shim wrote.
    const escaped = c.img.split(',').join('/CHAR#');
    if (url) {
      code = code.split(escaped).join(url.split(',').join('/CHAR#'));
      return { ...c, img: url };
    }
    // Upload failed: cut the suffix entirely, else a base64 blob alone blows the comment cap.
    code = code.split(`/IMG#${escaped}`).join('');
    return { ...c, img: undefined };
  });

  return {
    build: { code, summary: { ...summary, choices } },
    warning: failed
      ? `${failed === 1 ? 'A picture' : `${failed} pictures`} could not be saved (${reason}). The rest of the build was saved.`
      : undefined,
  };
}
