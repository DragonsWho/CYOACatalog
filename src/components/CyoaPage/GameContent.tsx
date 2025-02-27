import { useState, useRef, useEffect } from 'react';
import { Box, Button, CircularProgress, useMediaQuery, useTheme, ButtonGroup, Tooltip } from '@mui/material';
import { Game } from '../../pocketbase/pocketbase';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';

// Определим интерфейсы для кроссбраузерной поддержки fullscreen
interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
  mozRequestFullScreen?: () => Promise<void>;
  msRequestFullscreen?: () => Promise<void>;
}

interface FullscreenDocument extends Document {
  webkitExitFullscreen?: () => Promise<void>;
  mozCancelFullScreen?: () => Promise<void>;
  msExitFullscreen?: () => Promise<void>;
}

// Перечисление для режимов отображения изображений
enum ImageViewMode {
  FIT_CONTAINER = 'fit-container',
  FIT_SCREEN = 'fit-screen',
  ORIGINAL_SIZE = 'original-size'
}

export default function GameContent({ game }: { game: Game }) {
  const [imageErrors, setImageErrors] = useState<{ [key: number]: boolean }>({});
  const [loadingImages, setLoadingImages] = useState(game.cyoa_pages.length || 0);
  const [isIframeLoading, setIsIframeLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<ImageViewMode>(ImageViewMode.FIT_CONTAINER);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeContainerRef = useRef<HTMLDivElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);
  
  // Используем Material UI хук для определения размера экрана
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md')); // 'md' соответствует ширине экрана >= 960px
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  // Логирование для отладки
  useEffect(() => {
    if (game.img_or_link === 'link' && game.iframe_url) {
      console.log('Iframe URL:', game.iframe_url);
    }
  }, [game]);

  // Эффект для отслеживания изменений fullscreen режима
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Эффект для обработки overflow при смене режима просмотра
  useEffect(() => {
    const contentContainer = contentContainerRef.current;
    
    if (viewMode === ImageViewMode.FIT_CONTAINER) {
      // Стандартный режим - возвращаем обычные стили
      if (contentContainer) {
        contentContainer.style.overflow = 'hidden';
      }
    } else {
      // Для других режимов разрешаем полную видимость контента
      if (contentContainer) {
        contentContainer.style.overflow = 'visible';
      }
    }
  }, [viewMode]);

  function handleImageLoad() {
    setLoadingImages((prev) => prev - 1);
  }

  function handleImageError(id: number) {
    setImageErrors((prev) => ({ ...prev, [id]: true }));
    setLoadingImages((prev) => prev - 1);
  }

  const toggleFullscreen = () => {
    if (!iframeRef.current) return;

    if (!document.fullscreenElement) {
      const element = iframeRef.current as unknown as FullscreenElement;
      
      if (element.requestFullscreen) {
        element.requestFullscreen().catch((err) => {
          console.error(`Error entering fullscreen mode: ${err.message}`);
        });
      } else if (element.webkitRequestFullscreen) {
        element.webkitRequestFullscreen();
      } else if (element.mozRequestFullScreen) {
        element.mozRequestFullScreen();
      } else if (element.msRequestFullscreen) {
        element.msRequestFullscreen();
      }
    } else {
      const doc = document as unknown as FullscreenDocument;
      
      if (doc.exitFullscreen) {
        doc.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
    }
  };

  // Функция для переключения расширенного режима (только для iframe)
  const toggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  // Изменение режима просмотра изображений
  const changeViewMode = (mode: ImageViewMode) => { 
    if (viewMode === mode && mode !== ImageViewMode.FIT_CONTAINER) {
      setViewMode(ImageViewMode.FIT_CONTAINER);
    } else {
      setViewMode(mode);
    }
  };

  // Обработка ошибок загрузки iframe
  const handleIframeError = () => {
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
        overflow: viewMode !== ImageViewMode.FIT_CONTAINER ? 'visible' : 'hidden',
      }}
    >
      {game.img_or_link === 'img' && game.cyoa_pages.length ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            transition: 'all 0.3s ease',
            width: '100%',
            position: 'relative', 
            overflow: viewMode !== ImageViewMode.FIT_CONTAINER ? 'visible' : 'hidden',
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
              {imageErrors[index] && <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>}
            </Box>
          ))}
          
          {/* Плавающие элементы управления для изображений */}
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
                orientation={isMobile ? "vertical" : "horizontal"}
                variant="contained" 
                size="small" 
                sx={{ backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: '4px' }}
              >
                <Tooltip title="Fit to Container" placement="left">
                  <Button
                    onClick={() => changeViewMode(ImageViewMode.FIT_CONTAINER)}
                    sx={{
                      backgroundColor: viewMode === ImageViewMode.FIT_CONTAINER ? '#4a4a4a' : 'transparent',
                      color: 'white',
                      '&:hover': { backgroundColor: '#636363' },
                    }}
                  >
                    <FitScreenIcon />
                  </Button>
                </Tooltip>
                
                <Tooltip title="Fit to Screen Width" placement="left">
                  <Button
                    onClick={() => changeViewMode(ImageViewMode.FIT_SCREEN)}
                    sx={{
                      backgroundColor: viewMode === ImageViewMode.FIT_SCREEN ? '#4a4a4a' : 'transparent',
                      color: 'white',
                      '&:hover': { backgroundColor: '#636363' },
                    }}
                  >
                    <AspectRatioIcon />
                  </Button>
                </Tooltip>
                
                <Tooltip title="Original Size" placement="left">
                  <Button
                    onClick={() => changeViewMode(ImageViewMode.ORIGINAL_SIZE)}
                    sx={{
                      backgroundColor: viewMode === ImageViewMode.ORIGINAL_SIZE ? '#4a4a4a' : 'transparent',
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
            height: isExpanded 
              ? '100vh' 
              : { xs: '50vh', sm: '500px' }, // Адаптивная высота для мобильных
            minHeight: isExpanded ? '100vh' : '300px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            transition: 'all 0.3s ease'
          }}
        >
          {isIframeLoading && (
            <Box sx={{ 
              position: 'absolute', 
              width: '100%', 
              height: '100%', 
              display: 'flex', 
              justifyContent: 'center', 
              alignItems: 'center',
              backgroundColor: '#121212',
              zIndex: 5
            }}>
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
              zIndex: 1
            }}
            title="Interactive CYOA"
            allowFullScreen
            onLoad={() => {
              console.log('Iframe loaded successfully');
              setIsIframeLoading(false);
            }}
            onError={handleIframeError} // Обработка ошибок
          />
          {/* Кнопки управления отображаются только когда iframe загружен */}
          {!isIframeLoading && (
            <Box
              sx={{
                position: 'absolute',
                bottom: '10px',
                right: '10px',
                zIndex: 10,
                display: 'flex',
                gap: '8px'
              }}
            >
              {/* Кнопка Expand для десктопных устройств */}
              {isDesktop && (
                <Button
                  onClick={toggleExpand}
                  sx={{
                    backgroundColor: '#4a4a4a',
                    color: 'white',
                    minWidth: '40px',
                    '&:hover': {
                      backgroundColor: '#636363',
                    },
                  }}
                  title={isExpanded ? "Collapse" : "Expand"}
                >
                  {isExpanded ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                </Button>
              )}
              
              {/* Кнопка Fullscreen */}
              <Button
                onClick={toggleFullscreen}
                sx={{
                  backgroundColor: '#e8484e',
                  color: 'white',
                  minWidth: '40px',
                  '&:hover': {
                    backgroundColor: '#d73b41',
                  },
                }}
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
              </Button>
            </Box>
          )}
          
          {/* Кнопка "Закрыть" в режиме expanded */}
          {isExpanded && !isIframeLoading && (
            <Button
              onClick={toggleExpand}
              sx={{
                position: 'absolute',
                top: '10px',
                right: '10px',
                zIndex: 20,
                backgroundColor: 'rgba(0,0,0,0.5)',
                color: 'white',
                '&:hover': {
                  backgroundColor: 'rgba(0,0,0,0.7)',
                },
              }}
            >
              Закрыть
            </Button>
          )}
        </Box>
      ) : (
        <div>No game content available</div>
      )}
    </Box>
  );
}