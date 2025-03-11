import { useState, useRef, useEffect } from 'react';
import { Box, Button, CircularProgress, useMediaQuery, useTheme, ButtonGroup, Tooltip } from '@mui/material';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import { Game, logFrontendError } from '../../pocketbase/pocketbase';

// Интерфейс для Fullscreen API с учетом всех префиксов
interface FullscreenElement {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  mozRequestFullScreen?: (options?: FullscreenOptions) => Promise<void>;
  msRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
}

interface FullscreenDocument extends Document {
  fullscreenElement: Element | null;
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;

  fullscreenEnabled: boolean;
  webkitFullscreenEnabled?: boolean;
  mozFullScreenEnabled?: boolean;
  msFullscreenEnabled?: boolean;

  exitFullscreen: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
  mozCancelFullScreen?: () => Promise<void>;
  msExitFullscreen?: () => Promise<void>;
}

// Интерфейс для screen.orientation
interface ScreenOrientationExtended extends ScreenOrientation {
  lock: (orientation: OrientationLockType) => Promise<void>;
  unlock: () => void;
}

interface ExtendedScreen extends Screen {
  orientation: ScreenOrientationExtended;
}

// Типы ориентации экрана
type OrientationLockType =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary';

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
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});
  const [loadingImages, setLoadingImages] = useState<number>(game.cyoa_pages.length || 0);
  const [isIframeLoading, setIsIframeLoading] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ImageViewMode>(ImageViewMode.FIT_CONTAINER);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);

  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));

  // Вспомогательные функции для определения платформы
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

  // Обработка изменения полноэкранного режима
  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const doc = document as FullscreenDocument;
      const isInFullscreen = !!(
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );
      console.log('Fullscreen state changed:', isInFullscreen);
      setIsFullscreen(isInFullscreen);

      if (!isInFullscreen) {
        console.log('Exited fullscreen, resetting expanded state');
        setIsExpanded(false);
        setFullscreenError(null);
        document.body.style.overflow = '';
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

        if (!isStillFullscreen && isFullscreen) {
          console.log('Fullscreen was exited due to orientation change');
          setIsFullscreen(false);
          setIsExpanded(false);
          document.body.style.overflow = '';
        }
      }
    };

    const events = [
      ['fullscreenchange', handleFullscreenChange] as const,
      ['webkitfullscreenchange', handleFullscreenChange] as const,
      ['mozfullscreenchange', handleFullscreenChange] as const,
      ['MSFullscreenChange', handleFullscreenChange] as const,
      ['orientationchange', handleOrientationChange] as const,
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
      setFullscreenError(null);
    };
  }, [isFullscreen]);

  // Обработка клавиши Escape
  useEffect(() => {
    const handleEscapeKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && isExpanded && !isFullscreen) {
        setIsExpanded(false);
        document.body.style.overflow = '';
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [isExpanded, isFullscreen]);

  // Обновление стилей контейнера в зависимости от viewMode
  useEffect(() => {
    const contentContainer = contentContainerRef.current;
    if (contentContainer) {
      contentContainer.style.overflow =
        viewMode === ImageViewMode.FIT_CONTAINER ? 'hidden' : 'visible';
    }
  }, [viewMode]);

  // Проверка поддержки fullscreen API
  const isFullscreenSupported = (elem: HTMLElement | null): boolean => {
    const doc = document as FullscreenDocument;
    const isApiSupported = !!(
      doc.fullscreenEnabled ||
      doc.webkitFullscreenEnabled ||
      doc.mozFullScreenEnabled ||
      doc.msFullscreenEnabled
    );
    const isElementValid =
      elem &&
      ('requestFullscreen' in elem ||
        'webkitRequestFullscreen' in elem ||
        'mozRequestFullScreen' in elem ||
        'msRequestFullscreen' in elem);
    return isApiSupported && !!isElementValid;
  };

  // Проверка поддержки блокировки ориентации
  const isOrientationLockSupported = (): boolean => {
    return 'orientation' in screen && 'lock' in (screen as ExtendedScreen).orientation;
  };

  // Обработчики загрузки и ошибок изображений
  const handleImageLoad = (): void => {
    setLoadingImages((prev) => prev - 1);
  };

  const handleImageError = (id: number): void => {
    setImageErrors((prev) => ({ ...prev, [id]: true }));
    setLoadingImages((prev) => prev - 1);
  };

  // Функция для входа в полноэкранный режим с таймаутом
  const requestFullscreenWithTimeout = async (elem: FullscreenElement): Promise<void> => {
    const methods = [
      elem.requestFullscreen,
      elem.webkitRequestFullscreen,
      elem.mozRequestFullScreen,
      elem.msRequestFullscreen,
    ].filter((method): method is (options?: FullscreenOptions) => Promise<void> => typeof method === 'function');

    if (!methods.length) {
      throw new Error('No fullscreen method available on this element');
    }

    let lastError: Error | null = null;
    for (const method of methods) {
      try {
        const fullscreenPromise = method();
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Fullscreen request timed out')), 3000)
        );
        return await Promise.race([fullscreenPromise, timeoutPromise]);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown fullscreen error');
        console.warn(`Fullscreen method failed: ${lastError.message}`);
      }
    }
    throw lastError || new Error('All fullscreen methods failed');
  };

  // Выход из полноэкранного режима с таймаутом
  const exitFullscreenWithTimeout = async (): Promise<void> => {
    const doc = document as FullscreenDocument;
    const methods = [
      doc.exitFullscreen,
      doc.webkitExitFullscreen,
      doc.mozCancelFullScreen,
      doc.msExitFullscreen,
    ].filter((method): method is () => Promise<void> => typeof method === 'function');

    if (!methods.length) {
      throw new Error('No exit fullscreen method available');
    }

    let lastError: Error | null = null;
    for (const method of methods) {
      try {
        const exitPromise = method();
        const timeoutPromise = new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Exit fullscreen request timed out')), 3000)
        );
        return await Promise.race([exitPromise, timeoutPromise]);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown exit error');
        console.warn(`Exit fullscreen method failed: ${lastError.message}`);
      }
    }
    throw lastError || new Error('All exit fullscreen methods failed');
  };

  // Функция для автоматической отправки отчета об ошибке
  const reportFullscreenIssue = async (error: string): Promise<void> => {
    const details = {
      isFullscreen,
      isExpanded,
      viewMode,
      fullscreenSupported: isFullscreenSupported(iframeContainerRef.current),
      iframeUrl: game.iframe_url || 'N/A',
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      screenOrientation: (screen as ExtendedScreen).orientation?.type || 'unknown',
      timestamp: new Date().toISOString(),
    };
    await logFrontendError(`Fullscreen error: ${error}`, details);

    setFullscreenError('Fullscreen error: Function failed');
    setTimeout(() => setFullscreenError(null), 5000);
  };

  // Переключение полноэкранного режима
  const toggleFullscreen = async (): Promise<void> => {
    try {
      const targetElement = iframeContainerRef.current ?? iframeRef.current;
      if (!targetElement) {
        throw new Error('No valid target element for fullscreen (both container and iframe are null)');
      }

      const doc = document as FullscreenDocument;
      const elem = targetElement as FullscreenElement;
      const isCurrentlyFullscreen = !!(
        doc.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );

      if (!isCurrentlyFullscreen) {
        if (isIOS() && !elem.webkitRequestFullscreen) {
          console.log('iOS detected, Webkit fullscreen not supported, forcing expanded mode');
          toggleExpand();
          return;
        }

        if (!isFullscreenSupported(targetElement)) {
          throw new Error('Fullscreen API not supported for this element or device');
        }

        if (isAndroidWebView()) {
          console.warn('Android WebView detected, may have fullscreen limitations');
        }

        console.log('Entering fullscreen mode with element:', targetElement);
        await requestFullscreenWithTimeout(elem);

        if (isOrientationLockSupported()) {
          try {
            await (screen as ExtendedScreen).orientation.lock('landscape');
          } catch (e) {
            console.warn('Screen orientation lock failed:', e);
          }
        }

        setTimeout(() => {
          const docCheck = document as FullscreenDocument;
          const isStillFullscreen = !!(
            docCheck.fullscreenElement ||
            docCheck.webkitFullscreenElement ||
            docCheck.mozFullScreenElement ||
            docCheck.msFullscreenElement
          );
          if (!isStillFullscreen) {
            console.warn('Fullscreen failed to activate');
            throw new Error('Fullscreen activation check failed');
          }
        }, 500);
      } else {
        console.log('Exiting fullscreen mode');
        await exitFullscreenWithTimeout();

        if (isOrientationLockSupported()) {
          try {
            (screen as ExtendedScreen).orientation.unlock();
          } catch (e) {
            console.warn('Screen orientation unlock failed:', e);
          }
        }

        setTimeout(() => {
          const docCheck = document as FullscreenDocument;
          const isStillFullscreen = !!(
            docCheck.fullscreenElement ||
            docCheck.webkitFullscreenElement ||
            docCheck.mozFullScreenElement ||
            docCheck.msFullscreenElement
          );
          if (isStillFullscreen) {
            console.warn('Failed to exit fullscreen');
            throw new Error('Fullscreen exit check failed');
          }
        }, 500);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Fullscreen toggle failed:', error);
      await reportFullscreenIssue(errorMessage);
      toggleExpand();
    }
  };

  // Переключение расширенного режима
  const toggleExpand = (): void => {
    setIsExpanded((prev) => !prev);
    document.body.style.overflow = isExpanded ? '' : 'hidden';
  };

  // Смена режима отображения изображений
  const changeViewMode = (mode: ImageViewMode): void => {
    setViewMode((prev) =>
      mode === prev && mode !== ImageViewMode.FIT_CONTAINER ? ImageViewMode.FIT_CONTAINER : mode
    );
  };

  // Обработка ошибок iframe
  const handleIframeError = (): void => {
    console.error('Iframe failed to load:', game.iframe_url);
    setIsIframeLoading(false);
  };

  return (
    <Box
      ref={contentContainerRef}
      sx={{
        backgroundColor: '#121212',
        position: 'relative',
        width: '100%',
        ...(isExpanded && {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1300,
          width: '100vw',
          height: '100vh',
          backgroundColor: '#000',
          overflowY: 'auto',
        }),
      }}
    >
      {fullscreenError && (
        <Box
          sx={{
            position: 'absolute',
            top: '10px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(200, 0, 0, 0.8)',
            color: 'white',
            padding: '8px 16px',
            borderRadius: '4px',
            zIndex: 2000,
            maxWidth: '90%',
            textAlign: 'center',
          }}
        >
          {fullscreenError}
        </Box>
      )}

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
                  onError={() => handleImageError(index)}
                />
              )}
              {imageErrors[index] && (
                <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>
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
            height: isExpanded ? '100vh' : { xs: '50vh', sm: '500px' },
            minHeight: isExpanded ? '100vh' : '300px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            transition: 'all 0.3s ease',
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
            onLoad={() => {
              console.log('Iframe loaded successfully');
              setIsIframeLoading(false);
            }}
            onError={handleIframeError}
          />
          {!isIframeLoading && (
            <Box
              sx={{
                position: 'absolute',
                bottom: '10px',
                right: '10px',
                zIndex: 10,
                display: 'flex',
                gap: '8px',
              }}
            >
              {isDesktop && (
                <Button
                  onClick={toggleExpand}
                  sx={{
                    backgroundColor: '#4a4a4a',
                    color: 'white',
                    minWidth: '40px',
                    '&:hover': { backgroundColor: '#636363' },
                  }}
                  title={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isExpanded ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                </Button>
              )}

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