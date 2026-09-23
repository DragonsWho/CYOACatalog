// Truncation with a CUSTOM ellipsis for narrow chat lists (rooms column, members list). Native
// `text-overflow: ellipsis` uses the text's font and color — the wide glyph eats letters and can't
// be styled. So text is clipped (`clip`, up to the edge) and our own smaller, dimmer mark is placed
// flush; it also acts as right padding.

import { useLayoutEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';

export default function TruncText({ children, watch }: {
  children: React.ReactNode;
  watch?: unknown;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Width changes with the panel (slide, rotation) and the text — measure via ResizeObserver, not
    // once on mount.
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [watch]);

  return (
    <Box component="span" sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline' }}>
      <Box
        component="span"
        ref={ref}
        sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'clip', whiteSpace: 'nowrap' }}
      >
        {children}
      </Box>
      {/* Show only when the text really overflows. */}
      {cut && (
        <Box
          component="span"
          aria-hidden
          sx={{ flexShrink: 0, fontSize: 11, lineHeight: 1, opacity: 0.45, letterSpacing: '-0.5px' }}
        >
          {'…'}
        </Box>
      )}
    </Box>
  );
}
