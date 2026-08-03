// src/components/ModeratorPanel/SuggestionsPanel.tsx
//
// /moderator/suggestions — the manual gate for user-suggested links from
// /add-next. Approve → state "queued" (the night script picks it up);
// decline → "dismissed" with an optional reason shown to the submitter.
//
// Before approving, a moderator can classify the item inline (no schema change —
// all fields already live on game_pipeline_state):
//   • Rating (type: SFW/Ecchi/NSFW/Extreme) → drives the catalog rating tag +
//     the NSFW gate downstream (s06b_review_gate).
//   • Fresh (data.original) → games.original_release: the green "Fresh" badge /
//     front-page pin for a genuine author release.
//   • Note (data.mod_note) → a PRIVATE note for the night agent that runs the
//     pipeline (distinct from the decline reason, which goes to the submitter).
// Edits save instantly via POST /suggestions/{id}/update and ride the record
// through the pipeline.

import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Paper, Stack, Button, Chip, Link, Alert, CircularProgress,
  TextField,
} from '@mui/material';
import { authedFetch } from '../../pocketbase/pocketbase';

interface Suggestion {
  id: string;
  slug: string;
  url: string;
  type: string;
  note: string;
  mod_note: string;       // private moderator note, seen by the night agent
  original: boolean;      // "Fresh" — genuine author release (games.original_release)
  kind: string;           // "static" for image packs / imgchest links
  submitter: string;
  created: string;
  dup_game_id: string;    // possible catalog duplicate, found server-side
  dup_game_title: string;
}

const RATINGS = ['SFW', 'Ecchi', 'NSFW', 'Extreme'] as const;
type Rating = (typeof RATINGS)[number];

// MUI palette per rating (matches the site's severity read: safe → extreme).
function ratingColor(r: string): 'success' | 'warning' | 'error' | 'default' {
  switch (r) {
    case 'SFW': return 'success';
    case 'Ecchi': return 'warning';
    case 'NSFW': return 'error';
    case 'Extreme': return 'error';
    default: return 'default';
  }
}

export default function SuggestionsPanel() {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);       // approve/decline
  const [patchingId, setPatchingId] = useState<string | null>(null); // inline edits
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await authedFetch('/api/pipeline/suggestions');
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems(data.items || []);
      else setError(data.message || 'Failed to load suggestions');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const act = async (id: string, action: 'approve' | 'decline') => {
    let body: string | undefined;
    if (action === 'decline') {
      const reason = prompt('Reason (shown to the submitter, optional):', '');
      if (reason === null) return;
      body = JSON.stringify({ reason });
    }
    setBusy(id);
    setError('');
    try {
      const res = await authedFetch(`/api/pipeline/suggestions/${id}/${action}`, {
        method: 'POST',
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setItems((prev) => prev.filter((s) => s.id !== id));
      else setError(data.message || `${action} failed`);
    } catch {
      setError('Network error');
    } finally {
      setBusy(null);
    }
  };

  // Inline classification edit (rating / fresh / note). Optimistic-ish: we trust
  // the server echo and patch the local row from the response.
  const patch = async (id: string, fields: Record<string, unknown>): Promise<boolean> => {
    setPatchingId(id);
    setError('');
    try {
      const res = await authedFetch(`/api/pipeline/suggestions/${id}/update`, {
        method: 'POST',
        body: JSON.stringify(fields),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setItems((prev) => prev.map((s) => (s.id === id
          ? {
            ...s,
            type: typeof data.type === 'string' ? data.type : s.type,
            original: typeof data.original === 'boolean' ? data.original : s.original,
            mod_note: typeof data.mod_note === 'string' ? data.mod_note : s.mod_note,
          }
          : s)));
        return true;
      }
      setError(data.message || 'Update failed');
      return false;
    } catch {
      setError('Network error');
      return false;
    } finally {
      setPatchingId(null);
    }
  };

  const saveNote = async (id: string) => {
    const draft = noteDrafts[id] ?? '';
    const ok = await patch(id, { mod_note: draft });
    if (ok) {
      setNoteDrafts((p) => { const n = { ...p }; delete n[id]; return n; });
    }
  };

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto', width: '100%' }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Suggested links {!loading && `(${items.length})`}
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : items.length === 0 ? (
        <Typography color="text.secondary" textAlign="center" sx={{ py: 4 }}>
          No pending suggestions – inbox zero 🎉
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {items.map((s) => {
            const draft = noteDrafts[s.id];
            const noteVal = draft !== undefined ? draft : s.mod_note;
            const noteDirty = draft !== undefined && draft !== s.mod_note;
            const rowBusy = patchingId === s.id;
            return (
            <Paper key={s.id} variant="outlined" sx={{ p: 2 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1.5}
                alignItems={{ sm: 'flex-start' }}
                justifyContent="space-between"
              >
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                    <Link href={s.url} target="_blank" rel="noopener noreferrer" sx={{ wordBreak: 'break-all', fontWeight: 600 }}>
                      {s.url}
                    </Link>
                    {s.kind === 'static' && (
                      <Chip size="small" label="static" color="info" variant="outlined" />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                    {s.submitter ? `by ${s.submitter}` : 'submitter unknown'}
                    {s.created && ` · ${new Date(s.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`}
                    {' · '}{s.slug}
                  </Typography>
                  {s.note && (
                    <Typography variant="body2" sx={{ mt: 0.5, fontStyle: 'italic' }}>
                      “{s.note}”
                    </Typography>
                  )}
                  {s.dup_game_id && (
                    <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
                      Possible duplicate:{' '}
                      <Link href={`/game/${s.dup_game_id}`} target="_blank" rel="noopener noreferrer">
                        {s.dup_game_title || 'catalog entry'}
                      </Link>
                    </Alert>
                  )}

                  {/* ── Inline classification ─────────────────────────────── */}
                  <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 1.25, flexWrap: 'wrap', rowGap: 0.75 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25 }}>Rating:</Typography>
                    {RATINGS.map((rt: Rating) => {
                      const active = s.type === rt;
                      return (
                        <Chip
                          key={rt}
                          label={rt}
                          size="small"
                          color={ratingColor(rt)}
                          variant={active ? 'filled' : 'outlined'}
                          disabled={rowBusy}
                          onClick={() => { if (!active) patch(s.id, { type: rt }); }}
                          sx={{ cursor: 'pointer', opacity: active ? 1 : 0.5 }}
                        />
                      );
                    })}
                    {/* Fresh toggle — matches the green front-page badge. */}
                    <Chip
                      label={s.original ? 'Fresh ✓' : 'Fresh'}
                      size="small"
                      variant={s.original ? 'filled' : 'outlined'}
                      disabled={rowBusy}
                      onClick={() => patch(s.id, { original: !s.original })}
                      sx={{
                        cursor: 'pointer',
                        ml: 0.5,
                        fontWeight: 'bold',
                        ...(s.original
                          ? { backgroundColor: '#71ce6d', color: '#0b3d12', '&:hover': { backgroundColor: '#63c05f' } }
                          : { borderColor: '#71ce6d', color: '#4a9e46', opacity: 0.7 }),
                      }}
                    />
                    {rowBusy && <CircularProgress size={14} sx={{ ml: 0.5 }} />}
                  </Stack>

                  {/* ── Private note for the night agent ──────────────────── */}
                  <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 1 }}>
                    <TextField
                      value={noteVal}
                      onChange={(ev) => setNoteDrafts((p) => ({ ...p, [s.id]: ev.target.value }))}
                      placeholder="Note for the night agent (private)…"
                      size="small"
                      fullWidth
                      multiline
                      maxRows={4}
                      disabled={rowBusy}
                    />
                    <Button
                      variant="text"
                      size="small"
                      disabled={rowBusy || !noteDirty}
                      onClick={() => saveNote(s.id)}
                      sx={{ mt: 0.25, flexShrink: 0 }}
                    >
                      Save
                    </Button>
                  </Stack>
                </Box>

                <Stack direction="row" spacing={1} sx={{ flexShrink: 0, pt: { sm: 0.25 } }}>
                  <Button
                    variant="contained"
                    color="success"
                    size="small"
                    disabled={busy === s.id}
                    onClick={() => act(s.id, 'approve')}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    size="small"
                    disabled={busy === s.id}
                    onClick={() => act(s.id, 'decline')}
                  >
                    Decline
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          );
          })}
        </Stack>
      )}
    </Box>
  );
}
