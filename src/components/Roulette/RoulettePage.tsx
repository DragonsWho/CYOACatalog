// Публичная страница рулетки бампов (/roulette). Только чтение публичной
// статистики (GET /api/custom/bump/stats): обратный отсчёт до розыгрыша, текущие
// стендинги (игры по числу билетов) и последние победители. Анонимно-дружелюбна.

import { useState, useEffect } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Container,
  Typography,
  Paper,
  List,
  ListItemButton,
  ListItemAvatar,
  Avatar,
  ListItemText,
  Chip,
  Divider,
  CircularProgress,
  Alert,
} from '@mui/material';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import EmojiEventsOutlinedIcon from '@mui/icons-material/EmojiEventsOutlined';
import { getBumpStats, type BumpStats, type BumpStanding, type BumpWinner } from '../../pocketbase/bumpRouletteApi';
import { gameCanonicalKey } from '../../pocketbase/pocketbase';
import { cfImage } from '../../utils/cfImage';
import { formatCountdown, formatDate } from './bumpTime';

function coverUrl(s: { id: string; image: string }): string {
  if (!s.image) return '';
  const path = `/api/files/games/${s.id}/${s.image}`;
  return cfImage(path, { width: 96, quality: 70 });
}

function StandingRow({ s, rank }: { s: BumpStanding; rank: number }) {
  const url = coverUrl(s);
  return (
    <ListItemButton component={RouterLink} to={`/game/${gameCanonicalKey(s)}`} sx={{ borderRadius: 1 }}>
      <Typography variant="body2" sx={{ width: 28, color: 'text.secondary', fontWeight: 700 }}>
        {rank}
      </Typography>
      <ListItemAvatar>
        <Avatar
          variant="rounded"
          src={url || undefined}
          sx={{ width: 48, height: 48, filter: s.nsfw ? 'blur(6px)' : 'none' }}
        />
      </ListItemAvatar>
      <ListItemText
        primary={s.title || 'Untitled'}
        primaryTypographyProps={{ noWrap: true, sx: { maxWidth: { xs: 180, sm: 360 } } }}
      />
      <Chip
        icon={<ConfirmationNumberOutlinedIcon />}
        label={s.tickets}
        size="small"
        color="secondary"
        variant="outlined"
      />
    </ListItemButton>
  );
}

function WinnerRow({ w }: { w: BumpWinner }) {
  const url = coverUrl(w);
  return (
    <ListItemButton component={RouterLink} to={`/game/${gameCanonicalKey(w)}`} sx={{ borderRadius: 1 }}>
      <ListItemAvatar>
        <Avatar variant="rounded" src={url || undefined} sx={{ width: 40, height: 40 }} />
      </ListItemAvatar>
      <ListItemText
        primary={w.title || 'Untitled'}
        secondary={`${formatDate(w.drawn_at)} · ${w.ticket_count}/${w.total_tickets} tickets`}
        primaryTypographyProps={{ noWrap: true, sx: { maxWidth: { xs: 180, sm: 360 } } }}
      />
    </ListItemButton>
  );
}

export default function RoulettePage() {
  const [stats, setStats] = useState<BumpStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBumpStats()
      .then((s) => !cancelled && setStats(s))
      .catch((e) => !cancelled && setError(e?.message || 'Failed to load'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700 }}>
          🎲 Bump roulette
        </Typography>
      </Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
        Vote for the games you want bumped to the top of the catalog. Every vote is a raffle ticket —
        once a day one game is drawn at random (more tickets, better odds) and bumped for everyone.
      </Typography>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      )}
      {error && <Alert severity="error">{error}</Alert>}

      {stats && (
        <>
          <Paper variant="outlined" sx={{ p: 2, mb: 3, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            <Box>
              <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                Next draw
              </Typography>
              <Typography variant="h6">
                {stats.enabled ? formatCountdown(stats.next_draw_at) || '—' : 'Paused'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="overline" sx={{ color: 'text.secondary' }}>
                Tickets in the pool
              </Typography>
              <Typography variant="h6">{stats.pool_tickets}</Typography>
            </Box>
          </Paper>

          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <ConfirmationNumberOutlinedIcon fontSize="small" /> Standings
          </Typography>
          <Paper variant="outlined" sx={{ mb: 3 }}>
            {stats.standings.length === 0 ? (
              <Typography variant="body2" sx={{ color: 'text.secondary', p: 2 }}>
                No votes yet — be the first to give a game a ticket.
              </Typography>
            ) : (
              <List disablePadding>
                {stats.standings.map((s, i) => (
                  <StandingRow key={s.id} s={s} rank={i + 1} />
                ))}
              </List>
            )}
          </Paper>

          {stats.winners.length > 0 && (
            <>
              <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <EmojiEventsOutlinedIcon fontSize="small" /> Recent winners
              </Typography>
              <Paper variant="outlined">
                <List disablePadding>
                  {stats.winners.map((w, i) => (
                    <Box key={`${w.id}-${w.drawn_at}`}>
                      {i > 0 && <Divider component="li" />}
                      <WinnerRow w={w} />
                    </Box>
                  ))}
                </List>
              </Paper>
            </>
          )}
        </>
      )}
    </Container>
  );
}
