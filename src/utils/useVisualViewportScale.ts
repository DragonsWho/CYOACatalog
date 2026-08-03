import { useState, useEffect } from 'react';

// Tracks the visual-viewport pinch-zoom scale. Returns 1 when not zoomed or when
// the API is unavailable. Used to hide page-level fixed controls (calculator,
// image view-mode buttons) while the user is pinch-zoomed into content, since
// position:fixed elements are anchored to the layout viewport and otherwise
// balloon/drift over the content during zoom.
export function useVisualViewportScale(): number {
  const [scale, setScale] = useState<number>(() =>
    typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.scale : 1
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setScale(vv.scale);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return scale;
}
