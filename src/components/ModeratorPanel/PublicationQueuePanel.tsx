// /moderator/queue — auto-publication (drip-feed) queue management. Backend: Go
// /api/pipeline/queue/* (publication_queue_api.go); the queue→games transfer is the Go cron
// (publication_queue.go). Cards a moderator submitted from Mod Tools carry `mod_upload` and wait,
// highlighted, until ANOTHER moderator checks them (the timer skips them until then).

import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  Container, Typography, Paper, Box, Button, TextField, Switch, FormControlLabel,
  Chip, CircularProgress, Snackbar, Alert, Tabs, Tab, Tooltip, Divider, Grid,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import { AuthContext, pb, authedFetch } from '../../pocketbase/pocketbase';
import GameMetaDialog from '../GameMeta/GameMetaDialog';
import { pickAdapter } from '../GameMeta/adapters';
import { GameMetaField, GameMetaValue } from '../GameMeta/types';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

type Counts = {
  approved: number; approved_nsfw: number; approved_sfw: number; approved_community: number;
  publishing: number; publish_failed: number; published: number; dismissed: number;
  mod_unchecked?: number;
};
type Status = {
  enabled: boolean;
  interval_minutes: number;
  jitter_minutes: number;
  next_publish_at: string;
  last_published_at: string;
  publish_uploader: string;
  counts: Counts;
  drain_eta_hours: number;
};
type QueueItem = {
  id: string; title: string; slug: string; nsfw: boolean; img_or_link: string;
  publish_mode: string; state: string; npages: number; ntags: number;
  has_image: boolean; original_url: string; attempts: number; error: string; created: string;
  review_reasons: string[]; dedup_note: string; dedup_candidate: string; moderator_note: string;
  community: boolean; submitter: string;
  // Editable metadata (shared GameMetaEditor). `game` = catalog record if the row is already
  // published — then edits must go to games, not the pipeline kitchen.
  game: string; author: string; aliases: string; has_aliases: boolean;
  authors: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  mod_upload?: ModUpload | null;
  description?: string;
  hosted_url?: string;
  source_url?: string;
};
type ModUpload = {
  by: string; by_name: string; at: string; job: string; checked: boolean;
  checked_by?: string; checked_by_name?: string; checked_at?: string;
};

const MOD_ACCENT = '#ff9100';

// Staged covers are superuser-only files; the Go handler streams them after the perm check.
function QueueCover({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(`/api/pipeline/queue/items/${id}/cover`, { method: 'GET' });
        if (!res.ok) return;
        objUrl = URL.createObjectURL(await res.blob());
        if (cancelled) URL.revokeObjectURL(objUrl);
        else setUrl(objUrl);
      } catch { /* no cover */ }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [id]);
  if (!url) return <Box sx={{ width: 150, height: 200, bgcolor: '#1c1c1c', borderRadius: 1, flexShrink: 0 }} />;
  return (
    <Box component="a" href={url} target="_blank" rel="noopener noreferrer" sx={{ flexShrink: 0 }}>
      <Box component="img" src={url} alt="cover"
        sx={{ width: 150, height: 200, objectFit: 'cover', objectPosition: 'top', borderRadius: 1, display: 'block' }} />
    </Box>
  );
}

const fmtDate = (s: string) => {
  if (!s) return '–';
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? s : d.toLocaleString();
};

const LIST_STATES = ['approved', 'publish_failed', 'dismissed', 'published'] as const;
type ListState = typeof LIST_STATES[number];

export default function PublicationQueuePanel() {
  const { signedIn, isModerator, user } = useContext(AuthContext);
  const navigate = useNavigate();

  const [status, setStatus] = useState<Status | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: 'success' | 'error' } | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalMin] = useState(120);
  const [jitter, setJitter] = useState(30);
  const [uploader, setUploader] = useState('');

  const [tab, setTab] = useState<ListState>('approved');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [loadingItems, setLoadingItems] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<QueueItem | null>(null);

  useEffect(() => {
    if (!signedIn || !isModerator) navigate('/');
  }, [signedIn, isModerator, navigate]);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const s: Status = await pb.send('/api/pipeline/queue/status', { method: 'GET' });
      setStatus(s);
      setEnabled(s.enabled);
      setIntervalMin(s.interval_minutes);
      setJitter(s.jitter_minutes);
      setUploader(s.publish_uploader || '');
    } catch (err) {
      console.error('status load failed', err);
      setToast({ msg: 'Failed to load queue status', sev: 'error' });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadItems = useCallback(async (state: ListState, p: number) => {
    setLoadingItems(true);
    try {
      const res = await pb.send(
        `/api/pipeline/queue/items?state=${state}&page=${p}&perPage=30`,
        { method: 'GET' },
      );
      setItems(res?.items ?? []);
      setTotalPages(res?.totalPages ?? 1);
      setTotalItems(res?.totalItems ?? 0);
    } catch (err) {
      console.error('items load failed', err);
      setToast({ msg: 'Failed to load queue items', sev: 'error' });
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    if (signedIn && isModerator) loadStatus();
  }, [signedIn, isModerator, loadStatus]);

  useEffect(() => {
    if (signedIn && isModerator) loadItems(tab, page);
  }, [signedIn, isModerator, tab, page, loadItems]);

  const saveSettings = async () => {
    setBusy(true);
    try {
      const s: Status = await pb.send('/api/pipeline/queue/settings', {
        method: 'PATCH',
        body: {
          enabled,
          interval_minutes: Number(interval),
          jitter_minutes: Number(jitter),
          publish_uploader: uploader.trim(),
        },
      });
      setStatus(s);
      setToast({ msg: 'Settings saved', sev: 'success' });
    } catch (err) {
      console.error('save settings failed', err);
      setToast({ msg: 'Failed to save settings – see console', sev: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const publishNow = async () => {
    if (!window.confirm('Publish the next game immediately (on the next minute tick)?')) return;
    setBusy(true);
    try {
      await pb.send('/api/pipeline/queue/publish-now', { method: 'POST' });
      setToast({ msg: 'Will publish on the next tick (~1 min)', sev: 'success' });
      setTimeout(loadStatus, 1500);
    } catch (err) {
      console.error('publish-now failed', err);
      setToast({ msg: 'publish-now failed', sev: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Publish a row immediately, bypassing the drip-feed timer. The backend publishes synchronously
  // (may take seconds).
  const publishItemNow = async (it: QueueItem) => {
    const name = it.title || it.slug || '(untitled)';
    if (!window.confirm(`Publish “${name}” to the catalogue right now?`)) return;
    setBusyId(it.id);
    try {
      await pb.send(`/api/pipeline/queue/items/${it.id}/publish`, { method: 'POST' });
      setItems((prev) => prev.filter((x) => x.id !== it.id));
      setToast({ msg: `Published: ${name}`, sev: 'success' });
      loadStatus();
    } catch (err) {
      console.error('publish item failed', err);
      const msg = (err as { message?: string })?.message || 'publish failed';
      setToast({ msg, sev: 'error' });
      loadItems(tab, page);
    } finally {
      setBusyId(null);
    }
  };

  const itemAction = async (id: string, action: 'dismiss' | 'requeue') => {
    setBusyId(id);
    try {
      await pb.send(`/api/pipeline/queue/items/${id}/${action}`, { method: 'POST' });
      setItems((prev) => prev.filter((it) => it.id !== id));
      setToast({ msg: action === 'dismiss' ? 'Removed from queue' : 'Re-queued', sev: 'success' });
      loadStatus();
    } catch (err) {
      console.error(`${action} failed`, err);
      setToast({ msg: `${action} failed`, sev: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const checkModUpload = async (it: QueueItem) => {
    setBusyId(it.id);
    try {
      const res = await pb.send(`/api/pipeline/queue/items/${it.id}/check`, { method: 'POST' });
      setItems((prev) => prev.map((x) => (x.id === it.id ? { ...x, mod_upload: res.mod_upload } : x)));
      setToast({ msg: 'Checked — the timer will publish it', sev: 'success' });
      loadStatus();
    } catch (err) {
      const msg = (err as { message?: string })?.message || 'check failed';
      setToast({ msg, sev: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  // Published rows use the catalog adapter, others the pipeline one; published cards get tags via
  // voting, so no tag field (adapter.supports would drop it anyway, but keep the field list
  // honest).
  const editFields = (it: QueueItem): GameMetaField[] =>
    (it.state === 'published' && it.game
      ? ['title', 'aliases', 'authors']
      : ['title', 'aliases', 'authors', 'tags']);

  const applyMeta = (id: string, patch: Partial<GameMetaValue>) => {
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it;
      const upd = { ...it };
      if (patch.title !== undefined) upd.title = patch.title;
      if (patch.aliases !== undefined) upd.aliases = patch.aliases;
      if (patch.authors !== undefined) {
        upd.authors = patch.authors.map((a) => ({ id: a.id, name: a.name }));
        upd.author = upd.authors.map((a) => a.name).join(', ');
      }
      if (patch.tags !== undefined) {
        upd.tags = patch.tags.map((t) => ({ id: t.id, name: t.name }));
        upd.ntags = upd.tags.length;
      }
      return upd;
    }));
    setToast({ msg: 'Saved', sev: 'success' });
  };

  if (!signedIn || !isModerator) return null;

  const c = status?.counts;
  const tf = { '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } };

  return (
    <Container maxWidth="lg">
      <Typography variant="h4" component="h1" gutterBottom
        sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }}>
        Publication Queue
      </Typography>

      <StyledPaper elevation={3}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">Scheduler</Typography>
          {loadingStatus && <CircularProgress size={20} />}
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, alignItems: 'center' }}>
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} color="primary" />}
            label={enabled ? 'Auto-publish ON' : 'Auto-publish OFF'}
          />
          <TextField label="Interval (min)" type="number" size="small" value={interval}
            onChange={(e) => { if (e.target.value !== '') setIntervalMin(Number(e.target.value)); }}
            InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }}
            sx={{ width: 140, ...tf }} />
          <TextField label="Jitter (± min)" type="number" size="small" value={jitter}
            onChange={(e) => setJitter(Number(e.target.value))}
            InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }}
            sx={{ width: 140, ...tf }} />
          <Tooltip title="users record id for games.uploader (system account)">
            <TextField label="Uploader (user id)" size="small" value={uploader}
              onChange={(e) => setUploader(e.target.value)}
              InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }}
              sx={{ width: 220, ...tf }} />
          </Tooltip>
          <Button variant="contained" onClick={saveSettings} disabled={busy}
            startIcon={busy ? <CircularProgress size={18} color="inherit" /> : null}>Save</Button>
          <Button variant="outlined" color="secondary" onClick={publishNow} disabled={busy}>Publish now</Button>
        </Box>
        <Box sx={{ mt: 2, display: 'flex', gap: 4, flexWrap: 'wrap', color: '#bbb', fontSize: '0.9rem' }}>
          <span>Next: <b>{fmtDate(status?.next_publish_at || '')}</b></span>
          <span>Last: <b>{fmtDate(status?.last_published_at || '')}</b></span>
        </Box>
      </StyledPaper>

      <StyledPaper elevation={3}>
        <Typography variant="h6" gutterBottom>Queue</Typography>
        <Grid container spacing={2}>
          <StatBox label="Approved (waiting)" value={c?.approved} accent="#4caf50" />
          <StatBox label="· NSFW / SFW" value={c ? `${c.approved_nsfw} / ${c.approved_sfw}` : undefined} />
          <StatBox label="· community (go first)" value={c?.approved_community}
            accent={c?.approved_community ? '#ba68c8' : undefined} />
          <StatBox label="Mod uploads to check" value={c?.mod_unchecked}
            accent={c?.mod_unchecked ? MOD_ACCENT : undefined} />
          <StatBox label="Publishing" value={c?.publishing} />
          <StatBox label="Failed" value={c?.publish_failed} accent={c?.publish_failed ? '#e57373' : undefined} />
          <StatBox label="Dismissed" value={c?.dismissed} />
          <StatBox label="Published total" value={c?.published} />
          <StatBox label="Drain ETA (h)" value={status ? status.drain_eta_hours.toFixed(1) : undefined} />
        </Grid>
      </StyledPaper>

      <StyledPaper elevation={3}>
        <Tabs value={tab} onChange={(_, v) => { setTab(v); setPage(1); }}
          textColor="inherit" indicatorColor="primary" sx={{ mb: 2 }}>
          {LIST_STATES.map((s) => <Tab key={s} value={s} label={s} sx={{ color: '#ccc' }} />)}
        </Tabs>

        {loadingItems ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
        ) : items.length === 0 ? (
          <Typography sx={{ color: '#888', py: 2 }}>Nothing here.</Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {items.map((it) => {
              const mu = it.mod_upload;
              const needsCheck = !!mu && !mu.checked;
              const ownUpload = !!mu && mu.by === user?.id;
              return (
              <Box key={it.id} sx={{
                display: 'flex', alignItems: 'center', gap: 1.5, py: 1, px: 1.5,
                borderRadius: 1, bgcolor: needsCheck ? 'rgba(255,145,0,0.08)' : '#262626', flexWrap: 'wrap',
                border: needsCheck ? `2px solid ${MOD_ACCENT}` : '2px solid transparent',
              }}>
                <Box sx={{ flex: '1 1 280px', minWidth: 0 }}>
                  <Typography noWrap sx={{ fontWeight: 500 }}>{it.title || it.slug || '(untitled)'}</Typography>
                  <Typography noWrap variant="caption" sx={{ color: '#888' }}>
                    {it.author ? `by ${it.author} · ` : ''}{it.original_url}
                  </Typography>
                </Box>
                {mu && (
                  <Tooltip title={mu.checked
                    ? `Uploaded by moderator ${mu.by_name}, checked by ${mu.checked_by_name || '?'}`
                    : `Uploaded by moderator ${mu.by_name} with the helper app. The timer skips it until another moderator checks it.`}>
                    <Chip size="small"
                      label={mu.checked ? `🛠 mod upload · ${mu.by_name} · checked ✓` : `🛠 MOD UPLOAD · ${mu.by_name} · NEEDS CHECK`}
                      sx={mu.checked
                        ? { color: MOD_ACCENT, borderColor: MOD_ACCENT }
                        : { bgcolor: MOD_ACCENT, color: '#1a1a1a', fontWeight: 700 }}
                      variant={mu.checked ? 'outlined' : 'filled'} />
                  </Tooltip>
                )}
                {it.community && (
                  <Tooltip title="Suggested by a user via /add-next – published ahead of the general backlog">
                    <Chip size="small" color="secondary"
                      label={it.submitter ? `👤 ${it.submitter}` : '👤 community'} />
                  </Tooltip>
                )}
                <Chip size="small" label={it.nsfw ? 'NSFW' : 'SFW'} color={it.nsfw ? 'error' : 'default'} variant="outlined" />
                <Chip size="small" label={it.img_or_link === 'img' ? `static · ${it.npages}p` : 'interactive'} variant="outlined" />
                <Chip size="small" label={it.publish_mode || 'create'} variant="outlined" />
                {it.review_reasons?.length > 0 && (
                  <Tooltip title={it.dedup_note || it.review_reasons.join(', ')}>
                    <Chip size="small" color="warning" variant="outlined"
                      label={`⚠ dup? ×${it.review_reasons.length}`} />
                  </Tooltip>
                )}
                {it.moderator_note && (
                  <Tooltip title={it.moderator_note}>
                    <Chip size="small" color="info" variant="outlined" label="📝 note" />
                  </Tooltip>
                )}
                <Tooltip title={it.created}><Typography variant="caption" sx={{ color: '#777', width: 90, textAlign: 'right' }}>{fmtDate(it.created).split(',')[0]}</Typography></Tooltip>
                {it.state === 'publish_failed' && it.error && (
                  <Tooltip title={it.error}><Chip size="small" color="error" label={`err ×${it.attempts}`} /></Tooltip>
                )}
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  <Button size="small" variant="outlined" onClick={() => setEditing(it)}>Edit</Button>
                  {tab !== 'published' && (
                    <Tooltip title="Publish this game to the catalogue immediately, bypassing the drip-feed timer">
                      <span>
                        <Button size="small" variant="contained" color="success"
                          disabled={busyId === it.id}
                          startIcon={busyId === it.id ? <CircularProgress size={14} color="inherit" /> : null}
                          onClick={() => publishItemNow(it)}>Publish now</Button>
                      </span>
                    </Tooltip>
                  )}
                  {needsCheck && tab === 'approved' && (
                    <Tooltip title={ownUpload ? 'Another moderator has to check your own upload' : 'Played it, cover/tags/description are fine — let the timer publish it'}>
                      <span>
                        <Button size="small" variant="contained"
                          disabled={busyId === it.id}
                          sx={{ bgcolor: MOD_ACCENT, color: '#1a1a1a', '&:hover': { bgcolor: '#ffab40' } }}
                          onClick={() => checkModUpload(it)}>Looks good</Button>
                      </span>
                    </Tooltip>
                  )}
                  {(tab === 'dismissed' || tab === 'publish_failed') && (
                    <Button size="small" variant="outlined" disabled={busyId === it.id}
                      onClick={() => itemAction(it.id, 'requeue')}>Re-queue</Button>
                  )}
                  {tab !== 'published' && tab !== 'dismissed' && (
                    <Button size="small" variant="outlined" color="warning" disabled={busyId === it.id}
                      onClick={() => itemAction(it.id, 'dismiss')}>Dismiss</Button>
                  )}
                </Box>
                {needsCheck && (
                  <Box sx={{ flexBasis: '100%', display: 'flex', gap: 2, pt: 1, flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
                    <QueueCover id={it.id} />
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', mb: 1 }}>
                        {it.hosted_url && (
                          <a href={it.hosted_url} target="_blank" rel="noopener noreferrer" style={{ color: '#90caf9' }}>▶ Play our copy ↗</a>
                        )}
                        {it.source_url && (
                          <a href={it.source_url} target="_blank" rel="noopener noreferrer" style={{ color: '#90caf9' }}>Original ↗</a>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                        {it.tags.map((t) => <Chip key={t.id} size="small" label={t.name} />)}
                      </Box>
                      <Typography variant="body2" sx={{ color: '#ccc', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>
                        {it.description || 'No description.'}
                      </Typography>
                    </Box>
                  </Box>
                )}
              </Box>
              );
            })}
          </Box>
        )}

        <Divider sx={{ my: 2, borderColor: '#444' }} />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="caption" sx={{ color: '#888' }}>{totalItems} items</Typography>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</Button>
            <Typography variant="caption">{page} / {totalPages}</Typography>
            <Button size="small" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </Box>
        </Box>
      </StyledPaper>

      {editing && (
        <GameMetaDialog
          open
          onClose={() => setEditing(null)}
          title={
            editing.state === 'published' && editing.game
              ? 'Edit published card'
              : 'Edit queued game'
          }
          value={{
            title: editing.title || '',
            aliases: editing.aliases || '',
            authors: editing.authors || [],
            tags: editing.tags || [],
          }}
          fields={editFields(editing)}
          adapter={pickAdapter(editing)}
          onSaved={(patch) => applyMeta(editing.id, patch)}
        />
      )}

      <Snackbar open={!!toast} autoHideDuration={4000} onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? <Alert severity={toast.sev} onClose={() => setToast(null)}>{toast.msg}</Alert> : undefined}
      </Snackbar>
    </Container>
  );
}

const StatBox: React.FC<{ label: string; value?: number | string; accent?: string }> = ({ label, value, accent }) => (
  <Grid item xs={6} sm={4} md={3}>
    <Box sx={{ bgcolor: '#262626', borderRadius: 1, p: 1.5, borderLeft: `3px solid ${accent || '#555'}` }}>
      <Typography variant="h5" sx={{ color: accent || '#e0e0e0' }}>{value ?? '–'}</Typography>
      <Typography variant="caption" sx={{ color: '#999' }}>{label}</Typography>
    </Box>
  </Grid>
);
