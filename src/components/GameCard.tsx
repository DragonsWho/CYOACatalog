// src/components/GameCard.tsx
// v4.0
// Improved responsiveness: dynamic description height and larger font on wide screens

import { Card, CardContent, Typography, Chip, Box, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';
import { useMemo } from 'react';

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

export default function GameCard({
  game,
  variant = 'standard',
}: {
  game: Game;
  variant?: 'standard' | 'simplified';
}) {
  const theme = useTheme();
  const imageURL = game.image ? `/api/files/games/${game.id}/${game.image}` : '/img/placeholder.jpg';
  const sortedTags = CATEGORY_ORDER.flatMap((categoryName) =>
    game.expand?.tags?.filter((tag) => tag.expand?.tag_categories_via_tags?.[0].name === categoryName) ?? []
  ).slice(0, TAG_DISPLAY_LIMIT);
  const gameUpvoteCount = game.upvotes.length;
  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description), [game.description]);

  return (
    <Link to={`/game/${game.id}`} style={{ textDecoration: 'none' }}>
      <Card
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
            backgroundImage: `url(${imageURL})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
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
                xs: '1.2rem', // Меньше на маленьких экранах
                sm: '1.5rem', // Базовый размер
                md: '1.8rem', // Больший размер на широких экранах
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
                  // Добавляем эффект затухания текста внизу
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
                  xs: '0.7rem', // Меньше на маленьких экранах
                  sm: '0.8rem', // Базовый размер
                  md: '0.9rem', // Больший размер на широких экранах
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
                    xs: '0.7rem', // Меньше на маленьких экранах
                    sm: '0.8rem', // Базовый размер
                    md: '0.9rem', // Больший размер на широких экранах
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
                    xs: '0.7rem', // Меньше на маленьких экранах
                    sm: '0.8rem', // Базовый размер
                    md: '0.9rem', // Больший размер на широких экранах
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