// Reusable "play an iframe game, one clean Fullscreen button" stage.
//
// TEST-ONLY component: used solely by the hidden /cheat-lab page. It is a copy
// that lives apart from the production catalog player (CyoaPage/GameContent.tsx),
// so we can iterate on the fullscreen UX here without any risk to prod.
//
// Design: a single toggle button (Fullscreen / Exit).
//   • Baseline is a CSS "immersive" overlay: a fixed, 100dvh/100vw layer that
//     hides the site chrome and lets the embedded game measure a real viewport.
//     Using dvh (not vh) means the mobile URL bar no longer clips the bottom, so
//     the game's footer AND the exit button stay visible and reachable.
//   • As a bonus we also request the native Fullscreen API where it actually
//     works (desktop, Android, iPad). We skip it on iPhone, where element-level
//     fullscreen has long been unreliable (only <video> is fully supported, and
//     that has not meaningfully changed through iOS 17/18) — there the CSS
//     overlay is the real thing and behaves consistently.
//   • After toggling we "nudge" the iframe size for a frame, which forces the
//     embedded engine to fire its own resize and repaint its background at the
//     new size immediately (otherwise it keeps the old size until you scroll).
import { useState, useRef, useEffect } from 'react';
import { Box, Button, CircularProgress } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { useCheatBridge } from './useCheatBridge';

interface FullscreenDocument extends Document {
  fullscreenElement: Element | null;
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  fullscreenEnabled: boolean;
  webkitFullscreenEnabled?: boolean;
  mozFullScreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;
  exitFullscreen(): Promise<void>;
  webkitExitFullscreen?(): Promise<void>;
  mozCancelFullScreen?(): Promise<void>;
  msExitFullscreen?(): Promise<void>;
}

interface FullscreenElement extends HTMLElement {
  requestFullscreen(): Promise<void>;
  webkitRequestFullscreen?(): Promise<void>;
  mozRequestFullScreen?(): Promise<void>;
  msRequestFullscreen?(): Promise<void>;
}

interface Props {
  src: string;
  title?: string;
}

// Only real iPhones/iPods get the CSS-overlay-only path. iPad (whether it
// reports as "iPad" or, in desktop mode, as a Mac) handles native FS fine.
const isIphone = (): boolean => /iPhone|iPod/.test(navigator.userAgent);

function nativeFsElement(): Element | null {
  const d = document as FullscreenDocument;
  return (
    d.fullscreenElement ||
    d.webkitFullscreenElement ||
    d.mozFullScreenElement ||
    d.msFullscreenElement ||
    null
  );
}

function nativeFsSupported(el: HTMLElement | null): boolean {
  const d = document as FullscreenDocument;
  const apiOk = !!(
    d.fullscreenEnabled ||
    d.webkitFullscreenEnabled ||
    d.mozFullScreenEnabled ||
    d.msFullscreenEnabled
  );
  const elemOk =
    !!el &&
    ('requestFullscreen' in el ||
      'webkitRequestFullscreen' in el ||
      'mozRequestFullScreen' in el ||
      'msRequestFullscreen' in el);
  return apiOk && elemOk;
}

async function requestNativeFs(el: FullscreenElement): Promise<void> {
  if (el.requestFullscreen) return el.requestFullscreen();
  if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
  if (el.msRequestFullscreen) return el.msRequestFullscreen();
  throw new Error('No fullscreen method available');
}

async function exitNativeFs(): Promise<void> {
  const d = document as FullscreenDocument;
  if (d.exitFullscreen) return d.exitFullscreen();
  if (d.webkitExitFullscreen) return d.webkitExitFullscreen();
  if (d.mozCancelFullScreen) return d.mozCancelFullScreen();
  if (d.msExitFullscreen) return d.msExitFullscreen();
}

export default function GameIframeStage({ src, title = 'Interactive CYOA' }: Props): JSX.Element {
  const [isLoading, setIsLoading] = useState(true);
  const [isImmersive, setIsImmersive] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(0);
  const usedNativeRef = useRef(false);

  // Parent side of the cheat gate: answers the shim's "am I unlocked?" query and
  // posts builds (as comments) — see useCheatBridge. No gameId here, so it
  // resolves the game from the loaded URL. Harmless for the generic stage: it
  // only reacts to the cheat shim's own postMessages.
  useCheatBridge(iframeRef, { src });

  // Safety net: cross-origin iframes normally fire `load`, but if some mobile
  // webview never does, we'd hide the Fullscreen button forever. Reveal it
  // anyway after a short grace period. Reset whenever the src changes.
  useEffect(() => {
    setIsLoading(true);
    const t = window.setTimeout(() => setIsLoading(false), 8000);
    return () => window.clearTimeout(t);
  }, [src]);

  // Force the embedded engine to re-measure and repaint at the current size by
  // briefly shrinking the iframe by 1px, then restoring it next frame.
  const nudgeIframe = (): void => {
    const f = iframeRef.current;
    if (!f) return;
    f.style.height = 'calc(100% - 1px)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (iframeRef.current) iframeRef.current.style.height = '100%';
      });
    });
  };

  const showSiteChrome = (show: boolean): void => {
    const disp = show ? '' : 'none';
    document.querySelectorAll('header, footer').forEach((n) => {
      (n as HTMLElement).style.display = disp;
    });
    const main = document.querySelector('main') as HTMLElement | null;
    if (main) {
      main.style.height = show ? '' : '100dvh';
      main.style.maxWidth = show ? '' : '100vw';
      main.style.padding = show ? '' : '0';
      main.style.margin = show ? '' : '0';
    }
    document.querySelectorAll('body > *:not(#root)').forEach((n) => {
      (n as HTMLElement).style.display = disp;
    });
  };

  const enterImmersive = async (): Promise<void> => {
    scrollRef.current = window.scrollY;
    setIsImmersive(true);
    document.body.style.overflow = 'hidden';
    showSiteChrome(false);

    // Bonus: true chrome-less fullscreen where it is dependable. On iPhone we
    // deliberately stay on the CSS overlay only.
    const el = containerRef.current as FullscreenElement | null;
    usedNativeRef.current = false;
    if (el && !isIphone() && nativeFsSupported(el)) {
      try {
        await requestNativeFs(el);
        usedNativeRef.current = true;
      } catch {
        /* keep CSS overlay */
      }
    }

    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      nudgeIframe();
    });
    // The mobile URL bar collapses over a few hundred ms after we go immersive,
    // growing dvh; the embedded engine only repaints its background on resize,
    // so nudge repeatedly across that settle window (otherwise a ~10px black
    // strip lingers between the background and the point bar until you scroll).
    [90, 220, 400, 650, 1000].forEach((t) => window.setTimeout(nudgeIframe, t));
  };

  const exitImmersive = async (): Promise<void> => {
    if (usedNativeRef.current && nativeFsElement()) {
      try {
        await exitNativeFs();
      } catch {
        /* fall through to CSS restore */
      }
    }
    usedNativeRef.current = false;
    setIsImmersive(false);
    document.body.style.overflow = '';
    showSiteChrome(true);
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollRef.current);
      nudgeIframe();
    });
    [90, 300, 600].forEach((t) => window.setTimeout(nudgeIframe, t));
  };

  const toggle = (): void => {
    if (isImmersive) void exitImmersive();
    else void enterImmersive();
  };

  // If the user leaves native fullscreen via a system gesture / Esc while we are
  // immersive, drop the CSS overlay too so the two stay in sync.
  useEffect(() => {
    const onFsChange = (): void => {
      if (usedNativeRef.current && !nativeFsElement() && isImmersive) {
        void exitImmersive();
      }
    };
    const events = [
      'fullscreenchange',
      'webkitfullscreenchange',
      'mozfullscreenchange',
      'MSFullscreenChange',
    ];
    events.forEach((e) => document.addEventListener(e, onFsChange));
    return () => events.forEach((e) => document.removeEventListener(e, onFsChange));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImmersive]);

  // Esc exits immersive (covers the CSS-only path where no native FS is active).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && isImmersive) {
        e.preventDefault();
        void exitImmersive();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImmersive]);

  // Keep the immersive overlay pinned to the live viewport height on resize /
  // URL-bar show-hide, and repaint the game to match.
  useEffect(() => {
    if (!isImmersive) return;
    const onResize = (): void => nudgeIframe();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [isImmersive]);

  // Any time the stage box itself changes size — orientation, the mobile URL
  // bar showing/hiding, entering/leaving immersive — re-nudge so the engine
  // repaints its background at the new size instead of waiting for a scroll.
  useEffect(() => {
    const c = containerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => nudgeIframe());
    ro.observe(c);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore the site chrome if this component unmounts while immersive.
  useEffect(() => {
    return () => {
      document.body.style.overflow = '';
      showSiteChrome(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box
      ref={containerRef}
      sx={{
        position: isImmersive ? 'fixed' : 'relative',
        ...(isImmersive
          ? { inset: 0, width: '100vw', height: '100dvh', zIndex: 13000 }
          : { width: '100%', height: '100%', minHeight: '300px' }),
        backgroundColor: '#000',
        overflow: 'hidden',
      }}
    >
      {isLoading && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: '#121212',
            zIndex: 5,
          }}
        >
          <CircularProgress />
        </Box>
      )}

      <iframe
        ref={iframeRef}
        src={src}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        title={title}
        allow="fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        aria-label={title}
        onLoad={() => { setIsLoading(false); window.setTimeout(nudgeIframe, 60); }}
        onError={() => setIsLoading(false)}
      />

      {!isLoading && (
        <Button
          onClick={toggle}
          sx={{
            // Same spot (bottom-right) whether entering or exiting fullscreen.
            // The absolute child sits in the stage box normally, and in the
            // fixed full-viewport container while immersive — bottom-right both
            // times. Overlapping the game's corner control is acceptable now
            // that the cheat menu can open the game's own save menu.
            position: 'absolute',
            // Match the in-iframe cheat FAB, which cannot read the parent's
            // safe-area insets (they resolve to 0 inside the game frame). With
            // safe-area here the button drifted up by the inset on load until a
            // resize "settled" it; a raw 10px keeps both on the same bottom line.
            bottom: '10px',
            right: '10px',
            zIndex: 13001,
            backgroundColor: '#e8484e',
            color: 'white',
            minWidth: 40,
            width: 40,
            height: 40,
            p: 0,
            boxShadow: '0 2px 10px rgba(0,0,0,.5)',
            '& svg': { fontSize: 28 },
            '&:hover': { backgroundColor: '#d73b41' },
          }}
          title={isImmersive ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isImmersive ? <FullscreenExitIcon /> : <FullscreenIcon />}
        </Button>
      )}
    </Box>
  );
}
