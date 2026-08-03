// «Голосование за бамп» — кнопка-билетик в строке действий под тегами (см.
// GameAdditionalInfo). Показывает, сколько голосов уже отдали за эту игру, и по
// клику раскрывает поповер: обратный отсчёт до розыгрыша, «мои голоса k/3»,
// кнопку Vote (с человеко-понятной причиной, когда нельзя), снятие голоса в
// течение суток и ссылку на публичную статистику рулетки.
//
// Вся логика правил — на сервере (bump_roulette.go); тут только чтение статуса и
// отправка намерения через bumpRouletteApi.

import { useState, useEffect, useCallback, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Tooltip,
  IconButton,
  Popover,
  Button,
  CircularProgress,
  Divider,
  Link as MuiLink,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ConfirmationNumberOutlinedIcon from '@mui/icons-material/ConfirmationNumberOutlined';
import { AuthContext } from '../../pocketbase/pocketbase';
import {
  getBumpStatus,
  castBumpVote,
  withdrawBumpVote,
  type BumpStatus,
  type BumpApiError,
} from '../../pocketbase/bumpRouletteApi';
import { formatCountdown, formatDate } from '../Roulette/bumpTime';

interface Props {
  gameId: string;
}

export default function BumpVoteWidget({ gameId }: Props) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { user } = useContext(AuthContext);
  const userID = user?.id;

  const [status, setStatus] = useState<BumpStatus | null>(null);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the ticket count on mount (public) and whenever auth changes (personal
  // fields like my_tickets depend on who's asking).
  useEffect(() => {
    let cancelled = false;
    getBumpStatus(gameId)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus(null));
    return () => {
      cancelled = true;
    };
  }, [gameId, userID]);

  const refresh = useCallback((s: BumpStatus) => {
    setStatus(s);
    setError(null);
  }, []);

  const handleVote = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      refresh(await castBumpVote(gameId));
    } catch (e) {
      setError((e as BumpApiError).message || 'Vote failed');
    } finally {
      setBusy(false);
    }
  }, [gameId, busy, refresh]);

  const handleWithdraw = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      refresh(await withdrawBumpVote(gameId));
    } catch (e) {
      setError((e as BumpApiError).message || 'Could not withdraw');
    } finally {
      setBusy(false);
    }
  }, [gameId, busy, refresh]);

  const tickets = status?.tickets ?? 0;
  const myTickets = status?.my_tickets ?? 0;
  const maxTickets = status?.max_tickets ?? 3;
  const highlight = myTickets > 0;

  // Why the Vote button is (or isn't) offered — drives both the disabled state
  // and the explanatory line under it.
  let voteHint = '';
  let canVote = false;
  if (!userID) {
    voteHint = 'Log in to vote for a bump.';
  } else if (status) {
    if (status.reason === 'too_new') {
      voteHint = 'Voting opens 2 weeks after a game is published.';
    } else if (status.reason === 'won_recently') {
      voteHint = `Won recently — voting reopens ${formatDate(status.locked_until) || 'in a month'}.`;
    } else if (!status.eligible) {
      voteHint = 'This game is not open for votes right now.';
    } else if (myTickets >= maxTickets) {
      voteHint = `You've given this game the max (${myTickets}/${maxTickets}).`;
    } else if (status.next_vote_at) {
      voteHint = `One vote per day — you can vote again ${formatCountdown(status.next_vote_at)}.`;
    } else {
      canVote = true;
      voteHint = 'Each vote is a raffle ticket. Daily draw bumps one game to the top.';
    }
  }

  const canWithdraw = Boolean(userID && status?.withdrawable_until);

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Tooltip title="Vote to bump this game" arrow>
          <IconButton
            onClick={(e) => setAnchorEl(e.currentTarget)}
            size="small"
            sx={{
              width: 36,
              height: 36,
              color: highlight ? theme.palette.secondary.main : theme.palette.primary.light,
              '&:hover': { backgroundColor: theme.palette.action.hover, color: theme.palette.secondary.main },
            }}
          >
            <ConfirmationNumberOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold', minWidth: 10, textAlign: 'left' }}>
          {tickets}
        </Typography>
      </Box>

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 2, maxWidth: 300 } } }}
      >
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
          🎲 Bump roulette
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          <b>{tickets}</b> {tickets === 1 ? 'vote' : 'votes'} for this game
          {status?.pool_tickets ? ` · ${status.pool_tickets} in the pool` : ''}
        </Typography>
        {status?.next_draw_at && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}>
            Next draw {formatCountdown(status.next_draw_at)}
          </Typography>
        )}
        {userID && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}>
            Your votes: {myTickets}/{maxTickets}
          </Typography>
        )}

        <Divider sx={{ my: 1.25 }} />

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            size="small"
            color="secondary"
            disabled={!canVote || busy}
            onClick={handleVote}
            startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          >
            Vote
          </Button>
          {canWithdraw && (
            <Button variant="text" size="small" disabled={busy} onClick={handleWithdraw}>
              Withdraw
            </Button>
          )}
        </Box>

        <Typography variant="caption" sx={{ display: 'block', color: error ? 'error.main' : 'text.secondary', mt: 1 }}>
          {error || voteHint}
        </Typography>
        {canWithdraw && !error && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', mt: 0.25 }}>
            You can still move this vote until {formatDate(status?.withdrawable_until)} — after that it stays.
          </Typography>
        )}

        <Divider sx={{ my: 1.25 }} />
        <MuiLink
          component="button"
          type="button"
          variant="caption"
          onClick={() => {
            setAnchorEl(null);
            navigate('/roulette');
          }}
          sx={{ color: theme.palette.primary.light }}
        >
          See standings →
        </MuiLink>
      </Popover>
    </>
  );
}
