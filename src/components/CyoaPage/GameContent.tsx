import { useState, useRef, useEffect } from 'react';
import { Box, Button, CircularProgress, ButtonGroup, Tooltip } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import { Game, logFrontendError } from '../../pocketbase/pocketbase';

// Интерфейс для Fullscreen API в Document
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

// Перечисление для режимов отображения изображений
enum ImageViewMode {
  FIT_CONTAINER = 'fit-container',
  FIT_SCREEN = 'fit-screen',
  ORIGINAL_SIZE = 'original-size',
}

interface GameContentProps {
  game: Game;
}

export default function GameContent({ game }: GameContentProps): JSX.Element {
  const [imageErrors] = useState<Record<number, boolean>>({});
  const [loadingImages, setLoadingImages] = useState<number>(game.cyoa_pages.length || 0);
  const [isIframeLoading, setIsIframeLoading] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isImmersiveMode, setIsImmersiveMode] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ImageViewMode>(ImageViewMode.FIT_CONTAINER);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  const scrollPositionRef = useRef<number>(0);
  const initialIframeStyles = useRef<{ height: string; width: string } | null>(null);

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

  // Сброс стилей iframe-контейнера
  const resetIframeStyles = (): void => {
    const iframeContainer = iframeContainerRef.current;
    if (iframeContainer) {
      iframeContainer.style.height = initialIframeStyles.current?.height || '500px';
      iframeContainer.style.width = initialIframeStyles.current?.width || '100%';
      iframeContainer.style.position = 'relative';
      iframeContainer.style.paddingBottom = '0';
    }
  };

  // Сохранение исходных стилей при монтировании
  useEffect(() => {
    const iframeContainer = iframeContainerRef.current;
    if (iframeContainer && !initialIframeStyles.current) {
      initialIframeStyles.current = {
        height: iframeContainer.style.height || '500px',
        width: iframeContainer.style.width || '100%',
      };
    }
  }, []);

  // Обновление высоты iframe в immersive-режиме
  useEffect(() => {
    const updateIframeHeight = (): void => {
      const iframeContainer = iframeContainerRef.current;
      if (iframeContainer && isImmersiveMode) {
        iframeContainer.style.height = `${window.innerHeight}px`;
      }
    };

    if (isImmersiveMode) {
      updateIframeHeight();
      window.addEventListener('resize', updateIframeHeight);
    } else {
      resetIframeStyles();
    }

    return () => {
      window.removeEventListener('resize', updateIframeHeight);
    };
  }, [isImmersiveMode]);

  // Обработка событий fullscreen и ориентации
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
        document.body.style.overflow = '';
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
          document.body.style.overflow = '';
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

  // Обработка Escape для выхода из immersive-режима
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

  // Управление overflow в зависимости от viewMode
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

  const handleImageLoad = (): void => {
    setLoadingImages((prev) => prev - 1);
  };

  const reportFullscreenIssue = async (error: string): Promise<void> => {
    // Проверяем поддержку полноэкранного режима в текущем браузере
    const doc = document as FullscreenDocument;
    const docElement = document.documentElement;
    
    const fullscreenMethods = {
      requestFullscreen: 'requestFullscreen' in docElement,
      webkitRequestFullscreen: 'webkitRequestFullscreen' in docElement,
      mozRequestFullScreen: 'mozRequestFullScreen' in docElement,
      msRequestFullscreen: 'msRequestFullscreen' in docElement,
    };
    
    const fullscreenExitMethods = {
      exitFullscreen: !!doc.exitFullscreen,
      webkitExitFullscreen: !!doc.webkitExitFullscreen,
      mozCancelFullScreen: !!doc.mozCancelFullScreen,
      msExitFullscreen: !!doc.msExitFullscreen,
    };

    const details: Record<string, unknown> = {
      error: error,
      // Исправлено: убираем проверку instanceof Error
      errorStack: typeof error === 'object' && error !== null && 'stack' in error ? 
                  (error as { stack: string }).stack : 'No stack available',
      
      // Текущее состояние
      isFullscreen,
      isImmersiveMode,
      viewMode,
      fullscreenSupported: isFullscreenSupported(iframeContainerRef.current),
      
      // Информация о браузере и устройстве
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      vendor: navigator.vendor,
      appVersion: navigator.appVersion,
      isIOS: isIOS(),
      isAndroidWebView: isAndroidWebView(),
      
      // Информация об экране
      screenOrientation: screen.orientation?.type || 'unknown',
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenPixelRatio: window.devicePixelRatio,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      
      // Элементы DOM
      iframeRefExists: !!iframeRef.current,
      iframeContainerRefExists: !!iframeContainerRef.current,
      iframeUrl: game.iframe_url || 'N/A',
      iframeCurrentWidth: iframeRef.current?.clientWidth,
      iframeCurrentHeight: iframeRef.current?.clientHeight,
      
      // API поддержка
      fullscreenAPISupport: {
        documentFullscreenEnabled: doc.fullscreenEnabled,
        webkitFullscreenEnabled: doc.webkitFullscreenEnabled,
        mozFullScreenEnabled: doc.mozFullScreenEnabled,
        msFullscreenEnabled: doc.msFullscreenEnabled,
      },
      
      // Доступные методы
      fullscreenMethodsAvailable: fullscreenMethods,
      fullscreenExitMethodsAvailable: fullscreenExitMethods,
      
      // Текущее состояние fullscreen API
      currentFullscreenElement: {
        standard: !!doc.fullscreenElement,
        webkit: !!doc.webkitFullscreenElement,
        moz: !!doc.mozFullScreenElement,
        ms: !!doc.msFullscreenElement,
      },
      
      // Таймштамп
      timestamp: new Date().toISOString(),
    };
    
    await logFrontendError(`Fullscreen error: ${error}`, details);
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

        // Принудительно указываем все опциональные методы через as
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

        // Изменен обработчик проверки активации полноэкранного режима
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
            // Вместо throw, который не будет перехвачен, вызываем напрямую
            reportFullscreenIssue('Fullscreen activation check failed after timeout');
            toggleImmersiveMode(); // Активируем запасной вариант
          }
        }, 300); // Уменьшено время ожидания
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
      await reportFullscreenIssue(errorMessage);
      toggleImmersiveMode();
    }
  };

  const toggleImmersiveMode = (): void => {
    if (!isImmersiveMode) {
      scrollPositionRef.current = window.scrollY;
    }

    setIsImmersiveMode((prev) => !prev);

    if (!isImmersiveMode) {
      document.body.style.overflow = 'hidden';
      const header = document.querySelector('header');
      const footer = document.querySelector('footer');
      const mainContent = document.querySelector('main');

      if (header) (header as HTMLElement).style.display = 'none';
      if (footer) (footer as HTMLElement).style.display = 'none';
      if (mainContent) {
        const main = mainContent as HTMLElement;
        main.style.padding = '0';
        main.style.margin = '0';
        main.style.height = '100vh';
        main.style.width = '100vw';
        main.style.maxWidth = '100vw';
      }

      document.querySelectorAll('body > *:not(#root)').forEach((el) => {
        (el as HTMLElement).style.display = 'none';
      });

      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    } else {
      document.body.style.overflow = '';
      const header = document.querySelector('header');
      const footer = document.querySelector('footer');
      const mainContent = document.querySelector('main');

      if (header) (header as HTMLElement).style.display = '';
      if (footer) (footer as HTMLElement).style.display = '';
      if (mainContent) {
        const main = mainContent as HTMLElement;
        main.style.padding = '';
        main.style.margin = '';
        main.style.height = '';
        main.style.width = '';
        main.style.maxWidth = '';
      }

      document.querySelectorAll('body > *:not(#root)').forEach((el) => {
        (el as HTMLElement).style.display = '';
      });

      resetIframeStyles();
      requestAnimationFrame(() => {
        window.scrollTo(0, scrollPositionRef.current);
      });
    }
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
        height: isImmersiveMode ? '100vh' : 'auto',
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
          {loadingImages > 0 && <CircularProgress />}
          {game.cyoa_pages.map((image, index) => (
            <Box
              key={index}
              sx={{
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: '#121212',
                position: 'relative',
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
                  src={`/api/files/games/${game.id}/${image}`}
                  alt={`Game content ${index + 1}`}
                  className={
                    viewMode === ImageViewMode.FIT_SCREEN
                      ? 'full-width-image'
                      : viewMode === ImageViewMode.ORIGINAL_SIZE
                      ? 'original-size-image'
                      : 'normal-image'
                  }
                  style={{
                    display: loadingImages > 0 ? 'none' : 'block',
                    transition: 'all 0.3s ease',
                  }}
                  onLoad={handleImageLoad}
                />
              )}
            </Box>
          ))}

          {loadingImages === 0 && (
            <Box
              sx={{
                position: 'fixed',
                bottom: '20px',
                right: '20px',
                zIndex: 1000,
                display: 'flex',
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
          )}
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
            src={game.iframe_url}
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
            </Box>
          )}
        </Box>
      ) : (
        <div>No game content available</div>
      )}
    </Box>
  );
}