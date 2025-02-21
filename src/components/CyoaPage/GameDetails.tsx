// src/components/CyoaPage/GameContent.tsx
// v2.8
// Исправлен синтаксис sx для &:hover

import React, { useState, useRef } from 'react';
import { Box, Button, CircularProgress } from '@mui/material';
import { Game } from '../../pocketbase/pocketbase';

interface ImageSizes {
  [key: number]: {
    width: number;
    height: number;
  };
}

export default function GameContent({ game }: { game: Game }) {
  const [imageErrors, setImageErrors] = useState<{ [key: number]: boolean }>({});
  const [imageSizes, setImageSizes] = useState<ImageSizes>({});
  const [loadingImages, setLoadingImages] = useState(game.cyoa_pages.length || 0);
  const [isIframeLoading, setIsIframeLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Обработка загрузки изображений
  function handleImageLoad(id: number, event: React.SyntheticEvent<HTMLImageElement, Event>) {
    setLoadingImages((prev) => prev - 1);
    setImageSizes((prev) => ({
      ...prev,
      [id]: {
        width: (event.target as HTMLImageElement).naturalWidth,
        height: (event.target as HTMLImageElement).naturalHeight,
      },
    }));
  }

  function handleImageError(id: number) {
    setImageErrors((prev) => ({ ...prev, [id]: true }));
    setLoadingImages((prev) => prev - 1);
  }

  // Переключение в полноэкранный режим
  const toggleFullscreen = () => {
    if (!iframeRef.current) return;

    if (!document.fullscreenElement) {
      iframeRef.current.requestFullscreen().catch((err) => {
        console.error(`Ошибка при переходе в полноэкранный режим: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  };

  return (
    <Box sx={{ backgroundColor: '#121212', position: 'relative' }}>
      {game.img_or_link === 'img' && game.cyoa_pages.length ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            transition: 'all 0.3s ease',
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
                transition: 'all 0.3s ease',
              }}
            >
              {!imageErrors[index] && (
                <img
                  src={`/api/files/games/${game.id}/${image}`}
                  alt={`Game content ${index + 1}`}
                  style={{
                    maxWidth: '100%',
                    width: imageSizes[index]?.width > window.innerWidth ? '100%' : 'auto',
                    height: 'auto',
                    display: loadingImages > 0 ? 'none' : 'block',
                    transition: 'all 0.3s ease',
                  }}
                  onLoad={(event) => handleImageLoad(index, event)}
                  onError={() => handleImageError(index)}
                />
              )}
              {imageErrors[index] && <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>}
            </Box>
          ))}
        </Box>
      ) : game.img_or_link === 'link' && game.iframe_url ? (
        <Box sx={{ position: 'relative', width: '100%', height: '500px' }}>
          {isIframeLoading && (
            <CircularProgress sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />
          )}
          <iframe
            ref={iframeRef}
            src={game.iframe_url}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: isIframeLoading ? 'none' : 'block',
            }}
            title="Interactive CYOA"
            allowFullScreen
            onLoad={() => setIsIframeLoading(false)}
          />
          <Button
            onClick={toggleFullscreen}
            sx={{
              position: 'absolute',
              bottom: '10px',
              right: '10px',
              zIndex: 10,
              backgroundColor: '#e8484e',
              color: 'white',
              '&:hover': {  // Исправленный синтаксис для псевдокласса
                backgroundColor: '#d73b41',
              },
            }}
          >
            {document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen'}
          </Button>
        </Box>
      ) : (
        <div>No game content available</div>
      )}
    </Box>
  );
}