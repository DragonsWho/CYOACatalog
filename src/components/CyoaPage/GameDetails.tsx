// src/components/CyoaPage/GameDetails.tsx
import { useState, useEffect, useMemo } from 'react';
import { useParams, } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress, Grid2, Paper, Theme } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import SimpleComments from './SimpleComments';
import GameAdditionalInfo from './GameAdditionalInfo';
import {
  Game,
  gamesCollection,
  GameRelationship, // Тип теперь включает языки
  gameRelationshipsCollection,
  logFrontendError,
} from '../../pocketbase/pocketbase';
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
  // Массив будет содержать объекты GameRelationship с новыми полями языков
  const [relatedGames, setRelatedGames] = useState<GameRelationship[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const { id } = useParams<{ id: string }>();
  const theme = useTheme<CustomTheme>();
  const sanitizedDescription = useMemo(() => (game ? DOMPurify.sanitize(game.description) : ''), [game]);

  useEffect(() => {
    const fetchGameData = async () => {
      if (!id) {
          setLoading(false);
          console.error("Game ID is missing");
          return;
      };
      setLoading(true);
      setGame(null);
      setRelatedGames([]);

      try {
        const gamePromise = gamesCollection.getOne(id, {
          expand: 'tags.tag_categories_via_tags,authors_via_games,comments.author',
        });

        // Запрос связей. Новые поля (source_language, target_language)
        // будут получены автоматически, так как они часть самой записи relationship.
        const outgoingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `source_game = "${id}"`,
          expand: 'target_game', // Expand остается тем же
        }).catch(err => {
            console.error("Failed to fetch outgoing relationships:", err);
            logFrontendError("Fetch outgoing relationships failed", { gameId: id, error: err });
            return [];
        });

        const incomingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `target_game = "${id}"`,
          expand: 'source_game', // Expand остается тем же
        }).catch(err => {
            console.error("Failed to fetch incoming relationships:", err);
            logFrontendError("Fetch incoming relationships failed", { gameId: id, error: err });
            return [];
        });

        const [gameData, outgoingRelationships, incomingRelationships] = await Promise.all([
          gamePromise,
          outgoingRelationshipsPromise,
          incomingRelationshipsPromise,
        ]);

        setGame(gameData);
        const validOutgoing = Array.isArray(outgoingRelationships) ? outgoingRelationships : [];
        const validIncoming = Array.isArray(incomingRelationships) ? incomingRelationships : [];
        setRelatedGames([...validOutgoing, ...validIncoming]); // Здесь теперь будут объекты с языками

      } catch (error) {
        console.error('Ошибка при загрузке основной информации игры:', error);
        logFrontendError("Fetch game details failed", { gameId: id, error: error instanceof Error ? error.message : String(error) });
      } finally {
        setLoading(false);
      }
    };

    fetchGameData();
  }, [id]);

  if (loading) return <CircularProgress />;
  if (!game) return <Typography>Game not found or failed to load.</Typography>;

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

          <Grid2 size={{ xs: 12, md: 6 }}>
            {game.expand?.tags?.length && game.expand.tags?.length > 0 && (
              <Box>
                <TagDisplay
                  tags={game.expand.tags}
                  gameId={id as string}
                />
              </Box>
            )}
            <GameAdditionalInfo
              gameId={id as string}
              upvotes={game.upvotes}
              relatedGames={relatedGames} // Передаем связи с возможными языками
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

      <Box sx={{ mb: 3, mt: 3 }}>
        <GameContent game={game} />
      </Box>

      <Box sx={{}}>
        <SimpleComments game={game} />
      </Box>
    </Container>
  );
}