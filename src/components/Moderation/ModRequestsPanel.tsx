// src/components/Moderation/ModRequestsPanel.tsx
//
// Страница /moderator/tickets — очередь обращений к модераторам.
// Тикеты создаёт Go (maybeCreateModRequest) когда в комменте есть @moderator.
// Это persistent-система (в отличие от уведомлений): тикет живёт пока его не
// закроют. Записи read-only для клиента; правки идут через Go-эндпоинт
// /api/custom/mod-requests/update (он же перепроверяет isModerator).

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Container, Typography, Paper, Box, Button, Chip, CircularProgress, Snackbar,
  Alert, Tabs, Tab, Stack, TextField, Link as MuiLink, Avatar, Tooltip,
} from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { styled } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';
import { AuthContext, Game, ModRequest, ModRequestStatus, pb, gameCanonicalKey } from '../../pocketbase/pocketbase';
import { fetchModRequests, fetchModRequestsFull, updateModRequest } from './modRequestsApi';
import { postComment } from '../CyoaPage/Comments/commentsApi';
import CommentBody from '../CyoaPage/Comments/CommentBody';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2.5),
  margin: theme.spacing(2, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

const TABS: { value: ModRequestStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'trash', label: 'Trash' },
  { value: 'all', label: 'All' },
];

const KIND_LABEL: Record<string, string> = {
  wrong_author: 'wrong author',
  dead_link: 'dead link',
  missing_images: 'missing images',
  change_tag: 'change tag',
  update_version: 'update version',
  relation: 'linked game',
  duplicate: 'duplicate',
  illegal: 'illegal',
  other: 'other',
};

// One-tap replies the moderator can drop into the public reply box, then edit.
const CANNED_REPLIES = [
  'Fixed – thanks for the report! ✅',
  'Done.',
  "Couldn't reproduce – could you add more detail?",
  "That's a different game, not a newer version of this one.",
  'Looks correct as-is, no change needed.',
];

const STATUS_COLOR: Record<ModRequestStatus, 'warning' | 'info' | 'success' | 'default'> = {
  open: 'warning',
  in_progress: 'info',
  resolved: 'success',
  trash: 'default',
};

const fmtDate = (s: string) => {
  if (!s) return '–';
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? s : d.toLocaleString();
};

const PER_PAGE = 30;

export default function ModRequestsPanel() {
  const { user } = useContext(AuthContext);
  const [tab, setTab] = useState<ModRequestStatus | 'all'>('open');
  const [items, setItems] = useState<ModRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; sev: 'success' | 'error' } | null>(null);
  // Local draft of internal notes, keyed by ticket id (so typing doesn't refetch).
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  // Draft of the public reply, keyed by ticket id.
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  // Game id currently being bulk-resolved (drives that group's spinner).
  const [groupBusy, setGroupBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Actionable queues (open / in_progress) are fetched whole so the priority
      // sort below is global, not just within one page. Archive tabs stay paged.
      const actionable = tab === 'open' || tab === 'in_progress';
      const rows = actionable
        ? await fetchModRequestsFull(tab)
        : (await fetchModRequests(tab, 1, PER_PAGE)).items;
      // Triage order: illegal/rule-breaking jumps the queue, then the reports the
      // community liked most (the triggering comment's likes), then newest first.
      const sorted = [...rows].sort((a, b) => {
        const ai = a.kind === 'illegal' ? 1 : 0;
        const bi = b.kind === 'illegal' ? 1 : 0;
        if (ai !== bi) return bi - ai;
        const al = a.expand?.comment?.likes_count ?? 0;
        const bl = b.expand?.comment?.likes_count ?? 0;
        if (al !== bl) return bl - al;
        return b.created.localeCompare(a.created);
      });
      setItems(sorted);
      setNoteDraft(
        Object.fromEntries(sorted.map((t) => [t.id, t.internal_note ?? ''])),
      );
    } catch {
      setToast({ msg: 'Failed to load tickets.', sev: 'error' });
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (id: string, body: Parameters<typeof updateModRequest>[1], okMsg: string) => {
      setBusyId(id);
      try {
        await updateModRequest(id, body);
        setToast({ msg: okMsg, sev: 'success' });
        await load();
      } catch {
        setToast({ msg: 'Update failed.', sev: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  // Post a public reply (as a reply to the triggering comment) and optionally
  // resolve the ticket. This is the same Go endpoint a user uses, so it slots
  // straight into the LLM-moderator path later. The requester gets a normal
  // "reply" notification automatically (fan-out in Go).
  const reply = useCallback(
    async (t: ModRequest, alsoResolve: boolean) => {
      const text = (replyDraft[t.id] ?? '').trim();
      if (!text || !t.game) return;
      setBusyId(t.id);
      try {
        await postComment(t.game, text, t.comment);
        if (alsoResolve) await updateModRequest(t.id, { status: 'resolved' });
        setReplyDraft((d) => ({ ...d, [t.id]: '' }));
        setToast({ msg: alsoResolve ? 'Replied & resolved.' : 'Reply posted.', sev: 'success' });
        await load();
      } catch {
        setToast({ msg: 'Reply failed.', sev: 'error' });
      } finally {
        setBusyId(null);
      }
    },
    [replyDraft, load],
  );

  // Cluster the (already priority-sorted) tickets by game. The first ticket of a
  // game fixes the group's position, so the global triage order is preserved and
  // a game with an illegal report still sits at the top. Tickets with no game
  // fall into their own trailing bucket.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; game?: Game; tickets: ModRequest[] }>();
    for (const t of items) {
      const key = t.game || '__nogame__';
      let g = map.get(key);
      if (!g) {
        g = { key, game: t.expand?.game, tickets: [] };
        map.set(key, g);
      }
      g.tickets.push(t);
    }
    return [...map.values()];
  }, [items]);

  // Resolve every still-open ticket in a game's group in one click. Volume is
  // low, so a sequential loop is fine; reload once at the end.
  const resolveGroup = useCallback(
    async (key: string, tickets: ModRequest[]) => {
      const pending = tickets.filter((t) => t.status !== 'resolved');
      if (pending.length === 0) return;
      setGroupBusy(key);
      try {
        for (const t of pending) await updateModRequest(t.id, { status: 'resolved' });
        setToast({ msg: `Resolved ${pending.length} ticket(s).`, sev: 'success' });
        await load();
      } catch {
        setToast({ msg: 'Bulk resolve failed.', sev: 'error' });
      } finally {
        setGroupBusy(null);
      }
    },
    [load],
  );

  return (
    <Container maxWidth="md">
      <Typography variant="h5" sx={{ mt: 3, mb: 1, color: 'text.primary' }}>
        Moderator tickets
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
        Requests raised by users via the “Call a moderator” button. Replies are
        posted publicly in the game’s comments; this queue just tracks state.
      </Typography>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ mb: 1 }}
        variant="scrollable"
        scrollButtons="auto"
      >
        {TABS.map((t) => (
          <Tab key={t.value} value={t.value} label={t.label} />
        ))}
      </Tabs>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : items.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', py: 4, textAlign: 'center' }}>
          No tickets here.
        </Typography>
      ) : (
        groups.map((g) => (
          <Box key={g.key}>
            {/* Group header — only when a game has more than one open ticket, so
                the common single-report case stays uncluttered. */}
            {g.tickets.length > 1 && (
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 3, mb: -0.5 }}>
                <Typography variant="subtitle1" sx={{ color: 'text.primary', fontWeight: 600 }}>
                  {g.game ? (
                    <MuiLink component={RouterLink} to={`/game/${gameCanonicalKey(g.game)}`} color="inherit">
                      {g.game.title || g.game.id}
                    </MuiLink>
                  ) : (
                    'No game'
                  )}
                </Typography>
                <Chip size="small" label={`${g.tickets.length} tickets`} />
                {g.tickets.some((t) => t.status !== 'resolved') && (
                  <Button
                    size="small"
                    color="success"
                    disabled={groupBusy === g.key}
                    onClick={() => resolveGroup(g.key, g.tickets)}
                  >
                    Resolve all
                  </Button>
                )}
                {groupBusy === g.key && <CircularProgress size={16} />}
              </Stack>
            )}
            {g.tickets.map((t) => {
          const requester = t.expand?.requester;
          const game = t.expand?.game;
          const comment = t.expand?.comment;
          const assignee = t.expand?.assignee;
          const busy = busyId === t.id;
          const commentLink = game
            ? `/game/${gameCanonicalKey(game)}#comment-${t.comment}`
            : undefined;
          return (
            <StyledPaper key={t.id}>
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="flex-start"
                flexWrap="wrap"
                gap={1}
              >
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Chip
                      size="small"
                      label={t.status.replace('_', ' ')}
                      color={STATUS_COLOR[t.status]}
                    />
                    <Chip
                      size="small"
                      variant={t.kind === 'illegal' ? 'filled' : 'outlined'}
                      color={t.kind === 'illegal' ? 'error' : 'default'}
                      label={KIND_LABEL[t.kind] ?? t.kind}
                    />
                    {(t.expand?.comment?.likes_count ?? 0) > 0 && (
                      <Tooltip title="Likes on the report – more-liked reports rank higher" arrow>
                        <Chip
                          size="small"
                          variant="outlined"
                          icon={<FavoriteIcon sx={{ fontSize: '0.8rem' }} />}
                          label={t.expand?.comment?.likes_count}
                        />
                      </Tooltip>
                    )}
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {fmtDate(t.created)}
                    </Typography>
                  </Stack>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {requester ? (
                      <>by <strong>{requester.username}</strong></>
                    ) : (
                      'by (unknown)'
                    )}
                    {game && (
                      <>
                        {' · '}
                        <MuiLink component={RouterLink} to={`/game/${gameCanonicalKey(game)}`}>
                          {game.title || game.id}
                        </MuiLink>
                      </>
                    )}
                  </Typography>
                </Box>
                {assignee && (
                  <Stack direction="row" spacing={0.5} alignItems="center">
                    <Avatar
                      sx={{ width: 22, height: 22, fontSize: '0.7rem' }}
                      src={assignee.avatar ? pb.files.getURL(assignee, assignee.avatar, { thumb: '50x50' }) : undefined}
                    >
                      {assignee.username?.charAt(0).toUpperCase()}
                    </Avatar>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                      {assignee.username}
                    </Typography>
                  </Stack>
                )}
              </Stack>

              {/* The triggering comment */}
              <Box
                sx={{
                  mt: 1.5,
                  p: 1.5,
                  bgcolor: 'rgba(0,0,0,0.25)',
                  borderRadius: 1,
                  borderLeft: '3px solid',
                  borderColor: 'divider',
                }}
              >
                {comment ? (
                  <CommentBody content={comment.content} />
                ) : (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    (comment unavailable)
                  </Typography>
                )}
              </Box>

              {/* Public reply — posted as a reply to the triggering comment */}
              <Box sx={{ mt: 1.5 }}>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" gap={0.5} sx={{ mb: 0.5 }}>
                  {CANNED_REPLIES.map((r) => (
                    <Chip
                      key={r}
                      size="small"
                      variant="outlined"
                      label={r}
                      onClick={() => setReplyDraft((d) => ({ ...d, [t.id]: r }))}
                      sx={{ maxWidth: '100%' }}
                    />
                  ))}
                </Stack>
                <TextField
                  fullWidth
                  multiline
                  size="small"
                  label="Public reply to the user"
                  placeholder="Posts as a reply in the game's comments; the user gets a notification."
                  value={replyDraft[t.id] ?? ''}
                  onChange={(e) => setReplyDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                  disabled={!t.game}
                />
                <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={busy || !t.game || !(replyDraft[t.id] ?? '').trim()}
                    onClick={() => reply(t, false)}
                  >
                    Reply
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color="success"
                    disabled={busy || !t.game || !(replyDraft[t.id] ?? '').trim()}
                    onClick={() => reply(t, true)}
                  >
                    Reply &amp; resolve
                  </Button>
                </Stack>
              </Box>

              {/* Internal note for other moderators */}
              <TextField
                fullWidth
                multiline
                size="small"
                label="Internal note (moderators only)"
                value={noteDraft[t.id] ?? ''}
                onChange={(e) => setNoteDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                sx={{ mt: 1.5 }}
              />

              {/* Actions */}
              <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} sx={{ mt: 1.5 }}>
                {commentLink && (
                  <Button
                    size="small"
                    variant="outlined"
                    component={RouterLink}
                    to={commentLink}
                  >
                    Go to comment
                  </Button>
                )}
                <Button
                  size="small"
                  disabled={busy || (noteDraft[t.id] ?? '') === (t.internal_note ?? '')}
                  onClick={() => patch(t.id, { internal_note: noteDraft[t.id] ?? '' }, 'Note saved.')}
                >
                  Save note
                </Button>
                {t.status !== 'in_progress' && (
                  <Button
                    size="small"
                    color="info"
                    disabled={busy}
                    onClick={() =>
                      patch(
                        t.id,
                        { status: 'in_progress', assignee: user?.id ?? '' },
                        'Claimed.',
                      )
                    }
                  >
                    Claim / In progress
                  </Button>
                )}
                {t.status !== 'resolved' && (
                  <Button
                    size="small"
                    color="success"
                    disabled={busy}
                    onClick={() => patch(t.id, { status: 'resolved' }, 'Resolved.')}
                  >
                    Resolve
                  </Button>
                )}
                {t.status !== 'trash' && (
                  <Button
                    size="small"
                    color="inherit"
                    disabled={busy}
                    onClick={() => patch(t.id, { status: 'trash' }, 'Moved to trash.')}
                  >
                    Trash
                  </Button>
                )}
                {(t.status === 'resolved' || t.status === 'trash') && (
                  <Button
                    size="small"
                    color="warning"
                    disabled={busy}
                    onClick={() => patch(t.id, { status: 'open' }, 'Reopened.')}
                  >
                    Reopen
                  </Button>
                )}
                {busy && <CircularProgress size={18} sx={{ alignSelf: 'center' }} />}
              </Stack>
            </StyledPaper>
          );
            })}
          </Box>
        ))
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.sev} onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Container>
  );
}
