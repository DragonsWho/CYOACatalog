// Blur-up card placeholder (`games.image_base64`) — single source of truth.
//
// The catalog card paints this tiny data-URL while the real cover loads
// (GameCard.tsx). It was duplicated in three places (Add/CreateGame,
// AddGame/ManualCreate, CyoaPage/GameEditDialog) with the same recipe:
// fit within 100x133, WebP q40, `data:image/webp;base64,...`.
//
// The PB field is a text column with a hard cap. It used to be 5000, and a busy
// cover (dense collage, noisy art) encoded past it, so PocketBase rejected the
// WHOLE create with `image_base64: Must be no more than 5000 character(s)` — an
// error naming a field the user never filled in, with no way past it. The cap
// was raised to 20000 (`PB/bump_image_base64_max.py`) so the canonical q40
// placeholder always fits and nobody loses their blur-up.
//
// The ladder below stays as a belt-and-braces guard against a pathological
// cover: step down quality, then dimensions, until the data-URL fits; if even
// the smallest step overflows, return null and skip the field (the card just
// paints without a blur-up, which is cosmetic). In practice it never fires —
// the densest covers in the catalog land around 5000 chars.
//
// BLUR_MAX_CHARS must stay BELOW the PB cap: it is also what keeps the catalog
// list payload sane, since image_base64 ships with every card.
//
// The pipeline builds the same placeholder in `CYOA Harvester/utils/image_base64.py`
// — keep the two recipes (and this clamp) in sync.

import { encode as webpencode } from '@jsquash/webp';

// PB schema cap is 20000; stay well under it.
export const BLUR_MAX_CHARS = 12000;

const TARGET_W = 100;
const TARGET_H = 133;

// Tried in order: canonical recipe first, then progressively cheaper.
const LADDER: { w: number; h: number; quality: number }[] = [
  { w: TARGET_W, h: TARGET_H, quality: 40 },
  { w: TARGET_W, h: TARGET_H, quality: 25 },
  { w: TARGET_W, h: TARGET_H, quality: 12 },
  { w: 64, h: 85, quality: 25 },
  { w: 48, h: 64, quality: 20 },
];

function fitInside(bitmap: ImageBitmap, boxW: number, boxH: number) {
  const sourceAspect = bitmap.width / bitmap.height;
  let width = boxW;
  let height = boxH;
  if (sourceAspect > boxW / boxH) {
    height = Math.round(boxW / sourceAspect);
  } else {
    width = Math.round(boxH * sourceAspect);
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

async function encodeStep(
  bitmap: ImageBitmap,
  step: { w: number; h: number; quality: number },
): Promise<string> {
  const { width, height } = fitInside(bitmap, step.w, step.h);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const buf = await webpencode(imageData, {
    quality: step.quality,
    lossless: 0,
    filter_strength: 100,
    filter_sharpness: 7,
  });
  const blob = new Blob([buf], { type: 'image/webp' });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Build the `data:image/webp;base64,...` card placeholder, guaranteed to fit
 * within `BLUR_MAX_CHARS`. Returns null when it cannot be built (or cannot be
 * squeezed small enough) — callers must then simply omit the field.
 */
export async function makeBlurPlaceholder(
  src: ImageBitmap | Blob,
): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  let ownsBitmap = false;
  try {
    if (src instanceof Blob) {
      bitmap = await createImageBitmap(src);
      ownsBitmap = true;
    } else {
      bitmap = src;
    }

    let last = '';
    for (const step of LADDER) {
      last = await encodeStep(bitmap, step);
      if (last.length <= BLUR_MAX_CHARS) return last;
    }
    console.warn(
      `[blurPlaceholder] still ${last.length} chars after the last step — skipping the field.`,
    );
    return null;
  } catch (e) {
    console.warn('[blurPlaceholder] failed:', e);
    return null;
  } finally {
    if (ownsBitmap) bitmap?.close();
  }
}
