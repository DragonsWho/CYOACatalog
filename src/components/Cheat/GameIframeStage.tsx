// Reusable "play an iframe game, one Fullscreen button" stage. TEST-ONLY: used solely by
// /cheat-lab; a copy kept apart from the production player (CyoaPage/GameContent.tsx) to iterate on
// fullscreen UX safely.
// - Baseline is a CSS "immersive" overlay: fixed 100dvh/100vw layer hiding site chrome so the game
// measures a real viewport. dvh (not vh) keeps the mobile URL bar from clipping the bottom.
// - Native Fullscreen API where it works (desktop, Android, iPad). Skipped on iPhone: element
// fullscreen is unreliable there (only <video>), the CSS overlay is the real thing.
// - After toggling we "nudge" the iframe size for a frame so the embedded engine fires its own
// resize and repaints its background immediately (else it keeps the old size until scroll).

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

// Only real iPhones/iPods get the CSS-overlay-only path. iPad (as "iPad" or, in desktop mode, as a
// Mac) handles native FS fine.
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [isImmersive, setIsImmersive] = useState(false);
  // Changed on retry to force a full <iframe> remount — reassigning the same src isn't treated as a
  // new load.
  const [reloadToken, setReloadToken] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef(0);
  const usedNativeRef = useRef(false);
  // Track pending nudgeIframe timers from enter/exitImmersive: otherwise five enterImmersive timers
  // kept firing after leaving fullscreen within a second — visible as a 1px jerk in normal layout.
  const nudgeTimersRef = useRef<number[]>([]);

  // Parent side of the cheat gate: answers the shim's "am I unlocked?" and posts builds (see
  // useCheatBridge). No gameId here — resolved from the loaded URL. Harmless for the generic stage:
  // reacts only to the shim's own postMessages.
  useCheatBridge(iframeRef, { src });

  // Safety net: if a mobile webview never fires `load` on a cross-origin iframe, the Fullscreen
  // button would stay hidden forever. Reveal after a grace period; reset on src change.
  useEffect(() => {
    setIsLoading(true);
    setLoadFailed(false);
    const t = window.setTimeout(() => setIsLoading(false), 8000);
    return () => window.clearTimeout(t);
  }, [src, reloadToken]);

  // Force re-measure/repaint by shrinking the iframe 1px, restoring next frame.
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

  const clearNudgeTimers = (): void => {
    nudgeTimersRef.current.forEach((id) => window.clearTimeout(id));
    nudgeTimersRef.current = [];
  };

  const scheduleNudges = (delays: number[]): void => {
    delays.forEach((t) => nudgeTimersRef.current.push(window.setTimeout(nudgeIframe, t)));
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
    clearNudgeTimers();
    scrollRef.current = window.scrollY;
    setIsImmersive(true);
    document.body.style.overflow = 'hidden';
    showSiteChrome(false);

    const el = containerRef.current as FullscreenElement | null;
    usedNativeRef.current = false;
    if (el && !isIphone() && nativeFsSupported(el)) {
      try {
        await requestNativeFs(el);
        usedNativeRef.current = true;
      } catch {
      }
    }

    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      nudgeIframe();
    });
    // The mobile URL bar collapses over a few hundred ms after going immersive, growing dvh; the
    // engine only repaints its background on resize, so nudge repeatedly across that window (else a
    // ~10px black strip lingers until scroll).
    scheduleNudges([90, 220, 400, 650, 1000]);
  };

  const exitImmersive = async (): Promise<void> => {
    clearNudgeTimers();
    if (usedNativeRef.current && nativeFsElement()) {
      try {
        await exitNativeFs();
      } catch {
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
    scheduleNudges([90, 300, 600]);
  };

  const toggle = (): void => {
    if (isImmersive) void exitImmersive();
    else void enterImmersive();
  };

  // Leaving native fullscreen via system gesture/Esc while immersive → drop the CSS overlay too,
  // keep them in sync.
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

  // Esc exits immersive (covers the CSS-only path with no native FS).
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

  // Any stage box size change (orientation, URL bar, immersive toggle) → re-nudge so the engine
  // repaints now rather than on scroll.
  useEffect(() => {
    const c = containerRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return;
    // On mobile the URL bar show/hide sends 20–50 resize events in a fraction of a second; each
    // called nudgeIframe (two sync style writes + engine re-measure) — coalesced to one nudge per
    // frame via rAF.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(nudgeIframe);
    });
    ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore site chrome if unmounted while immersive.
  useEffect(() => {
    return () => {
      clearNudgeTimers();
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

      {!isLoading && loadFailed && (
        // onError used to just hide the spinner, leaving a black box with no text — on flaky mobile
        // connections users couldn't tell failed from loading.
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: '#121212',
            color: 'white',
            zIndex: 5,
            textAlign: 'center',
            p: 2,
          }}
        >
          <Box component="span">Game failed to load.</Box>
          <Button
            variant="outlined"
            size="small"
            onClick={() => {
              setLoadFailed(false);
              setIsLoading(true);
              setReloadToken((t) => t + 1);
            }}
          >
            Retry
          </Button>
        </Box>
      )}

      <iframe
        key={reloadToken}
        ref={iframeRef}
        src={src}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
        title={title}
        allow="fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        aria-label={title}
        onLoad={() => { setIsLoading(false); setLoadFailed(false); window.setTimeout(nudgeIframe, 60); }}
        onError={() => { setIsLoading(false); setLoadFailed(true); }}
      />

      {!isLoading && !loadFailed && (
        <Button
          onClick={toggle}
          sx={{
            // Same bottom-right spot entering or exiting fullscreen (absolute child in the stage
            // normally, in the fixed full-viewport container while immersive). Overlapping the
            // game's corner control is acceptable now that the cheat menu can open the game's own
            // save menu.
            position: 'absolute',
            // Match the in-iframe cheat FAB, which can't read the parent's safe-area insets (0
            // inside the frame). With safe-area here the button drifted up by the inset until a
            // resize settled it; a raw 10px keeps both on the same line.
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
