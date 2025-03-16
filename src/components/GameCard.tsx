import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, Typography, Chip, Box, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

// Design variables
const CARD_ASPECT_RATIO = '133.33%'; // 3:4 aspect ratio 
const DESCRIPTION_TOP = '60%'; // Базовая позиция для описания
const TAG_SECTION_HEIGHT = '80px';
const TAG_DISPLAY_LIMIT = 12;
const OVERLAY_OPACITY = 0.5;

// Spacing variables
const CARD_PADDING = 16;
const TITLE_MARGIN_BOTTOM = 8;
const TAGS_MARGIN_TOP = 8; 
const BOTTOM_INFO_MARGIN_TOP = 8;
const BOTTOM_INFO_MARGIN_BOTTOM = 0;

const CATEGORY_ORDER = [
  'Rating',
  'Interactivity',
  'POV',
  'Player Sexual Role',
  'Playtime',
  'Status',
  'Genre',
  'Setting',
  'Tone',
  'Extra',
  'Kinks',
];

const CATEGORY_COLORS = {
  Rating: 'rgba(0, 0, 0, 0.4)',
  Interactivity: 'rgba(0, 0, 0, 0.4)',
  POV: 'rgba(0, 0, 0, 0.4)',
  'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
  Playtime: 'rgba(255, 140, 0, 0.4)',
  Status: 'rgba(0, 0, 0, 0.4)',
  Genre: 'rgba(138, 43, 226, 0.4)',
  Setting: 'rgba(0, 0, 0, 0.4)',
  Tone: 'rgba(0, 0, 0, 0.4)',
  Extra: 'rgba(0, 0, 0, 0.4)',
  Kinks: 'rgba(255, 69, 0, 0.4)',
};

// Global image cache
const imageCache = new Map<string, string>();

// Helper function to preload an image
const preloadImage = (url: string): Promise<string> => {
  if (imageCache.has(url)) {
    return Promise.resolve(imageCache.get(url) as string);
  }
  
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(url, url);
      resolve(url);
    };
    img.onerror = reject;
    img.src = url;
  });
};

interface GameCardProps {
  game: Game;
  variant?: 'standard' | 'simplified';
}

function GameCard({ game, variant = 'standard' }: GameCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  
  // Отладочный useEffect для отслеживания жизненного цикла компонента
  useEffect(() => {
    console.log(`GameCard mount for game ${game.id}`);
    return () => {
      console.log(`GameCard unmount for game ${game.id}`);
    };
  }, [game.id]);
  
  const collectionId = game.collectionId || '5kxdvx071c10s2t';
  
  // Формируем URL для WebP изображения
  const webpURL = game.image 
    ? `/api/files/${collectionId}/${game.id}/${game.image}` 
    : 'public/placeholder.jpg';
    
  // Формируем URL для AVIF изображения
  const avifURL = game.image_preview 
    ? `/api/files/${collectionId}/${game.id}/${game.image_preview}` 
    : null;
  
  // Изначально устанавливаем base64, если есть, иначе пустая строка
  const [imageSrc, setImageSrc] = useState<string>(
    game.image_base64
      ? game.image_base64.startsWith('data:')
        ? game.image_base64
        : `data:image/avif;base64,${game.image_base64}`
      : ''
  );
  
  // Флаг для отслеживания загрузки изображений
  const [imagesLoaded, setImagesLoaded] = useState<boolean>(false);

  // Мемоизированная функция загрузки изображений для избежания пересоздания
  const loadImages = useCallback(async (): Promise<void> => {
    console.log(`Loading images for game ${game.id}, already loaded: ${imagesLoaded}`);
    
    // Флаг для предотвращения обновления размонтированного компонента
    let isMounted = true;
    
    // Начинаем с base64, если доступен
    if (game.image_base64 && isMounted) {
      const base64Data = game.image_base64.startsWith('data:') 
        ? game.image_base64 
        : `data:image/avif;base64,${game.image_base64}`;
      setImageSrc(base64Data);
    }
    
    try {
      // Проверяем кэш для preview изображения
      if (avifURL && isMounted) {
        if (imageCache.has(avifURL)) {
          console.log(`Using cached AVIF for game ${game.id}`);
          setImageSrc(imageCache.get(avifURL) as string);
        } else {
          try {
            console.log(`Loading AVIF for game ${game.id}`);
            const url = await preloadImage(avifURL);
            if (isMounted) setImageSrc(url);
          } catch (error) {
            console.log(`GameCard: Failed to load AVIF for game ${game.id}, using WebP`);
          }
        }
      }
      
      // Затем загружаем полное WebP изображение
      if (webpURL && isMounted) {
        if (imageCache.has(webpURL)) {
          console.log(`Using cached WebP for game ${game.id}`);
          setImageSrc(imageCache.get(webpURL) as string);
        } else {
          try {
            console.log(`Loading WebP for game ${game.id}`);
            const url = await preloadImage(webpURL);
            if (isMounted) setImageSrc(url);
          } catch (error) {
            console.error(`GameCard: Failed to load WebP for game ${game.id}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error loading images for game ${game.id}:`, error);
    }
  }, [game.id, game.image_base64, avifURL, webpURL, imagesLoaded]);

  // Оптимизированная загрузка изображений с использованием intersection observer
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !imagesLoaded) {
        loadImages().catch(err => console.error("Error in loadImages:", err));
        setImagesLoaded(true);
      }
    }, {
      rootMargin: '200px', // Предзагрузка при приближении на 200px
      threshold: 0.01
    });
    
    if (cardRef.current) {
      observer.observe(cardRef.current);
    }
    
    return () => observer.disconnect();
  }, [imagesLoaded, loadImages]);

  const sortedTags = useMemo(() => {
    return CATEGORY_ORDER.flatMap((categoryName) =>
      game.expand?.tags?.filter((tag) => tag.expand?.tag_categories_via_tags?.[0].name === categoryName) ?? []
    ).slice(0, TAG_DISPLAY_LIMIT);
  }, [game.expand?.tags]);
  
  const gameUpvoteCount = game.upvotes.length;
  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description), [game.description]);

  return (
    <Link to={`/game/${game.id}`} style={{ textDecoration: 'none' }}>
      <Card
        ref={cardRef}
        sx={{
          cursor: 'pointer',
          transition: '0.3s',
          '&:hover': { transform: 'scale(1.03)' },
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: theme.palette.background.paper,
          paddingTop: CARD_ASPECT_RATIO,
          boxShadow: theme.shadows[3],
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundImage: imageSrc ? `url(${imageSrc})` : 'none',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            transition: 'opacity 0.3s ease-in-out',
            '&::after': {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
            },
          }}
        />
        <CardContent
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            p: `${CARD_PADDING}px`,
            boxSizing: 'border-box',
          }}
        >
          {/* Заголовок с адаптивным размером шрифта */}
          <Typography
            variant="h3"
            component="div"
            align="center"
            sx={{
              fontWeight: 'bold',
              fontSize: {
                xs: '1.2rem',
                sm: '1.5rem',
                md: '1.8rem',
              },
              // @ts-expect-error custom theme property
              ...theme.custom.cardTitle,
              mb: `${TITLE_MARGIN_BOTTOM}px`,
            }}
          >
            {game.title || 'Untitled'}
          </Typography>

          {/* Описание и теги в стандартном виде */}
          {variant === 'standard' ? (
            <>
              {/* Описание с текстовыми эффектами */}
              <Box
                sx={{
                  position: 'absolute',
                  top: DESCRIPTION_TOP,
                  left: CARD_PADDING,
                  right: CARD_PADDING,
                  bottom: `calc(${TAG_SECTION_HEIGHT} + ${BOTTOM_INFO_MARGIN_TOP + BOTTOM_INFO_MARGIN_BOTTOM + 40}px)`,
                  overflow: 'hidden',
                  fontSize: {
                    xs: '0.8rem',
                    sm: '0.9rem',
                    md: '1rem',
                  },
                  maskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                  // @ts-expect-error custom theme property
                  ...theme.custom.cardText,
                }}
              >
                <div
                  dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
                />
              </Box>

              {/* Секция тегов */}
              <Box
                sx={{
                  position: 'absolute',
                  bottom: `calc(${BOTTOM_INFO_MARGIN_TOP + BOTTOM_INFO_MARGIN_BOTTOM + 30}px)`,
                  left: CARD_PADDING,
                  right: CARD_PADDING,
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 0.5,
                    maxHeight: TAG_SECTION_HEIGHT,
                    overflow: 'hidden',
                    mt: `${TAGS_MARGIN_TOP}px`,
                    fontSize: {
                      xs: '0.6rem',
                      sm: '0.7rem',
                      md: '0.8rem',
                    },
                  }}
                >
                  {sortedTags.map((tag, index) => {
                    const category = tag.expand?.tag_categories_via_tags?.[0].name;
                    return (
                      <Chip
                        key={index}
                        label={tag.name}
                        size="small"
                        sx={{
                          backgroundColor: `${
                            CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS] || 'transparent'
                          }`,
                          color: theme.palette.text.primary,
                          textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                        }}
                      />
                    );
                  })}
                </Box>
              </Box>
            </>
          ) : null}

          {/* Информация снизу с адаптивным размером шрифта */}
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              position: 'absolute',
              bottom: CARD_PADDING,
              left: CARD_PADDING,
              right: CARD_PADDING,
            }}
          >
            <Typography
              variant="body2"
              sx={{
                fontSize: {
                  xs: '0.7rem',
                  sm: '0.8rem',
                  md: '0.9rem',
                },
                // @ts-expect-error custom theme property
                ...theme.custom.cardText,
                textShadow: '1px 1px 3px rgba(3, 3, 3, 1)',
              }}
            >
              {game.expand?.authors_via_games && game.expand?.authors_via_games.length > 0
                ? game.expand?.authors_via_games[0].name
                : 'Anonymous'}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
              <Typography
                variant="body2"
                sx={{
                  fontSize: {
                    xs: '0.7rem',
                    sm: '0.8rem',
                    md: '0.9rem',
                  },
                  color: 'white',
                  fontWeight: 'bold',
                  textShadow: '1px 1px 2px rgba(3,3,3,1)',
                  mr: 1,
                }}
              >
                {game.comments.length}
              </Typography>
              <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
              <Typography
                variant="body2"
                sx={{
                  fontSize: {
                    xs: '0.7rem',
                    sm: '0.8rem',
                    md: '0.9rem',
                  },
                  color: 'white',
                  fontWeight: 'bold',
                  textShadow: '1px 1px 2px rgba(3,3,3,1)',
                }}
              >
                {gameUpvoteCount}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Link>
  );
}

// Используем React.memo для предотвращения лишних рендеров
export default React.memo(GameCard, (prevProps, nextProps) => {
  // Оптимизация: перерисовываем только если изменились критические свойства
  return prevProps.game.id === nextProps.game.id && 
         prevProps.variant === nextProps.variant;
});