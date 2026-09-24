// Cover images in the catalog format: 960×1280 WebP (3:4, top-anchored crop) plus the 100×133 blurry
// placeholder stored in image_base64 — same numbers as Screenshot Studio.
const OUT_W = 960;
const OUT_H = 1280;
const PH_W = 100;
const PH_H = 133;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not an image the browser can read.')); };
    img.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode WebP.'))), 'image/webp', quality);
  });
}

export interface PreparedCover {
  blob: Blob;
  placeholder: string;
}

// Scale to cover 3:4, keep the TOP of tall screenshots (the title/intro is what the card should show).
export async function prepareCover(file: Blob): Promise<PreparedCover> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.max(OUT_W / img.naturalWidth, OUT_H / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (OUT_W - w) / 2, 0, w, h);
  const blob = await toBlob(canvas, 0.8);

  const tiny = document.createElement('canvas');
  tiny.width = PH_W;
  tiny.height = PH_H;
  const tctx = tiny.getContext('2d', { alpha: false })!;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(canvas, 0, 0, PH_W, PH_H);
  return { blob, placeholder: tiny.toDataURL('image/webp', 0.4) };
}
