// src/components/Profile/BlockedGamesSettings.tsx
import { useState, useEffect, useContext } from 'react';
import { Box, Typography, Chip, CircularProgress, Alert, Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { User, pb, usersCollection, gamesCollectionPublic, AuthContext, gameCanonicalKey } from '../../pocketbase/pocketbase';

interface BlockedGamesSettingsProps {
  blockedGameIds: string[];
  onBlockedGamesUpdate: () => void;
}

type GameLite = { id: string; slug?: string; title: string };

export default function BlockedGamesSettings({ blockedGameIds, onBlockedGamesUpdate }: BlockedGamesSettingsProps) {
  const { user }: { user: User | null } = useContext(AuthContext);
  const [games, setGames] = useState<GameLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Подтягиваем ТОЛЬКО id+title для показа (payload-discipline). Тянем анонимным
  // кэшируемым клиентом, как и весь каталог. Фильтр — по актуальному списку id.
  useEffect(() => {
    if (blockedGameIds.length === 0) {
      setGames([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const filter = blockedGameIds.map((id) => `id = "${id}"`).join(' || ');
    gamesCollectionPublic
      .getFullList({ filter, fields: 'id,slug,title' })
      .then((res) => {
        if (cancelled) return;
        // Сохраняем порядок как в blockedGameIds (свежескрытые сверху не гарантируем,
        // но стабильный порядок приятнее «прыгающего» по created).
        const byId = new Map(res.map((g) => [g.id, g.title as string]));
        setGames(blockedGameIds.filter((id) => byId.has(id)).map((id) => ({ id, title: byId.get(id) || id })));
      })
      .catch((err) => {
        if (!cancelled) setError(`Failed to load hidden games: ${err?.message || 'Unknown error'}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [blockedGameIds]);

  const handleRemove = async (gameId: string) => {
    if (!user || removingId) return;
    setRemovingId(gameId);
    setError(null);
    try {
      await usersCollection.update(user.id, { 'blocked_games-': gameId });
      await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
      onBlockedGamesUpdate();
    } catch (err: any) {
      console.error('Error un-hiding game:', err);
      setError(`Failed to un-hide game: ${err?.message || 'Unknown error'}`);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Games you've hidden are removed from your home page, search, and “similar” lists – as if they
        don't exist. Only you see this list. Remove a game here to make it show up again.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2, py: 0.5 }}>
          {error}
        </Alert>
      )}

      {loading && games.length === 0 ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <CircularProgress size={20} />
          <Typography variant="body2" color="text.secondary">
            Loading…
          </Typography>
        </Box>
      ) : blockedGameIds.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          You haven't hidden any games yet.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {games.map((g) => (
            <Chip
              key={g.id}
              label={
                <Link
                  component={RouterLink}
                  to={`/game/${gameCanonicalKey(g)}`}
                  underline="hover"
                  color="inherit"
                  onClick={(e) => e.stopPropagation()}
                >
                  {g.title || g.id}
                </Link>
              }
              variant="outlined"
              onDelete={() => handleRemove(g.id)}
              disabled={removingId === g.id}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}
