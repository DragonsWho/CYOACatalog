// src/components/CyoaPage/GameDetails.tsx
// v4.1
// Fixed TypeScript errors and improved type safety

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress, Grid2, Paper, Theme } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import SimpleComments from './SimpleComments';
import GameAdditionalInfo from './GameAdditionalInfo';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

interface CustomTheme extends Theme {
  custom?: {
    borderRadius?: string;
    boxShadow?: string;
    comments?: {
      backgroundColor?: string;
      borderRadius?: string;
    };
  };
}

export default function GameDetails() {
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [expanded, setExpanded] = useState<boolean>(false);
  const { id } = useParams<{ id: string }>();
  const theme = useTheme<CustomTheme>();
  const sanitizedDescription = useMemo(() => (game ? DOMPurify.sanitize(game.description) : ''), [game]);

  useEffect(() => {
    (async () => {
      const game = await gamesCollection.getOne(id as string, {
        expand: 'tags.tag_categories_via_tags,authors_via_games,comments.author',
      });
      setGame(game);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <CircularProgress />;
  if (!game) return <Typography>Game not found</Typography>;

  return (
    <Container maxWidth="lg" disableGutters>
      <Paper
        elevation={3}
        sx={{
          p: 2,
          mb: 0,
          bgcolor: theme.palette.background.paper,
          color: theme.palette.common.white,
        }}
      >
        <Box
          sx={{
            mb: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
          }}
        >
          <Typography variant="h4" component="h1" sx={{ mr: 1, color: theme.palette.text.primary }}>
            {game.title || 'Untitled Game'}
          </Typography>
          {game.expand?.authors_via_games?.length && game.expand.authors_via_games?.length > 0 && (
            <Typography variant="subtitle1" sx={{ mb: '0.05em', color: theme.palette.text.primary }}>
              by {game.expand.authors_via_games.map((author) => author.name).join(', ')}
            </Typography>
          )}
        </Box>

        <Grid2 container spacing={3}>
          {/* Left Column - Image */}
          <Grid2 size={{ xs: 12, md: 6 }}>
            {game.image && (
              <Box
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <img
                  src={`/api/files/games/${game.id}/${game.image}`}
                  alt={game.title}
                  style={{ maxWidth: '60%', height: 'auto', objectFit: 'contain' }}
                />
              </Box>
            )}
          </Grid2>

          {/* Right Column - Game Info */}
          <Grid2 size={{ xs: 12, md: 6 }}>
            {game.expand?.tags?.length && game.expand.tags?.length > 0 && (
              <Box>
                <TagDisplay
                  tags={game.expand.tags}
                  chipProps={{
                    size: 'small',
                    sx: {
                      // @ts-expect-error custom theme property
                      bgcolor: theme.palette.grey[800],
                      color: theme.palette.text.primary,
                      '&:hover': {
                        bgcolor: theme.palette.grey[700],
                      },
                    },
                  }}
                />
              </Box>
            )}

            <GameAdditionalInfo
              gameId={id as string}
              upvotes={game.upvotes}
              expanded={expanded}
              onExpand={() => setExpanded(!expanded)}
            />
          </Grid2>
        </Grid2>

        <Box sx={{ mt: 1 }}>
          <Typography variant="h6" gutterBottom textAlign="center" sx={{ color: theme.palette.text.primary }}>
            Description
          </Typography>
          <div
            style={{ paddingLeft: 12, paddingRight: 12, color: theme.palette.text.primary }}
            dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
          />
        </Box>
      </Paper>

      <Box
        sx={{
          mb: 3,
          mt: 3,
          borderRadius: theme.custom?.borderRadius,
          boxShadow: theme.custom?.boxShadow,
          overflow: expanded ? 'visible' : 'hidden',
          transition: 'all 0.3s ease',
        }}
      >
        <GameContent game={game} expanded={expanded} onExpand={() => setExpanded(!expanded)} />
      </Box>

      <Box sx={{}}>
        <SimpleComments game={game} />
      </Box>
    </Container>
  );
}
