// Cloudflare Image Transformations helper: wraps a same-origin path
// (`/api/files/<coll>/<id>/<file>`) in `/cdn-cgi/image/` so CF resizes/re-encodes at the edge
// (AVIF/WebP by Accept; original untouched on R2). Only catalog card and detail covers use it —
// hosted game pages never do, so their images stay full quality. Requires Image Transformations
// enabled for the zone. On transform failure callers fall back to the raw path via <img> onerror.

export interface CfImageOpts {
  width: number;
  quality?: number;
  // `format=auto` lets CF pick AVIF/WebP/original by the client's Accept header.
  format?: 'auto' | 'webp' | 'avif';
}

// Returns the path unchanged for data: URLs or empty input.
export function cfImage(path: string | null | undefined, opts: CfImageOpts): string {
  if (!path || path.startsWith('data:')) return path ?? '';
  const params = [
    `width=${Math.round(opts.width)}`,
    `quality=${opts.quality ?? 70}`,
    `format=${opts.format ?? 'auto'}`,
  ].join(',');
  return `/cdn-cgi/image/${params}${path}`;
}

// Width-descriptor srcSet; with `sizes` the browser downloads the variant matching the slot's real
// rendered width × DPR (a 5-up grid pulls ~240px, not 400px). CF never upscales, so large widths
// are harmless. Each requested width counts once against the monthly transformation quota.
export function cfImageSrcSet(path: string | null | undefined, widths: number[], quality = 70): string | undefined {
  if (!path || path.startsWith('data:')) return undefined;
  return widths
    .map((w) => `${cfImage(path, { width: w, quality })} ${w}w`)
    .join(', ');
}
