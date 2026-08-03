// src/components/ModeratorPanel/RoulettePanel.tsx
//
// Страница /moderator/roulette — настройки и статистика рулетки бампов.
// Бэкенд: bump_roulette.go (GET/POST /api/custom/bump/admin, POST .../admin/draw).
//
// Тумблер enabled управляет самим кроном; остальные поля — гейты/кулдауны/лимиты.
// «Draw now» проводит внеочередной розыгрыш (ставит next_draw_at в прошлое).

import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  Container, Typography, Paper, Box, Button, CircularProgress, Alert, Grid,
  TextField, FormControlLabel, Switch, Divider, Chip,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';
import { styled } from '@mui/material/styles';
import { AuthContext } from '../../pocketbase/pocketbase';
import {
  getBumpAdmin, updateBumpSettings, runBumpDrawNow,
  type BumpAdmin, type BumpSettings,
} from '../../pocketbase/bumpRouletteApi';
import { formatCountdown, formatDate } from '../Roulette/bumpTime';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

// Числовые поля настроек: ключ → человекочитаемая подпись.
const NUM_FIELDS: { key: keyof BumpSettings; label: string }[] = [
  { key: 'interval_hours', label: 'Draw interval (hours)' },
  { key: 'min_age_days', label: 'Min game age (days)' },
  { key: 'win_lockout_days', label: 'Win lockout (days)' },
  { key: 'max_tickets_per_game', label: 'Max tickets per user / game' },
  { key: 'vote_cooldown_hours', label: 'Vote cooldown (hours)' },
  { key: 'withdraw_window_hours', label: 'Withdraw window (hours)' },
];

const RoulettePanel: React.FC = () => {
  const { signedIn, isModerator } = useContext(AuthContext);
  const [data, setData] = useState<BumpAdmin | null>(null);
  const [form, setForm] = useState<BumpSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await getBumpAdmin();
      setData(d);
      setForm(d.settings);
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (signedIn && isModerator) load();
  }, [signedIn, isModerator, load]);

  const setNum = (key: keyof BumpSettings, v: string) => {
    if (!form) return;
    setForm({ ...form, [key]: v === '' ? 0 : Number(v) });
  };

  const save = useCallback(async (patch: Partial<BumpSettings> & { reset_next_draw?: boolean }) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateBumpSettings(patch);
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      setForm(res.settings);
      setNotice('Saved.');
    } catch (e: any) {
      setError(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }, []);

  const saveAll = useCallback(() => {
    if (!form) return;
    save({
      enabled: form.enabled,
      interval_hours: form.interval_hours,
      min_age_days: form.min_age_days,
      win_lockout_days: form.win_lockout_days,
      max_tickets_per_game: form.max_tickets_per_game,
      vote_cooldown_hours: form.vote_cooldown_hours,
      withdraw_window_hours: form.withdraw_window_hours,
    });
  }, [form, save]);

  const drawNow = useCallback(async () => {
    if (!window.confirm('Run an out-of-cycle draw now? One game will be bumped immediately.')) return;
    setDrawing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await runBumpDrawNow();
      setNotice(res.winner ? `Drawn — winner ${res.winner} bumped.` : 'No eligible tickets — nothing drawn.');
      await load();
    } catch (e: any) {
      setError(e?.message || 'Draw failed');
    } finally {
      setDrawing(false);
    }
  }, [load]);

  if (!signedIn || !isModerator) return null;

  return (
    <Container maxWidth="md">
      <StyledPaper elevation={3}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="h5">🎲 Bump roulette</Typography>
          <Button
            onClick={load}
            disabled={loading}
            startIcon={loading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
          >
            Refresh
          </Button>
        </Box>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {notice && <Alert severity="success" sx={{ mb: 2 }}>{notice}</Alert>}

        {loading && !form && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {form && (
          <>
            <FormControlLabel
              control={
                <Switch
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  color="secondary"
                />
              }
              label={form.enabled ? 'Roulette enabled' : 'Roulette paused'}
            />

            <Grid container spacing={2} sx={{ mt: 0.5 }}>
              {NUM_FIELDS.map((f) => (
                <Grid item xs={6} sm={4} key={f.key}>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    label={f.label}
                    value={form[f.key] ?? 0}
                    onChange={(e) => setNum(f.key, e.target.value)}
                    InputLabelProps={{ shrink: true }}
                  />
                </Grid>
              ))}
            </Grid>

            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mt: 2, flexWrap: 'wrap' }}>
              <Button variant="contained" color="secondary" onClick={saveAll} disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </Button>
              <Button
                variant="outlined"
                onClick={() => save({ reset_next_draw: true })}
                disabled={saving}
              >
                Re-arm next draw
              </Button>
              <Button
                variant="outlined"
                color="warning"
                startIcon={drawing ? <CircularProgress size={16} color="inherit" /> : <CasinoOutlinedIcon />}
                onClick={drawNow}
                disabled={drawing}
              >
                Draw now
              </Button>
            </Box>

            <Box sx={{ display: 'flex', gap: 3, mt: 2, flexWrap: 'wrap', color: 'text.secondary' }}>
              <Typography variant="body2">
                Next draw: <b>{form.enabled ? formatCountdown(form.next_draw_at) || '—' : 'paused'}</b>
              </Typography>
              <Typography variant="body2">Last draw: <b>{formatDate(form.last_draw_at) || '—'}</b></Typography>
            </Box>
          </>
        )}

        {data && (
          <>
            <Divider sx={{ my: 3 }} />
            <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
              <Chip label={`Pool: ${data.pool_tickets} tickets`} color="secondary" />
              <Chip label={`Voters: ${data.voters}`} variant="outlined" />
            </Box>

            <Typography variant="subtitle1" sx={{ mb: 1 }}>Standings</Typography>
            <TableContainer component={Paper} sx={{ backgroundColor: '#262626', mb: 3 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>#</TableCell>
                    <TableCell>Game</TableCell>
                    <TableCell align="right">Tickets</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.standings.length === 0 ? (
                    <TableRow><TableCell colSpan={3}>No votes yet.</TableCell></TableRow>
                  ) : (
                    data.standings.map((s, i) => (
                      <TableRow key={s.id} hover>
                        <TableCell>{i + 1}</TableCell>
                        <TableCell>{s.title || s.id}{s.nsfw ? ' 🔞' : ''}</TableCell>
                        <TableCell align="right">{s.tickets}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            <Typography variant="subtitle1" sx={{ mb: 1 }}>Recent winners</Typography>
            <TableContainer component={Paper} sx={{ backgroundColor: '#262626' }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Game</TableCell>
                    <TableCell>Drawn</TableCell>
                    <TableCell align="right">Odds</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.winners.length === 0 ? (
                    <TableRow><TableCell colSpan={3}>No draws yet.</TableCell></TableRow>
                  ) : (
                    data.winners.map((w) => (
                      <TableRow key={`${w.id}-${w.drawn_at}`} hover>
                        <TableCell>{w.title || w.id}</TableCell>
                        <TableCell>{formatDate(w.drawn_at)}</TableCell>
                        <TableCell align="right">{w.ticket_count}/{w.total_tickets}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </StyledPaper>
    </Container>
  );
};

export default RoulettePanel;
