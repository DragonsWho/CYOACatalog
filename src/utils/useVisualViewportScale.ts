import { useState, useEffect } from 'react';

// Visual-viewport pinch-zoom scale (1 when not zoomed / API missing). Used to hide page-level fixed
// controls (calculator, image view-mode buttons) while zoomed: position:fixed anchors to the layout
// viewport and otherwise balloons/drifts over content.
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
