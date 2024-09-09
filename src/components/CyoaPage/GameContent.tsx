// src/components/CyoaPage/GameContent.tsx
// v2.5
// Fixed TypeScript errors and improved type safety

import React, { useState, useEffect } from 'react';
import { Game } from '../../pocketbase/pocketbase';

interface ImageSizes {
  [key: number]: {
    width: number;
    height: number;
  };
}

export default function GameContent({
  game,
  expanded,
  onExpand,
}: {
  game: Game;
  expanded: boolean;
  onExpand: (expanded: boolean) => void;
}) {
  const [imageErrors, setImageErrors] = useState<{ [key: number]: boolean }>({});
  const [imageSizes, setImageSizes] = useState<ImageSizes>({});
  const [iframeStyle, setIframeStyle] = useState<React.CSSProperties>({});
  const [loadingImages, setLoadingImages] = useState(game.cyoa_pages.length || 0);

  useEffect(() => {
    if (game.img_or_link === 'link') {
      if (expanded) {
        setIframeStyle({
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          zIndex: 9999,
        });
      } else {
        setIframeStyle({
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
        });
      }
    }
  }, [expanded, game.img_or_link]);

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

  const collapseButtonStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    zIndex: 10000,
    padding: '10px 20px',
    backgroundColor: '#007bff',
    color: 'white',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
  };

  return (
    <div style={{ backgroundColor: '#121212' }}>
      {game.img_or_link === 'img' && game.cyoa_pages.length ? (
        <div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '1rem',
              transition: 'all 0.3s ease',
            }}
          >
            {loadingImages > 0 && <div>Loading...</div>}
            {game.cyoa_pages.map((image, index) => (
              <div
                key={index}
                style={{
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
                      maxWidth: expanded ? 'none' : '100%',
                      width: expanded ? 'auto' : imageSizes[index]?.width > window.innerWidth ? '100%' : 'auto',
                      height: 'auto',
                      display: loadingImages > 0 ? 'none' : 'block',
                      transition: 'all 0.3s ease',
                    }}
                    onLoad={(event) => handleImageLoad(index, event)}
                    onError={() => handleImageError(index)}
                  />
                )}
                {imageErrors[index] && <div style={{ color: 'red' }}>Failed to load image {index + 1}</div>}
              </div>
            ))}
          </div>
        </div>
      ) : game.img_or_link === 'link' && game.iframe_url ? (
        <div
          style={{
            width: '100%',
            height: 0,
            paddingBottom: expanded ? '0' : '56.25%', // 16:9 aspect ratio when not expanded
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <iframe src={game.iframe_url} style={iframeStyle} title="Game content" allowFullScreen loading="lazy" />
          {expanded && (
            <button style={collapseButtonStyle} onClick={() => onExpand(false)}>
              Collapse
            </button>
          )}
        </div>
      ) : (
        <div>No game content available</div>
      )}
    </div>
  );
}
