import { useEffect, useRef, useState, type ReactNode } from 'react';

// Mounts children once the placeholder comes within `margin` of the viewport (or right away when
// `eager`), never before window load. For below-the-fold blocks whose mount fires requests (comments, similar games) — they
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

  // Not before the page's own load event: a wide margin must not pull these into the first load.
  const [loaded, setLoaded] = useState(() => document.readyState === 'complete');
  useEffect(() => {
    if (loaded) return;
    const on = () => setLoaded(true);
    window.addEventListener('load', on, { once: true });
    return () => window.removeEventListener('load', on);
  }, [loaded]);

  useEffect(() => {
    if (shown) return;
    if (eager || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el || !loaded) return;
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
  }, [shown, eager, margin, loaded]);

  if (shown) return <>{children}</>;
  return <div ref={ref} style={{ minHeight }} />;
}
