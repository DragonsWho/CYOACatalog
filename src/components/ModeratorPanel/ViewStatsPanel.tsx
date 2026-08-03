// src/components/ModeratorPanel/ViewStatsPanel.tsx
//
// Страница /moderator/stats — первый-парти счётчик просмотров игр.
// Бэкенд: view_counter.go (коллекция game_views + /api/custom/mod/game-views).
//
// ЗАЧЕМ отдельно от Google Analytics: на NSFW-аудитории адблок режет заметную
// долю GA-хитов, а same-origin пинг в нашу же БД не блокируется. Пока показываем
// ТОЛЬКО модератору — обкатываем цифры, прежде чем выносить счётчик на карточки.

import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  Container, Typography, Paper, Box, Button, CircularProgress, Alert, Link as MuiLink,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { styled } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';
import { AuthContext, authedFetch } from '../../pocketbase/pocketbase';
import { fetchGameViewStats, GameViewStat } from '../../utils/gameViews';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

const fmtDate = (s: string): string => {
  if (!s) return '–';
  const d = new Date(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
};

const ViewStatsPanel: React.FC = () => {
  const { signedIn, isModerator } = useContext(AuthContext);
  const [stats, setStats] = useState<GameViewStat[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchGameViewStats(authedFetch, 500);
      setStats(rows);
    } catch (e: any) {
      setError(e?.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (signedIn && isModerator) load();
  }, [signedIn, isModerator, load]);

  if (!signedIn || !isModerator) return null;

  const total = stats.reduce((sum, s) => sum + s.count, 0);

  return (
    <Container maxWidth="md">
      <StyledPaper elevation={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h5">Game views (first-party)</Typography>
          <Button
            onClick={load}
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            sx={{ color: '#e0e0e0' }}
          >
            Refresh
          </Button>
        </Box>
        <Typography variant="body2" sx={{ color: '#aaa', mb: 2 }}>
          Не режется адблоком (в отличие от GA). Дедуп на браузерную сессию. Пока
          только здесь – обкатываем перед выносом на карточки.
        </Typography>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        {!error && (
          <Typography variant="body2" sx={{ color: '#ccc', mb: 2 }}>
            {stats.length} игр · {total.toLocaleString()} просмотров суммарно
          </Typography>
        )}

        {loading && stats.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : (
          <TableContainer component={Box} sx={{ maxHeight: '70vh', overflow: 'auto' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {['#', 'Game', 'Views', 'Last viewed'].map((h) => (
                    <TableCell key={h} sx={{ backgroundColor: '#242424', color: '#bbb', fontWeight: 600 }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {stats.map((s, i) => (
                  <TableRow key={s.game_id} hover>
                    <TableCell sx={{ color: '#888' }}>{i + 1}</TableCell>
                    <TableCell sx={{ color: '#e0e0e0' }}>
                      <MuiLink
                        component={RouterLink}
                        to={`/game/${s.slug || s.game_id}`}
                        target="_blank"
                        rel="noopener"
                        sx={{ color: '#8ab4f8' }}
                      >
                        {s.title || s.game_id}
                      </MuiLink>
                    </TableCell>
                    <TableCell sx={{ color: '#e0e0e0', fontVariantNumeric: 'tabular-nums' }}>
                      {s.count.toLocaleString()}
                    </TableCell>
                    <TableCell sx={{ color: '#aaa' }}>{fmtDate(s.updated)}</TableCell>
                  </TableRow>
                ))}
                {stats.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={4} sx={{ color: '#888', textAlign: 'center', py: 3 }}>
                      Пока нет данных – просмотры начнут копиться после деплоя.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </StyledPaper>
    </Container>
  );
};

export default ViewStatsPanel;
