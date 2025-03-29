import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, Typography, Chip, Box, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

// Design variables
const CARD_ASPECT_RATIO = '133.33%'; 
const DESCRIPTION_TOP = '60%';
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

interface GameCardProps {
  game: Game;
  variant?: 'standard' | 'simplified';
}

function GameCard({ game, variant = 'standard' }: GameCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  
  useEffect(() => {
    console.log(`GameCard mount for game ${game.id}`);
    return () => {
      console.log(`GameCard unmount for game ${game.id}`);
    };
  }, [game.id]);
  
  const collectionId = game.collectionId || '5kxdvx071c10s2t';
  
  const imageURL = game.image 
    ? `/api/files/${collectionId}/${game.id}/${game.image}` 
    : 'public/placeholder.jpg';
  
  const [imageSrc, setImageSrc] = useState<string>(
    game.image_base64
      ? game.image_base64.startsWith('data:')
        ? game.image_base64
        : `data:image/jpeg;base64,${game.image_base64}` // Предполагаем JPEG для base64, можно уточнить формат
      : imageURL
  );
  const [isBase64, setIsBase64] = useState<boolean>(!!game.image_base64);

  const loadImage = useCallback(() => {
    if (!isBase64 && imageSrc === imageURL) return; // Если уже загружено основное изображение, ничего не делаем

    if (imageCache.has(imageURL)) {
      console.log(`Using cached image for game ${game.id}`);
      setImageSrc(imageCache.get(imageURL) as string);
      setIsBase64(false);
    } else {
      console.log(`Setting image URL for game ${game.id}`);
      setImageSrc(imageURL);
      setIsBase64(false);
    }
  }, [game.id, imageURL, imageSrc, isBase64]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadImage();
        }
      },
      { rootMargin: '200px', threshold: 0.01 }
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => observer.disconnect();
  }, [loadImage]);

  useEffect(() => {
    if (imgRef.current && imageSrc === imageURL && !imageCache.has(imageURL)) {
      imgRef.current.onload = () => {
        imageCache.set(imageURL, imageURL);
        console.log(`Cached image ${imageURL} for game ${game.id}`);
      };
    }
  }, [imageSrc, imageURL, game.id]);

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
        <img
          ref={imgRef}
          src={imageSrc}
          alt={game.title || 'Game image'}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
            transition: 'opacity 0.3s ease-in-out',
            filter: isBase64 ? 'blur(4px)' : 'none', // Размытие только для base64
          }}
        />
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
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
          <Typography
            variant="h3"
            component="div"
            align="center"
            sx={{
              fontWeight: 'bold',
              fontSize: { xs: '1.2rem', sm: '1.5rem', md: '1.8rem' },
              // @ts-expect-error custom theme property
              ...theme.custom.cardTitle,
              mb: `${TITLE_MARGIN_BOTTOM}px`,
            }}
          >
            {game.title || 'Untitled'}
          </Typography>

          {variant === 'standard' ? (
            <>
              <Box
                sx={{
                  position: 'absolute',
                  top: DESCRIPTION_TOP,
                  left: CARD_PADDING,
                  right: CARD_PADDING,
                  bottom: `calc(${TAG_SECTION_HEIGHT} + ${BOTTOM_INFO_MARGIN_TOP + BOTTOM_INFO_MARGIN_BOTTOM + 40}px)`,
                  overflow: 'hidden',
                  fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' },
                  maskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                  // @ts-expect-error custom theme property
                  ...theme.custom.cardText,
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: sanitizedDescription }} />
              </Box>

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
                    fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.8rem' },
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
                fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                // @ts-expect-error custom theme property
                ...theme.custom.cardText,
                textShadow: '1px 1px 3px rgba(3, 3, 3, 1)',
              }}
            >
              {game.expand?.authors_via_games && game.expand?.authors_via_games.length > 0
                ? game.expand?.authors_via_games[0].name
                : 'Anonymous'}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
              <Typography
                variant="body2"
                sx={{
                  fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
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
                  fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
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

export default React.memo(GameCard, (prevProps, nextProps) => {
  return prevProps.game.id === nextProps.game.id && 
         prevProps.variant === nextProps.variant;
});