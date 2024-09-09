// src/components/GameCard.jsx
// v3.5
// Implemented tag caching

import { Card, CardContent, Typography, Chip, Box, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game } from '../pocketbase/pocketbase';

// Design variables
const CARD_ASPECT_RATIO = '133.33%'; // 3:4 aspect ratio
const TITLE_FONT_SIZE = '1.5rem';
const DESCRIPTION_TOP = '60%';
const TAG_SECTION_HEIGHT = '80px';
const TAG_DISPLAY_LIMIT = 12;
const OVERLAY_OPACITY = 0.5;

// Spacing variables
const CARD_PADDING = 16; // Default padding of CardContent
const TITLE_MARGIN_BOTTOM = 8;
const TAGS_MARGIN_BOTTOM = 8;
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

export default function GameCard({ game }: { game: Game }) {
  // TODO: sanitize description

  const theme = useTheme();
  const imageURL = game.image ? `/api/files/games/${game.id}/${game.image}` : '/img/placeholder.jpg';
  const sortedTags = CATEGORY_ORDER.flatMap((categoryName) => {
    return game.expand?.tags?.filter((tag) => tag.expand?.tag_categories_via_tags?.[0].name === categoryName) ?? [];
  }).slice(0, TAG_DISPLAY_LIMIT);
  const gameUpvoteCount = game.upvotes.length;

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
          <Typography
            variant="h3"
            component="div"
            align="center"
            sx={{
              fontWeight: 'bold',
              fontSize: TITLE_FONT_SIZE,
              // @ts-expect-error custom theme property
              ...theme.custom.cardTitle,
              mb: `${TITLE_MARGIN_BOTTOM}px`,
            }}
          >
            {game.title || 'Untitled'}
          </Typography>

          <Box sx={{ position: 'absolute', top: DESCRIPTION_TOP, left: CARD_PADDING, right: CARD_PADDING }}>
            <Typography
              variant="body2"
              sx={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                // @ts-expect-error custom theme property
                ...theme.custom.cardText,
              }}
            >
              {/* TODO: <p> cannot appear as a descendant of <p>. */}
              <p dangerouslySetInnerHTML={{ __html: game.description }} />
            </Typography>
          </Box>

          <Box sx={{ mt: 'auto' }}>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 0.5,
                mb: `${TAGS_MARGIN_BOTTOM}px`,
                height: TAG_SECTION_HEIGHT,
                overflow: 'hidden',
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
                      fontSize: '0.7rem',
                      backgroundColor: `${CATEGORY_COLORS[category as keyof typeof CATEGORY_COLORS] || 'transparent'}`,
                      color: theme.palette.text.primary,
                      textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                    }}
                  />
                );
              })}
            </Box>

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                mt: `${BOTTOM_INFO_MARGIN_TOP}px`,
                mb: `${BOTTOM_INFO_MARGIN_BOTTOM}px`,
              }}
            >
              <Typography
                variant="body2"
                sx={{
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
                <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                <Typography
                  variant="body2"
                  sx={{
                    color: 'white',
                    fontWeight: 'bold',
                    textShadow: '1px 1px 2px rgba(3,3,3,1)',
                    mr: 1,
                  }}
                >
                  {game.comments.length}
                </Typography>
                <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                <Typography
                  variant="body2"
                  sx={{
                    color: 'white',
                    fontWeight: 'bold',
                    textShadow: '1px 1px 2px rgba(3,3,3,1)',
                  }}
                >
                  {gameUpvoteCount}
                </Typography>
              </Box>
            </Box>
          </Box>
        </CardContent>
      </Card>
    </Link>
  );
}
