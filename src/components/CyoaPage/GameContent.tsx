// src/components/CyoaPage/GameContent.tsx

import { useState, useRef, useEffect } from 'react';
import { Box, Button, CircularProgress, ButtonGroup, Tooltip } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
// Убираем импорт logFrontendError, так как он больше не используется напрямую в этом файле после удаления reportFullscreenIssue
// import { Game, logFrontendError } from '../../pocketbase/pocketbase';
import { Game } from '../../pocketbase/pocketbase'; // Оставляем только Game
import { useVisualViewportScale } from '../../utils/useVisualViewportScale';
import { withSaveFlag, isHostedGameUrl } from '../../utils/cheat';
import { useCheatBridge } from '../CheatLab/useCheatBridge';
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

// Постраничное окно для картиночных (статичных) игр. Раньше при открытии
// игры код жадно тянул ВСЕ cyoa_pages сразу (new Image() на каждую) — для
// гига-игр на сотни страниц это жгло трафик, забивало ОЗУ огромными
// декодированными полотнами и вешало мобильники. Теперь рендерим окно:
//   • первые INITIAL_BATCH страниц;
//   • при прокрутке следующие пачки по LOAD_STEP подгружаются САМИ, но только
//     до AUTO_CAP — дальше нужно жать «Загрузить ещё» (тормоз для гига-игр);
//   • сами <img> с loading="lazy" + content-visibility:auto — браузер не качает
//     и не держит в памяти то, что за экраном.
//
// ⚠️ Каждая ещё НЕ загруженная страница обязана резервировать реальную высоту
// (RESERVE_VH ниже). Без этого незагруженные <img> схлопываются в 0px, колонка
// становится ~нулевой, нижний сентинел мгновенно попадает в кадр — и
// IntersectionObserver каскадом раскрывает окно до AUTO_CAP ещё до того, как
// хоть одна картинка разложилась. Итог: браузер жадно тянет ВЕСЬ auto-диапазон
// сразу (сотни МБ). Резерв высоты держит сентинел под фолдом → подгрузка идёт
// только по фактическому скроллу.
const INITIAL_BATCH = 4;
const LOAD_STEP = 6;
const AUTO_CAP = 28; // 4 → 10 → 16 → 22 → 28 авто-подгрузкой, потом только кнопкой
const RESERVE_VH = 90; // высота-заглушка под незагруженную страницу (страницы CYOA высокие)

interface GameContentProps {
  game: Game;
  // When true, the already-loaded saver shim is switched to the full cheat menu
  // over postMessage (no iframe reload — selections survive). Off = saver mode.
  cheatsActive?: boolean;
  // Fired once the shim announces itself — i.e. the engine actually supports
  // cheats (the parent uses this to distinguish "supported" from a dead click).
  onCheatReady?: () => void;
  // A build string to reproduce in the game (from a "Load" click); onLoadSent
  // fires once the bridge has handed it to the shim so the parent can clear it.
  loadCode?: string | null;
  onLoadSent?: () => void;
}

export default function GameContent({ game, cheatsActive = false, onCheatReady, loadCode, onLoadSent }: GameContentProps): JSX.Element {
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});
  // Какие страницы уже реально загрузились. Пока false — под страницу держим
  // резерв высоты RESERVE_VH, иначе незагруженный <img> схлопывается в 0px,
  // колонка обнуляется и IntersectionObserver каскадит окно до AUTO_CAP разом.
  const [loadedPages, setLoadedPages] = useState<Record<number, boolean>>({});
  // Сколько страниц картиночной игры сейчас отрендерено (окно). См. INITIAL_BATCH.
  const [visibleCount, setVisibleCount] = useState<number>(INITIAL_BATCH);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [isIframeLoading, setIsIframeLoading] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isImmersiveMode, setIsImmersiveMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ImageViewMode>(ImageViewMode.FIT_CONTAINER);

  // Пока пользователь пинч-зумит полотно, прячем плавающие кнопки режимов —
  // как fixed-элемент они иначе раздуваются/уезжают поверх контента.
  const vvScale = useVisualViewportScale();
  const isZoomed = vvScale > 1.05;

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Interactive iframe URL. Our own hosted games always load with ?__save=1 so
  // the Go backend injects the companion shim in saver mode ("post a build" +
  // point-bar utilities); the flagged URL is a separate edge-cache entry with
  // normal cache headers, and direct visits to the game subdomain (no flag)
  // stay byte-for-byte untouched. External games get no flag (their servers
  // would just ignore it). The URL never changes with the cheat toggle — mode
  // switches ride postMessage, so the game is never reloaded.
  const isInteractiveGame = game.img_or_link === 'link' && !!game.iframe_url;
  const isHosted = isInteractiveGame && isHostedGameUrl(game.iframe_url);
  const iframeSrc = isHosted ? withSaveFlag(game.iframe_url) : game.iframe_url;
  // Parent side of the shim bridge: posts builds, answers the cheat-unlock
  // check, and pushes the save/cheat mode. Active for every hosted game (the
  // saver sheet is always on); inert for external iframes.
  useCheatBridge(iframeRef, {
    src: iframeSrc,
    gameId: game.id,
    enabled: isHosted,
    mode: cheatsActive ? 'cheat' : 'save',
    onReady: onCheatReady,
    loadCode,
    onLoadSent,
  });

  // Real playtime for interactive games: GA's own engagement timer can't see
  // clicks inside the iframe, so we measure "tab visible + focused" ourselves
  // and report game_play / game_heartbeat. Image games render in the parent doc
  // and GA already measures them, so this stays off for them.
  useGamePlaytime(game.id, isInteractiveGame, isHosted);

  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const initialIframeStyles = useRef<{ height: string; width: string } | null>(null);
  // Read inside event handlers/timeouts that must not close over a stale state.
  const isImmersiveModeRef = useRef<boolean>(false);
  isImmersiveModeRef.current = isImmersiveMode;
  // Inline `display` values we overwrote when hiding the site chrome, so the
  // restore puts back exactly what was there (portals may be legitimately
  // hidden) instead of blanket-clearing it.
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

  // Сброс окна при смене игры: снова показываем только первую пачку.
  useEffect(() => {
    setVisibleCount(INITIAL_BATCH);
    setImageErrors({});
    setLoadedPages({});
  }, [game.id]);

  // Авто-подгрузка при прокрутке — но только до AUTO_CAP. Наблюдаем за
  // нижним сентинелом; как только он подъезжает к экрану, раскрываем ещё
  // пачку. Дальше AUTO_CAP наблюдатель не вешается — там раскрывает только
  // кнопка (жёсткий тормоз, чтобы гига-игра не убежала в сотни страниц).
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
      { rootMargin: '400px' } // подтягиваем заранее, до появления в кадре
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
        // dvh tracks the live viewport as the iOS URL bar collapses, so the
        // bottom of the game no longer hides under the browser toolbar.
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

  // Immersive mode hides the site chrome (header/footer/body portals) with
  // inline styles. That MUST stay declarative: exits happen through several
  // paths that never go through toggleImmersiveMode() — a native-fullscreen
  // exit, an orientation change, or navigating away — and an imperative
  // restore in the toggle alone left the header stuck at display:none with
  // isImmersiveMode already false (so even Esc could no longer bring it back).
  useEffect(() => {
    if (!isImmersiveMode) return;

    const hide = (el: HTMLElement | null): void => {
      if (!el) return;
      hiddenChromeRef.current.push({ el, prev: el.style.display });
      el.style.display = 'none';
    };

    document.body.style.overflow = 'hidden';
    hide(document.querySelector('header'));
    hide(document.querySelector('footer'));
    document
      .querySelectorAll('body > *:not(#root)')
      .forEach((el) => hide(el as HTMLElement));

    const main = document.querySelector('main') as HTMLElement | null;
    if (main) {
      main.style.padding = '0';
      main.style.margin = '0';
      // dvh (not vh) so the iOS URL bar collapse doesn't clip the bottom.
      main.style.height = '100dvh';
      main.style.width = '100vw';
      main.style.maxWidth = '100vw';
    }

    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    return () => {
      document.body.style.overflow = '';
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
        // The immersive effect's cleanup restores body/chrome/iframe styles.
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

  useEffect(() => {
    const contentContainer = contentContainerRef.current;
    if (contentContainer) {
      contentContainer.style.overflow =
        viewMode === ImageViewMode.FIT_CONTAINER ? 'hidden' : 'visible';
    }
  }, [viewMode]);

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

  // Удалена функция reportFullscreenIssue, так как она больше не используется

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
            // Логирование на сервер убрано
            console.error('Fullscreen activation check failed after timeout'); // Можно оставить для локальной отладки
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
      console.error('Fullscreen toggle error:', errorMessage); // Оставляем локальное логирование для отладки
      // Логирование на сервер убрано
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
      {game.img_or_link === 'img' && game.cyoa_pages.length > 0 ? (
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
                sx={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: '#121212',
                  position: 'relative',
                  // Разгружаем ОЗУ: браузер не рендерит/декодит уехавшее за экран
                  // и отпускает пиксели. Гига-полотна не копятся в памяти.
                  contentVisibility: 'auto',
                  containIntrinsicSize: 'auto 1200px',
                  // Резерв высоты, пока страница не загрузилась: держит колонку
                  // высокой, чтобы нижний сентинел не оказался сразу в кадре и
                  // авто-подгрузка не сработала каскадом (см. RESERVE_VH выше).
                  // После onLoad резерв снимаем — бокс садится по факт. высоте.
                  ...(!loadedPages[index] && { minHeight: `${RESERVE_VH}vh` }),
                  // Дешёвое размытое превью как подложка, ТОЛЬКО пока грузится
                  // полное. После onLoad фон снимаем — иначе для картинки уже
                  // колонки растянутое cover-превью торчит по бокам (выглядит
                  // как «дублируется/растягивается»). Узкая картинка должна
                  // просто сидеть по центру на тёмном #121212.
                  ...(previewUrl && !loadedPages[index] && {
                    backgroundImage: `url("${previewUrl}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    backgroundRepeat: 'no-repeat',
                  }),
                  ...(viewMode === ImageViewMode.FIT_SCREEN && {
                    maxWidth: 'none',
                    overflow: 'visible',
                  }),
                  ...(viewMode === ImageViewMode.ORIGINAL_SIZE && {
                    maxWidth: 'none',
                    overflow: 'visible',
                  }),
                }}
              >
                {!imageErrors[index] && (
                  <img
                    src={fullUrl}
                    // Первая страница — приоритетная: грузим её ОДНУ eager +
                    // fetchPriority=high, чтобы она пришла первой и быстро, не
                    // деля канал. Остальные — нативно лениво (браузер тянет их
                    // по мере подъезда к экрану); до загрузки под ними уже
                    // лежит дешёвое размытое превью (cyoa_pages_preview).
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
                    onLoad={() => setLoadedPages(prev => (prev[index] ? prev : { ...prev, [index]: true }))}
                    onError={() => {
                      // Ошибка = тоже «разрешилась»: снимаем резерв, чтобы
                      // пустой бокс не держал 90vh дыру.
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
              // Lift above the iOS home indicator / bottom browser bar so the
              // zoom controls aren't hidden under it (env is live now that
              // index.html has viewport-fit=cover; resolves to 20px elsewhere).
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
          {!isIframeLoading && (
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
              {/* Expanded (either way) leaves only the "back to the page"
                  button — the other one would just switch between expand
                  modes, and over the game the row sits right where the point
                  bar is. Native fullscreen wins if both somehow read true. */}
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