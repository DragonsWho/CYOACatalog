// Cloudflare Image Transformations helper.
//
// Wraps a same-origin image path (e.g. `/api/files/<coll>/<id>/<file>`) in the
// zone's `/cdn-cgi/image/` endpoint so Cloudflare resizes + re-encodes it on the
// edge (AVIF/WebP via the Accept header, original kept untouched on R2). Only the
// catalog card cover and the game-detail cover go through this — game pages on the
// subhosts never build these URLs, so their images stay full quality.
//
// Transformations must be enabled for the zone (Speed → Image Optimization →
// Image Transformations). If a transform ever fails, callers fall back to the raw
// path via the <img> onerror handler.

export interface CfImageOpts {
  width: number;
  quality?: number;
  // `format=auto` lets CF pick AVIF/WebP/original per the client's Accept header.
  format?: 'auto' | 'webp' | 'avif';
}

/**
 * Build a Cloudflare-transformed URL for a same-origin image path.
 * Returns the original path unchanged for data: URLs or empty input.
 */
export function cfImage(path: string | null | undefined, opts: CfImageOpts): string {
  if (!path || path.startsWith('data:')) return path ?? '';
  const params = [
    `width=${Math.round(opts.width)}`,
    `quality=${opts.quality ?? 70}`,
    `format=${opts.format ?? 'auto'}`,
  ].join(',');
  // path already starts with "/"
  return `/cdn-cgi/image/${params}${path}`;
}

/**
 * Width-descriptor srcSet (`<url> 240w, <url> 360w, ...`). Combined with a `sizes`
 * attribute on the <img>, the browser downloads the variant that matches the
 * slot's real rendered width × DPR — not just the device pixel ratio. This is what
 * lets a 5-up catalog grid pull a ~240px image instead of a 400px one.
 *
 * Cloudflare never upscales past the source, so listing a large width is harmless
 * (it just clamps to the original). Each width actually requested counts once
 * against the monthly transformation quota.
 */
export function cfImageSrcSet(path: string | null | undefined, widths: number[], quality = 70): string | undefined {
  if (!path || path.startsWith('data:')) return undefined;
  return widths
    .map((w) => `${cfImage(path, { width: w, quality })} ${w}w`)
    .join(', ');
}
