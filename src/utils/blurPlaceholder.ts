// Blur-up card placeholder (`games.image_base64`) — single source of truth (used by Add/CreateGame,
// AddGame/ManualCreate, CyoaPage/GameEditDialog). Recipe: fit 100x133, WebP q40,
// `data:image/webp;base64,...`. The PB text field used to cap at 5000; busy covers overflowed and
// PB rejected the WHOLE create with an error naming a field the user never filled. Cap raised to
// 20000 (PB/bump_image_base64_max.py). The ladder below is a belt-and-braces guard: step down
// quality, then dimensions; if even the smallest overflows return null and omit the field (cosmetic
// loss). In practice never fires (densest covers ~5000 chars). BLUR_MAX_CHARS must stay BELOW the
// PB cap — it also bounds catalog payload, since image_base64 ships with every card. Pipeline
// builds the same placeholder in `CYOA Harvester/utils/image_base64.py` — keep recipes and clamp in
// sync.

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

// Build the card placeholder data-URL, guaranteed within `BLUR_MAX_CHARS`. Returns null if it can't
// be built or squeezed — callers must omit the field.
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
