// Width/height ratio of a base64 WebP data URI read from its header (no decode): lets a page reserve
// the cover's box before any image decodes, so content below doesn't jump. The blur placeholders
// (`games.image_base64`) keep the cover's proportions (fit into 100x133), so their ratio is the
// cover's. Returns null for anything it can't parse.
export function webpAspect(dataUri: string | undefined | null): number | null {
  if (!dataUri) return null;
  const b64 = dataUri.startsWith('data:') ? dataUri.slice(dataUri.indexOf(',') + 1) : dataUri;
  let bin: string;
  try {
    bin = atob(b64.slice(0, 48));
  } catch {
    return null;
  }
  const at = (i: number) => bin.charCodeAt(i);
  if (bin.slice(0, 4) !== 'RIFF' || bin.slice(8, 12) !== 'WEBP') return null;
  const chunk = bin.slice(12, 16);
  let w = 0;
  let h = 0;
  if (chunk === 'VP8 ') {
    w = (at(26) | (at(27) << 8)) & 0x3fff;
    h = (at(28) | (at(29) << 8)) & 0x3fff;
  } else if (chunk === 'VP8L') {
    const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
    w = (bits & 0x3fff) + 1;
    h = ((bits >> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    w = (at(24) | (at(25) << 8) | (at(26) << 16)) + 1;
    h = (at(27) | (at(28) << 8) | (at(29) << 16)) + 1;
  }
  return w > 0 && h > 0 ? w / h : null;
}
