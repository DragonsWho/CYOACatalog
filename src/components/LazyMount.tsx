import { useEffect, useRef, useState, type ReactNode } from 'react';

// Mounts children once the placeholder comes within `margin` of the viewport (or right away when
// `eager`). For below-the-fold blocks whose mount fires requests (comments, similar games) — they
// no longer compete with the game itself on load. Crawlers that render with a tall viewport
// (Googlebot) still trigger the observer.
export default function LazyMount({
  children,
  eager = false,
  margin = '300px',
  minHeight = 0,
}: {
  children: ReactNode;
  eager?: boolean;
  margin?: string;
  minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(eager);

  useEffect(() => {
    if (shown) return;
    if (eager || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, eager, margin]);

  if (shown) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} />;
}
