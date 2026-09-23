import { useState, useRef, useEffect } from 'react';
import type { UIEvent } from 'react';
import { Box, Button, CircularProgress, ButtonGroup, Tooltip } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import { Game } from '../../pocketbase/pocketbase';
import { useVisualViewportScale } from '../../utils/useVisualViewportScale';
import { withSaveFlag, isHostedGameUrl } from '../../utils/cheat';
import { useCheatBridge } from '../Cheat/useCheatBridge';
import { useGamePlaytime } from '../../utils/useGamePlaytime';

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

enum ImageViewMode {
  FIT_CONTAINER = 'fit-container',
  FIT_SCREEN = 'fit-screen',
  ORIGINAL_SIZE = 'original-size',
}

// Windowed rendering for image (static) games. The page used to eagerly fetch ALL cyoa_pages (new
// Image() each) — for giant games with hundreds of pages that burned traffic, filled RAM with huge
// decoded canvases and hung phones. Now: first INITIAL_BATCH pages; on scroll further batches of
// LOAD_STEP load automatically up to AUTO_CAP, then only via "Load more" (brake for giant games);
// <img> with loading="lazy" + content-visibility:auto.
// ⚠️ Every not-yet-loaded page MUST reserve real height (RESERVE_VH). Otherwise unloaded <img>
// collapse to 0px, the column becomes ~zero, the bottom sentinel is instantly in view and
// IntersectionObserver cascades the window up to AUTO_CAP before any image lays out — the browser
// eagerly pulls the whole auto range (hundreds of MB). The reserve keeps the sentinel below the
// fold.
const INITIAL_BATCH = 4;
const LOAD_STEP = 6;
const AUTO_CAP = 28;  // 4 → 10 → 16 → 22 → 28 automatically, then button only
const RESERVE_VH = 90;  // placeholder height for an unloaded page (CYOA pages are tall)

// Viewport width without the vertical scrollbar (--scrollbar-width set from JS, see effect below) —
// for breaking the canvas out of the page Containers to full width.
const FULL_BLEED_WIDTH = 'calc(100vw - var(--scrollbar-width, 0px))';

interface GameContentProps {
  game: Game;
  // When true, the already-loaded saver shim switches to the full cheat menu over postMessage (no
  // iframe reload — selections survive). Off = saver mode.
  cheatsActive?: boolean;
  // Fired once the shim announces itself, i.e. the engine supports cheats (distinguishes
  // "supported" from a dead click).
  onCheatReady?: () => void;
  // A build string to reproduce in the game (from "Load"); onLoadSent fires once the bridge handed
  // it to the shim so the parent can clear it.
  loadCode?: string | null;
  onLoadSent?: () => void;
}

export default function GameContent({ game, cheatsActive = false, onCheatReady, loadCode, onLoadSent }: GameContentProps): JSX.Element {
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});
  // Which pages actually loaded. Until then reserve RESERVE_VH (see above: prevents the
  // IntersectionObserver cascade).
  const [loadedPages, setLoadedPages] = useState<Record<number, boolean>>({});
  const [visibleCount, setVisibleCount] = useState<number>(INITIAL_BATCH);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [isIframeLoading, setIsIframeLoading] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  // The shim swapped in its own point bar with expand/fullscreen buttons; ours sit over the same
  // corner from outside the frame and would eat the clicks — stand down while it's up.
  const [customBarActive, setCustomBarActive] = useState<boolean>(false);
  const [isImmersiveMode, setIsImmersiveMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ImageViewMode>(ImageViewMode.FIT_CONTAINER);

  // Hide floating mode buttons while pinch-zooming (fixed elements balloon/shift over content).
  const vvScale = useVisualViewportScale();
  const isZoomed = vvScale > 1.05;

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const isImageGame = game.img_or_link === 'img';
  // In "1:1" and "fit screen width" the canvas takes the whole viewport: break out of page
  // Containers. Default mode untouched.
  const isFullBleed = isImageGame && viewMode !== ImageViewMode.FIT_CONTAINER;

  // ORIGINAL_SIZE: each page is its own horizontal scroller (otherwise content-visibility: auto
  // clips the canvas at box edges, see below). Static CYOA pages are nearly always equal width, so
  // scroll position is shared: scroll right on one, the rest follow.
  const hScrollRef = useRef<number>(0);
  const pageScrollersRef = useRef<Map<number, HTMLDivElement>>(new Map());

  const registerPageScroller = (index: number, node: HTMLDivElement | null): void => {
    if (node) {
      pageScrollersRef.current.set(index, node);
      node.scrollLeft = hScrollRef.current;
    } else {
      pageScrollersRef.current.delete(index);
    }
  };

  const syncPageScroll = (source: HTMLDivElement): void => {
    const left = source.scrollLeft;
    // We move the others ourselves — their scroll events come back with the already-written value
    // and are cut here (otherwise a loop).
    if (left === hScrollRef.current) return;
    hScrollRef.current = left;
    pageScrollersRef.current.forEach((node) => {
      if (node !== source && node.scrollLeft !== left) node.scrollLeft = left;
    });
  };

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Interactive iframe URL. Our own hosted games always load with ?__save=1 so the Go backend
  // injects the companion shim in saver mode; the flagged URL is a separate edge-cache entry with
  // normal cache headers, and direct visits to the game subdomain (no flag) stay byte-for-byte
  // untouched. External games get no flag. The URL never changes with the cheat toggle — mode
  // switches ride postMessage, so the game never reloads.
  const isInteractiveGame = game.img_or_link === 'link' && !!game.iframe_url;
  const isHosted = isInteractiveGame && isHostedGameUrl(game.iframe_url);
  const iframeSrc = isHosted ? withSaveFlag(game.iframe_url) : game.iframe_url;
  // Parent side of the shim bridge (builds, cheat-unlock check, save/cheat mode). Active for every
  // hosted game; inert for external iframes.
  useCheatBridge(iframeRef, {
    src: iframeSrc,
    gameId: game.id,
    enabled: isHosted,
    mode: cheatsActive ? 'cheat' : 'save',
    onReady: onCheatReady,
    loadCode,
    onLoadSent,
    // Only reached where the iframe can't go fullscreen (iPhone Safari). Immersive mode is a CSS
    // layout change, so unlike a real fullscreen request it needs no user activation and survives
    // the postMessage hop. Arrow wrapper because toggleImmersiveMode is declared further down.
    onFullscreenRequest: () => toggleImmersiveMode(),
    // "Expand to page" is ours to perform: it hides site chrome around the frame, which the shim
    // can't reach.
    onExpandRequest: () => toggleImmersiveMode(),
    onBarTakeover: setCustomBarActive,
    viewState: { immersive: isImmersiveMode, fullscreen: isFullscreen },
  });

  // Real playtime for interactive games: GA's engagement timer can't see clicks inside the iframe,
  // so we measure "tab visible + focused" ourselves and report game_play / game_heartbeat. Off for
  // image games (GA measures them).
  useGamePlaytime(game.id, isInteractiveGame, isHosted);

  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const initialIframeStyles = useRef<{ height: string; width: string } | null>(null);
  // Read inside handlers/timeouts that must not close over stale state.
  const isImmersiveModeRef = useRef<boolean>(false);
  isImmersiveModeRef.current = isImmersiveMode;
  // Inline `display` values we overwrote when hiding chrome, so restore puts back exactly what was
  // there (portals may be legitimately hidden).
  const hiddenChromeRef = useRef<{ el: HTMLElement; prev: string }[]>([]);

  const isIOS = (): boolean => {
    return (
      ['iPad Simulator', 'iPhone Simulator', 'iPod Simulator', 'iPad', 'iPhone', 'iPod'].includes(
        navigator.platform
      ) || (navigator.userAgent.includes('Mac') && 'ontouchend' in document)
    );
  };

  const isAndroidWebView = (): boolean => {
    return (
      /Android/.test(navigator.userAgent) &&
      (/wv/.test(navigator.userAgent) || /Version\/[0-9.]+/.test(navigator.userAgent))
    );
  };

  useEffect(() => {
    setVisibleCount(INITIAL_BATCH);
    setImageErrors({});
    setLoadedPages({});
    hScrollRef.current = 0;
  }, [game.id]);

  // Auto-load on scroll only up to AUTO_CAP (observe the bottom sentinel); beyond that only the
  // button (hard brake for giant games).
  useEffect(() => {
    const total = game.cyoa_pages?.length ?? 0;
    if (game.img_or_link !== 'img') return;
    if (visibleCount >= total) return;
    if (visibleCount >= AUTO_CAP) return;

    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount(c => Math.min(c + LOAD_STEP, AUTO_CAP, total));
        }
      },
      { rootMargin: '400px' }  // prefetch before it enters the viewport
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleCount, game.cyoa_pages, game.img_or_link]);

  const resetIframeStyles = (): void => {
    const iframeContainer = iframeContainerRef.current;
    if (iframeContainer) {
      iframeContainer.style.height = initialIframeStyles.current?.height || '500px';
      iframeContainer.style.width = initialIframeStyles.current?.width || '100%';
      iframeContainer.style.position = 'relative';
      iframeContainer.style.paddingBottom = '0';
    }
  };

  useEffect(() => {
    const iframeContainer = iframeContainerRef.current;
    if (iframeContainer && !initialIframeStyles.current) {
      initialIframeStyles.current = {
        height: iframeContainer.style.height || '500px',
        width: iframeContainer.style.width || '100%',
      };
    }
  }, []);

  useEffect(() => {
    const updateIframeHeight = (): void => {
      const iframeContainer = iframeContainerRef.current;
      if (iframeContainer && isImmersiveMode) {
        // dvh tracks the live viewport as the iOS URL bar collapses, so the game bottom doesn't
        // hide under the toolbar.
        iframeContainer.style.height = '100dvh';
      }
    };

    if (isImmersiveMode) {
      updateIframeHeight();
      window.addEventListener('resize', updateIframeHeight);
      window.visualViewport?.addEventListener('resize', updateIframeHeight);
    } else {
      resetIframeStyles();
    }

    return () => {
      window.removeEventListener('resize', updateIframeHeight);
      window.visualViewport?.removeEventListener('resize', updateIframeHeight);
    };
  }, [isImmersiveMode]);

  // Immersive mode hides site chrome with inline styles, and that MUST stay declarative: exits
  // happen through paths that never call toggleImmersiveMode() (native fullscreen exit, orientation
  // change, navigating away); an imperative restore in the toggle alone left the header stuck at
  // display:none with isImmersiveMode already false (even Esc couldn't bring it back).
  useEffect(() => {
    if (!isImmersiveMode) return;

    const hide = (el: HTMLElement | null): void => {
      if (!el) return;
      hiddenChromeRef.current.push({ el, prev: el.style.display });
      el.style.display = 'none';
    };

    hide(document.querySelector('header'));
    hide(document.querySelector('footer'));
    document
      .querySelectorAll('body > *:not(#root)')
      .forEach((el) => hide(el as HTMLElement));

    const main = document.querySelector('main') as HTMLElement | null;
    if (main) {
      main.style.padding = '0';
      main.style.margin = '0';
      main.style.height = '100dvh';
      main.style.width = '100vw';
      main.style.maxWidth = '100vw';
    }

    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    return () => {
      hiddenChromeRef.current.forEach(({ el, prev }) => {
        el.style.display = prev;
      });
      hiddenChromeRef.current = [];
      if (main) {
        main.style.padding = '';
        main.style.margin = '';
        main.style.height = '';
        main.style.width = '';
        main.style.maxWidth = '';
      }
      resetIframeStyles();
      const y = scrollPositionRef.current;
      requestAnimationFrame(() => window.scrollTo(0, y));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImmersiveMode]);

  // Parent scrollbar lock, separate from the immersive effect because it must also apply to native
  // Fullscreen (isFullscreen), which doesn't hide chrome — only the viewport resizes. Without it
  // the catalog page's scrollbar can sit right of the game and half-bury its own (see cheat_shim.js
  // styleHostScrollbar).
  useEffect(() => {
    const shouldLockParentScroll = isImmersiveMode || isFullscreen;
    if (!shouldLockParentScroll) return;

    const html = document.documentElement;
    const body = document.body;

    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = body.style.overflow;
    const prevHtmlScrollbarGutter = html.style.scrollbarGutter;
    const prevBodyScrollbarGutter = body.style.scrollbarGutter;

    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    // In case global styles set scrollbar-gutter: stable — don't leave an empty gutter.
    html.style.scrollbarGutter = 'auto';
    body.style.scrollbarGutter = 'auto';

    return () => {
      html.style.overflow = prevHtmlOverflow;
      body.style.overflow = prevBodyOverflow;
      html.style.scrollbarGutter = prevHtmlScrollbarGutter;
      body.style.scrollbarGutter = prevBodyScrollbarGutter;
    };
  }, [isImmersiveMode, isFullscreen]);

  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const doc = document as FullscreenDocument;
      const isInFullscreen = !!(
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );
      setIsFullscreen(isInFullscreen);

      if (!isInFullscreen) {
        setIsImmersiveMode(false);
        resetIframeStyles();
      }
    };

    const handleOrientationChange = (): void => {
      if (isFullscreen) {
        const doc = document as FullscreenDocument;
        const isStillFullscreen = !!(
          doc.fullscreenElement ||
          doc.webkitFullscreenElement ||
          doc.mozFullScreenElement ||
          doc.msFullscreenElement
        );

        if (!isStillFullscreen) {
          setIsFullscreen(false);
          setIsImmersiveMode(false);
          resetIframeStyles();
        }
      }
    };

    const events: readonly [string, () => void][] = [
      ['fullscreenchange', handleFullscreenChange],
      ['webkitfullscreenchange', handleFullscreenChange],
      ['mozfullscreenchange', handleFullscreenChange],
      ['MSFullscreenChange', handleFullscreenChange],
      ['orientationchange', handleOrientationChange],
    ];

    events.forEach(([event, handler]) => {
      if (event === 'orientationchange') {
        window.addEventListener(event, handler);
      } else {
        document.addEventListener(event, handler);
      }
    });

    return () => {
      events.forEach(([event, handler]) => {
        if (event === 'orientationchange') {
          window.removeEventListener(event, handler);
        } else {
          document.removeEventListener(event, handler);
        }
      });
    };
  }, [isFullscreen]);

  useEffect(() => {
    const handleEscapeKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isImmersiveMode) {
        toggleImmersiveMode();
        event.preventDefault();
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [isImmersiveMode]);

  // Document scrollbar width into a CSS variable: 100vw INCLUDES the scrollbar, so "full width"
  // without this overflows and causes page-wide horizontal scroll. 0 on mobile/Safari overlay
  // scrollbars.
  useEffect(() => {
    const measure = (): void => {
      const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      document.documentElement.style.setProperty('--scrollbar-width', `${sbw}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    // The scrollbar appears/disappears without resize (pages load, document grows) — recompute on
    // document height change.
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    return () => {
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, []);

  const isFullscreenSupported = (elem: HTMLElement | null): boolean => {
    const doc = document as FullscreenDocument;
    const isApiSupported = !!(
      doc.fullscreenEnabled ||
      doc.webkitFullscreenEnabled ||
      doc.mozFullScreenEnabled ||
      doc.msFullscreenEnabled
    );
    const isElementValid = !!elem && (
      'requestFullscreen' in elem ||
      'webkitRequestFullscreen' in elem ||
      'mozRequestFullScreen' in elem ||
      'msRequestFullscreen' in elem
    );
    return isApiSupported && isElementValid;
  };

  const toggleFullscreen = async (): Promise<void> => {
    try {
      const targetElement = iframeContainerRef.current ?? iframeRef.current;
      if (!targetElement) {
        throw new Error('No valid target element for fullscreen');
      }

      const doc = document as FullscreenDocument;
      const isCurrentlyFullscreen = !!(
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );

      if (!isCurrentlyFullscreen) {
        if (!isFullscreenSupported(targetElement)) {
          throw new Error('Fullscreen API not supported');
        }

        const elemWithFullscreen = targetElement as unknown as {
          requestFullscreen(): Promise<void>;
          webkitRequestFullscreen?(): Promise<void>;
          mozRequestFullScreen?(): Promise<void>;
          msRequestFullscreen?(): Promise<void>;
        };

        if (isIOS() && elemWithFullscreen.webkitRequestFullscreen) {
          await elemWithFullscreen.webkitRequestFullscreen();
        } else if (isAndroidWebView()) {
          toggleImmersiveMode();
          return;
        } else if ('requestFullscreen' in targetElement) {
          await elemWithFullscreen.requestFullscreen();
        } else if (elemWithFullscreen.mozRequestFullScreen) {
          await elemWithFullscreen.mozRequestFullScreen();
        } else if (elemWithFullscreen.webkitRequestFullscreen) {
          await elemWithFullscreen.webkitRequestFullscreen();
        } else if (elemWithFullscreen.msRequestFullscreen) {
          await elemWithFullscreen.msRequestFullscreen();
        } else {
          throw new Error('No fullscreen method available');
        }

        setTimeout(() => {
          const docCheck = document as FullscreenDocument;
          if (
            !(
              docCheck.fullscreenElement ||
              docCheck.webkitFullscreenElement ||
              docCheck.mozFullScreenElement ||
              docCheck.msFullscreenElement
            )
          ) {
            console.error('Fullscreen activation check failed after timeout');
            toggleImmersiveMode();
          }
        }, 300);
      } else {
        if (doc.exitFullscreen) {
          await doc.exitFullscreen();
        } else if (doc.mozCancelFullScreen) {
          await doc.mozCancelFullScreen();
        } else if (doc.webkitExitFullscreen) {
          await doc.webkitExitFullscreen();
        } else if (doc.msExitFullscreen) {
          await doc.msExitFullscreen();
        } else {
          throw new Error('No exit fullscreen method available');
        }

        resetIframeStyles();
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Fullscreen toggle error:', errorMessage);
      toggleImmersiveMode();
    }
  };


  const toggleImmersiveMode = (): void => {
    if (!isImmersiveModeRef.current) {
      scrollPositionRef.current = window.scrollY;
    }
    setIsImmersiveMode((prev) => !prev);
  };

  const changeViewMode = (mode: ImageViewMode): void => {
    setViewMode((prev) =>
      mode === prev && mode !== ImageViewMode.FIT_CONTAINER ? ImageViewMode.FIT_CONTAINER : mode
    );
  };

  const handleIframeError = (): void => {
    setIsIframeLoading(false);
  };

  return (
    <Box
      ref={contentContainerRef}
      sx={{
        backgroundColor: '#121212',
        position: 'relative',
        width: '100%',
        height: isImmersiveMode ? '100dvh' : 'auto',
        // FIT_CONTAINER lives inside the page column; other modes break out of the centering
        // containers to full viewport width (isFullBleed).
        overflow: 'hidden',
        ...(isFullBleed && {
          width: FULL_BLEED_WIDTH,
          maxWidth: 'none',
          marginLeft: `calc(50% - ${FULL_BLEED_WIDTH} / 2)`,
        }),
        ...(isImmersiveMode && {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 9999,
          width: '100vw',
          backgroundColor: '#000',
          padding: 0,
          margin: 0,
          overflow: 'hidden',
        }),
      }}
    >
      {game.img_or_link === 'img' && (game.cyoa_pages?.length ?? 0) > 0 ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            transition: 'all 0.3s ease',
            width: '100%',
            position: 'relative',
          }}
        >
          {game.cyoa_pages.slice(0, visibleCount).map((pageName, index) => {
            const previewName = game.cyoa_pages_preview?.[index];
            const previewUrl = previewName
              ? `/api/files/${collectionId}/${game.id}/${previewName}`
              : undefined;
            const fullUrl = `/api/files/${collectionId}/${game.id}/${pageName}`;
            return (
              <Box
                key={index}
                ref={
                  viewMode === ImageViewMode.ORIGINAL_SIZE
                    ? (node: HTMLDivElement | null) => registerPageScroller(index, node)
                    : undefined
                }
                onScroll={
                  viewMode === ImageViewMode.ORIGINAL_SIZE
                    ? (e: UIEvent<HTMLDivElement>) => syncPageScroll(e.currentTarget)
                    : undefined
                }
                sx={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: '#121212',
                  position: 'relative',
                  // content-visibility frees RAM: offscreen canvases aren't rendered/decoded; giant
                  // pages don't accumulate.
                  contentVisibility: 'auto',
                  containIntrinsicSize: 'auto 1200px',
                  // Height reserve until loaded (see RESERVE_VH); removed on onLoad so the box
                  // takes the real height.
                  ...(!loadedPages[index] && { minHeight: `${RESERVE_VH}vh` }),
                  // Cheap blurred preview as background ONLY while the full image loads; removed on
                  // onLoad, else for images narrower than the column the stretched cover preview
                  // sticks out at the sides ("duplicated/stretched"). Narrow images should just sit
                  // centered on dark #121212.
                  ...(previewUrl && !loadedPages[index] && {
                    backgroundImage: `url("${previewUrl}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }),
                  // ⚠️ contentVisibility: auto also enables paint containment — anything wider than
                  // this box is CLIPPED at its edges, and overflow: visible doesn't undo it. So
                  // modes don't grow the image inside the box (only its middle would show) but grow
                  // the box: FIT_SCREEN = image exactly box width (= viewport), ORIGINAL_SIZE = box
                  // becomes a horizontal scroller, clipping becomes scroll.
                  ...(viewMode === ImageViewMode.FIT_SCREEN && {
                    maxWidth: 'none',
                  }),
                  ...(viewMode === ImageViewMode.ORIGINAL_SIZE && {
                    maxWidth: 'none',
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    // Not `center`: with flex + margin: 0 auto the auto margins collapse to 0 when
                    // space runs out — the image hugs the left and scrolls fully. With
                    // justifyContent: center a wide canvas would overflow both sides and the left
                    // edge would be unreachable by scroll.
                    justifyContent: 'flex-start',
                    overscrollBehaviorX: 'contain',
                  }),
                }}
              >
                {!imageErrors[index] && (
                  <img
                    src={fullUrl}
                    // First page is priority: loaded ALONE eager + fetchPriority=high so it arrives
                    // first without sharing bandwidth. The rest native lazy, over a cheap blurred
                    // preview (cyoa_pages_preview).
                    loading={index === 0 ? 'eager' : 'lazy'}
                    fetchPriority={index === 0 ? 'high' : 'auto'}
                    decoding="async"
                    alt={`Game content ${index + 1}`}
                    className={
                      viewMode === ImageViewMode.FIT_SCREEN
                        ? 'full-width-image'
                        : viewMode === ImageViewMode.ORIGINAL_SIZE
                        ? 'original-size-image'
                        : 'normal-image'
                    }
                    style={{ transition: 'all 0.3s ease' }}
                    onLoad={() => {
                      setLoadedPages(prev => (prev[index] ? prev : { ...prev, [index]: true }));
                      // Before load there's nothing to scroll (zero content width) and the
                      // registerPageScroller position would reset; re-apply the shared position
                      // once laid out.
                      const scroller = pageScrollersRef.current.get(index);
                      if (scroller) scroller.scrollLeft = hScrollRef.current;
                    }}
                    onError={() => {
                      // Error also "resolves": remove the reserve so an empty box doesn't hold a
                      // 90vh hole.
                      setLoadedPages(prev => (prev[index] ? prev : { ...prev, [index]: true }));
                      setImageErrors(prev => ({ ...prev, [index]: true }));
                    }}
                  />
                )}
              </Box>
            );
          })}

          {visibleCount < game.cyoa_pages.length && (
            <Box
              ref={loadMoreRef}
              sx={{
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                py: '1.5rem',
              }}
            >
              <Button
                variant="contained"
                onClick={() =>
                  setVisibleCount(c => Math.min(c + LOAD_STEP, game.cyoa_pages.length))
                }
                sx={{
                  backgroundColor: 'rgba(0,0,0,0.7)',
                  color: 'white',
                  '&:hover': { backgroundColor: '#636363' },
                }}
              >
                {`Load more (${game.cyoa_pages.length - visibleCount} left)`}
              </Button>
            </Box>
          )}

          <Box
            sx={{
              position: 'fixed',
              // Lift above the iOS home indicator / bottom browser bar (env works now that
              // index.html has viewport-fit=cover; 20px elsewhere).
              bottom: 'calc(20px + env(safe-area-inset-bottom))',
              right: '20px',
              zIndex: 1000,
              display: isZoomed ? 'none' : 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <ButtonGroup
              orientation="horizontal"
              variant="contained"
              size="small"
              sx={{ backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: '4px' }}
            >
              <Tooltip title="Fit to Container" placement="top">
                <Button
                  onClick={() => changeViewMode(ImageViewMode.FIT_CONTAINER)}
                  sx={{
                    backgroundColor:
                      viewMode === ImageViewMode.FIT_CONTAINER ? '#4a4a4a' : 'transparent',
                    color: 'white',
                    '&:hover': { backgroundColor: '#636363' },
                  }}
                >
                  <FitScreenIcon />
                </Button>
              </Tooltip>

              <Tooltip title="Fit to Screen Width" placement="top">
                <Button
                  onClick={() => changeViewMode(ImageViewMode.FIT_SCREEN)}
                  sx={{
                    backgroundColor:
                      viewMode === ImageViewMode.FIT_SCREEN ? '#4a4a4a' : 'transparent',
                    color: 'white',
                    '&:hover': { backgroundColor: '#636363' },
                  }}
                >
                  <AspectRatioIcon />
                </Button>
              </Tooltip>

              <Tooltip title="Original Size" placement="top">
                <Button
                  onClick={() => changeViewMode(ImageViewMode.ORIGINAL_SIZE)}
                  sx={{
                    backgroundColor:
                      viewMode === ImageViewMode.ORIGINAL_SIZE ? '#4a4a4a' : 'transparent',
                    color: 'white',
                    '&:hover': { backgroundColor: '#636363' },
                  }}
                >
                  <ZoomOutMapIcon />
                </Button>
              </Tooltip>
            </ButtonGroup>
          </Box>
        </Box>
      ) : game.img_or_link === 'link' && game.iframe_url ? (
        <Box
          ref={iframeContainerRef}
          sx={{
            position: 'relative',
            width: '100%',
            height: isImmersiveMode ? '100%' : { xs: '50vh', sm: '500px' },
            minHeight: isImmersiveMode ? '100%' : '300px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            transition: 'all 0.3s ease',
            paddingBottom: isImmersiveMode ? 'env(safe-area-inset-bottom)' : 0,
          }}
        >
          {isIframeLoading && (
            <Box
              sx={{
                position: 'absolute',
                width: '100%',
                height: '100%',
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
            src={iframeSrc}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              zIndex: 1,
            }}
            title="Interactive CYOA"
            allow="fullscreen; accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            aria-label="Interactive CYOA"
            loading="lazy"
            onLoad={() => setIsIframeLoading(false)}
            onError={handleIframeError}
          />
          {!isIframeLoading && !customBarActive && (
            <Box
              sx={{
                position: 'absolute',
                bottom: isImmersiveMode ? 'calc(10px + env(safe-area-inset-bottom))' : '10px',
                right: '10px',
                zIndex: 10,
                display: 'flex',
                gap: '8px',
              }}
            >
              {/*
                Expanded (either way) leaves only the "back to page" button — the other would just
                switch expand modes, and over the game this row sits where the point bar is. Native
                fullscreen wins if both read true.
              */}
              {!isFullscreen && (
                <Button
                  onClick={toggleImmersiveMode}
                  sx={{
                    backgroundColor: '#4a4a4a',
                    color: 'white',
                    minWidth: '40px',
                    '&:hover': { backgroundColor: '#636363' },
                  }}
                  title={isImmersiveMode ? 'Collapse' : 'Expand'}
                >
                  {isImmersiveMode ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                </Button>
              )}

              {(!isImmersiveMode || isFullscreen) && (
                <Button
                  onClick={toggleFullscreen}
                  sx={{
                    backgroundColor: '#e8484e',
                    color: 'white',
                    minWidth: '40px',
                    '&:hover': { backgroundColor: '#d73b41' },
                  }}
                  title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
                </Button>
              )}
            </Box>
          )}
        </Box>
      ) : (
        <div>No game content available</div>
      )}
    </Box>
  );
}