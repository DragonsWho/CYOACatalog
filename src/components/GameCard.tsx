// src/components/GameCard.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, Typography, Chip, Box } from '@mui/material'; 
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment'; 
import { Game } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

import { useTheme } from '@mui/material/styles';

 


// Design variables
const CARD_ASPECT_RATIO = '133.33%'; // 4:3 aspect ratio
const TAG_SECTION_HEIGHT = '80px';
const TAG_DISPLAY_LIMIT = 12;
const OVERLAY_OPACITY = 0.5;

// Spacing variables
const CARD_PADDING = 16;
const TITLE_MARGIN_BOTTOM = 8;
const TAGS_MARGIN_TOP = 8;
const BOTTOM_INFO_MARGIN_TOP = 8;

const CATEGORY_ORDER = [
  'Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime',
  'Status', 'Genre', 'Setting', 'Tone', 'Extra', 'Kinks',
];

const CATEGORY_COLORS: Record<string, string> = {
  Rating: 'rgba(0, 0, 0, 0.4)', Interactivity: 'rgba(0, 0, 0, 0.4)',
  POV: 'rgba(0, 0, 0, 0.4)', 'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
  Playtime: 'rgba(255, 140, 0, 0.4)', Status: 'rgba(0, 0, 0, 0.4)',
  Genre: 'rgba(138, 43, 226, 0.4)', Setting: 'rgba(0, 0, 0, 0.4)',
  Tone: 'rgba(0, 0, 0, 0.4)', Extra: 'rgba(0, 0, 0, 0.4)',
  Kinks: 'rgba(255, 69, 0, 0.4)',
};

// Global image cache
const imageCache = new Map<string, string>();

interface GameCardProps {
  game: Game;
  variant?: 'standard' | 'simplified';
}

function GameCard({ game, variant = 'standard' }: GameCardProps) {
  const theme = useTheme(); // Тип theme теперь включает наш custom
  const cardRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const imageURL = game.image
    ? `/api/files/${collectionId}/${game.id}/${game.image}`
    : 'public/placeholder.jpg';

  const [imageSrc, setImageSrc] = useState<string>(
    game.image_base64
      ? game.image_base64.startsWith('data:')
        ? game.image_base64
        : `data:image/jpeg;base64,${game.image_base64}`
      : imageURL
  );
  const [isBase64, setIsBase64] = useState<boolean>(!!game.image_base64);

  const loadImage = useCallback(() => {
    if ((!isBase64 && imageSrc === imageURL) || !imageURL || imageURL === 'public/placeholder.jpg') return;

    if (imageCache.has(imageURL)) {
      if (cardRef.current) { // Проверка на размонтирование
        setImageSrc(imageCache.get(imageURL) as string);
        setIsBase64(false);
      }
    } else {
      const img = new Image();
      img.onload = () => {
        imageCache.set(imageURL, imageURL);
        if (cardRef.current) {
             setImageSrc(imageURL);
             setIsBase64(false);
        }
      };
      img.onerror = () => {
         console.error(`Failed to load image ${imageURL}, keeping base64/placeholder.`);
         if (!game.image_base64 && cardRef.current) {
             setImageSrc('public/placeholder.jpg');
             setIsBase64(false);
         }
      };
      img.src = imageURL;
    }
  }, [game.image_base64, imageURL, imageSrc, isBase64]); // game.id не нужен

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadImage();
          if (cardRef.current) observer.unobserve(cardRef.current);
        }
      },
      { rootMargin: '200px', threshold: 0.01 }
    );

    const currentCardRef = cardRef.current;
    if (currentCardRef) {
      observer.observe(currentCardRef);
    }

    return () => {
      if (currentCardRef) observer.unobserve(currentCardRef);
      observer.disconnect();
    };
  }, [loadImage]);

  const sortedTags = useMemo(() => {
     const tagsToSort = game.expand?.tags ?? [];
     const validTags = tagsToSort.filter(tag => tag?.expand?.tag_categories_via_tags?.[0]?.name);
     return CATEGORY_ORDER.flatMap((categoryName) =>
       validTags.filter((tag) => tag.expand!.tag_categories_via_tags![0].name === categoryName)
     ).slice(0, TAG_DISPLAY_LIMIT);
  }, [game.expand?.tags]);

  const gameUpvoteCount = game.upvotes_count ?? 0;
  const gameCommentCount = game.comments_count ?? 0;

  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description ?? ''), [game.description]);

  return (
    <Link to={`/game/${game.id}`} style={{ textDecoration: 'none' }}>
      <Card
        ref={cardRef}
        sx={{
          cursor: 'pointer',
          transition: 'transform 0.3s ease-in-out',
          '&:hover': { transform: 'scale(1.03)' },
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: theme.palette.background.paper,
          paddingTop: CARD_ASPECT_RATIO,
          boxShadow: theme.shadows[3],
          height: 0,
        }}
      >
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
          <img
            ref={imgRef}
            src={imageSrc}
            alt={game.title || 'Game image'}
            loading="lazy"
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              objectFit: 'cover', objectPosition: 'center',
              transition: 'opacity 0.3s ease-in-out, filter 0.3s ease-in-out',
              filter: isBase64 ? 'blur(4px)' : 'none',
            }}
          />
          <Box sx={{ /* Оверлей */ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})` }} />
          <CardContent sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', p: `${CARD_PADDING}px`, boxSizing: 'border-box', '&:last-child': { paddingBottom: `${CARD_PADDING}px` } }} >
            {/* Заголовок */}
            <Typography variant="h3" component="div" align="center" sx={{ fontWeight: 'bold', fontSize: { xs: '1.2rem', sm: '1.5rem', md: '1.8rem' },
                // Убрали @ts-expect-error
                ...(theme.custom?.cardTitle ?? {}), // Используем ?. и ?? {} для безопасности
                mb: `${TITLE_MARGIN_BOTTOM}px`, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', }} >
              {game.title || 'Untitled'}
            </Typography>

            {/* Описание и Теги (standard variant) */}
            {variant === 'standard' && (
              <Box sx={{ flexGrow: 1, overflow: 'hidden', position: 'relative', minHeight: '50px' }}>
                {/* Описание */}
                <Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: `calc(${TAG_SECTION_HEIGHT} + ${TAGS_MARGIN_TOP}px)`, overflow: 'hidden', fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' }, maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                     // Убрали @ts-expect-error
                     ...(theme.custom?.cardText ?? {}), // Используем ?. и ?? {}
                     }} >
                  <div dangerouslySetInnerHTML={{ __html: sanitizedDescription }} />
                </Box>
                {/* Теги */}
                <Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, mt: `${TAGS_MARGIN_TOP}px`, maxHeight: TAG_SECTION_HEIGHT, overflow: 'hidden', }} >
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.8rem' } }} >
                    {sortedTags.map((tag) => {
                      const category = tag.expand?.tag_categories_via_tags?.[0].name;
                      return ( <Chip key={tag.id} label={tag.name} size="small" sx={{ backgroundColor: `${CATEGORY_COLORS[category ?? ''] || 'transparent'}`, color: theme.palette.text.primary, textShadow: '1px 1px 2px rgba(0,0,0,0.5)', }} /> );
                    })}
                  </Box>
                </Box>
              </Box>
            )}

            {/* Автор и Счетчики */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: variant !== 'standard' ? 'auto' : `${BOTTOM_INFO_MARGIN_TOP}px`, }} >
              <Typography variant="body2" sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                    // Убрали @ts-expect-error
                    ...(theme.custom?.cardText ?? {}), // Используем ?. и ?? {}
                    textShadow: '1px 1px 3px rgba(3, 3, 3, 1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '50%', }} >
                {game.expand?.authors_via_games?.[0]?.name || 'Anonymous'}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                <Typography variant="body2" sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' }, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', mr: 1, }} >
                  {gameCommentCount}
                </Typography>
                <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                <Typography variant="body2" sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' }, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', }} >
                  {gameUpvoteCount}
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Box>
      </Card>
    </Link>
  );
}

// Обновляем React.memo для включения comments_count
export default React.memo(GameCard, (prevProps, nextProps) => {
    return prevProps.game.id === nextProps.game.id &&
           prevProps.variant === nextProps.variant &&
           prevProps.game.upvotes_count === nextProps.game.upvotes_count &&
           prevProps.game.comments_count === nextProps.game.comments_count;
});