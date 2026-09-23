// Pipeline review queue + link intake form. Lists games in state="awaiting_review" (already
// uploaded to self-hosting): generated screenshot, description, original link, editable tags, live
// iframe preview, Approve/Reject. Approve sets state=approved; publication into the catalog is done
// by the Go cron publication_queue.go, which copies staged fields (image/tags/description/…) to
// games. The top "submit game URL" field is for end-to-end testing (creates queued). Backend:
// pb_hooks/pipeline_review.pb.js (/api/pipeline/*).

import { useState, useEffect, useContext, useCallback, useMemo } from 'react';
import {
  Container, Typography, Paper, Box, Button, Chip, CircularProgress,
  Collapse, TextField, Snackbar, Alert, Pagination,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { AuthContext, pb, authedFetch } from '../../pocketbase/pocketbase';
import GameMetaEditor from '../GameMeta/GameMetaEditor';
import { pipelineAdapter } from '../GameMeta/adapters';
import { GameMetaValue } from '../GameMeta/types';

interface ReviewTag { id: string; name: string; }

interface ReviewItem {
  id: string;
  slug: string;
  title: string;
  author: string;
  type: string;  // "SFW" | "NSFW" | ""
  hosted_url: string;
  description: string;
  publish_mode: string;  // create | update | skip
  review_reasons: string[];  // dedup ambiguity flags (s06b, dedup v3)
  dedup_note: string;
  dedup_candidate: string;  // suspected-duplicate games record id
  dedup_candidate_title: string;
  moderator_note: string;
  image: string;  // staged cover filename ("" if none) — see ReviewScreenshot
  tags: ReviewTag[];  // resolved catalog tags (relation), editable
  authors: ReviewTag[];  // resolved authors (relation) — source of truth for `author`
  aliases: string;  // aliases, one per line
  has_aliases: boolean;  // the aliases field may not exist in the queue schema yet
  source_url: string;  // original link the game was harvested from
  original_url: string;  // canonical fallback for source_url
  nsfw: boolean;
  community: boolean;  // suggested by a user via /add-next (server sorts these first)
  submitter: string;
}

const REASON_LABEL: Record<string, string> = {
  url_cross_population: 'same URL, other type (port?)',
  title_author_corroborated: 'same title + same author',
  title_semantic_corroborated: 'same title + similar content',
  semantic_098: 'near-identical content',
};

// Live iframes are heavy — never mount more than a page of them at once.
const PER_PAGE = 10;

// The staged cover lives on game_pipeline_state.image (superuser-only collection): a plain <img
// src> would 403. Fetch with the auth token and use an object URL. Auto-loads: eyeballing the cover
// is the point of the card.
function ReviewScreenshot({ id, title }: { id: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objUrl: string | null = null;
    (async () => {
      try {
        const res = await authedFetch(`/api/pipeline/review/${id}/screenshot`, { method: 'GET' });
        if (!res.ok) { if (!cancelled) setFailed(true); return; }
        const blob = await res.blob();
        objUrl = URL.createObjectURL(blob);
        if (cancelled) { URL.revokeObjectURL(objUrl); return; }
        setUrl(objUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [id]);

  if (failed) return null;
  if (!url) {
    return (
      <Box sx={{
        my: 2, height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: '1px dashed #555', borderRadius: 1, color: '#888',
      }}>
        <CircularProgress size={22} />
      </Box>
    );
  }
  return (
    <Box sx={{ my: 2 }}>
      <Box
        component="a"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ display: 'block' }}
      >
        <Box
          component="img"
          src={url}
          alt={`Screenshot of ${title}`}
          sx={{
            display: 'block', width: '100%', maxHeight: 420, objectFit: 'contain',
            objectPosition: 'top', borderRadius: 1, border: '1px solid #555', bgcolor: '#1c1c1c',
          }}
        />
      </Box>
    </Box>
  );
}

export default function PipelineReviewPanel() {
  const { signedIn, isModerator } = useContext(AuthContext);
  const navigate = useNavigate();

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState<string | null>(null);

  const [openEdit, setOpenEdit] = useState<Record<string, boolean>>({});

  const [submitUrl, setSubmitUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; sev: 'success' | 'error' } | null>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [openFrame, setOpenFrame] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) =>
      (it.title || '').toLowerCase().includes(q)
      || (it.author || '').toLowerCase().includes(q)
      || (it.slug || '').toLowerCase().includes(q));
  }, [items, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  useEffect(() => {
    if (!signedIn || !isModerator) navigate('/');
  }, [signedIn, isModerator, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await pb.send('/api/pipeline/review', { method: 'GET' });
      setItems(res?.items ?? []);
    } catch (err) {
      console.error('Failed to load review queue', err);
      setToast({ msg: 'Failed to load review queue', sev: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (signedIn && isModerator) load();
  }, [signedIn, isModerator, load]);

  // Apply the editor's saved patch to the list row without reloading the heavy queue (screenshots +
  // live iframes).
  const applyMeta = (id: string, patch: Partial<GameMetaValue>) => {
    setItems((prev) => prev.map((it) => {
      if (it.id !== id) return it;
      const upd = { ...it };
      if (patch.title !== undefined) upd.title = patch.title;
      if (patch.aliases !== undefined) upd.aliases = patch.aliases;
      if (patch.authors !== undefined) {
        upd.authors = patch.authors.map((a) => ({ id: a.id, name: a.name }));
        // The server rewrites text `author` from the selected authors' names.
        upd.author = upd.authors.map((a) => a.name).join(', ');
      }
      if (patch.tags !== undefined) upd.tags = patch.tags.map((t) => ({ id: t.id, name: t.name }));
      return upd;
    }));
    setToast({ msg: 'Saved', sev: 'success' });
  };

  const act = async (id: string, action: 'approve' | 'reject') => {
    if (action === 'reject' && !window.confirm('Reject this game? It will not be published.')) return;
    setBusyId(id);
    try {
      await pb.send(`/api/pipeline/review/${id}/${action}`, { method: 'POST' });
      setItems((prev) => prev.filter((it) => it.id !== id));
      setToast({
        msg: action === 'approve' ? 'Approved – will be published on next worker run' : 'Rejected',
        sev: 'success',
      });
    } catch (err) {
      console.error(`${action} failed`, err);
      setToast({ msg: `${action} failed – see console`, sev: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const saveNote = async (id: string) => {
    setSavingNote(id);
    try {
      await pb.send(`/api/pipeline/review/${id}/note`, {
        method: 'POST',
        body: { note: noteDraft[id] ?? '' },
      });
      setItems((prev) => prev.map((it) =>
        it.id === id ? { ...it, moderator_note: noteDraft[id] ?? '' } : it));
      setToast({ msg: 'Note saved', sev: 'success' });
    } catch (err) {
      console.error('save note failed', err);
      setToast({ msg: 'Failed to save note', sev: 'error' });
    } finally {
      setSavingNote(null);
    }
  };

  const submit = async () => {
    const url = submitUrl.trim();
    if (!url) return;
    setSubmitting(true);
    try {
      const res = await pb.send('/api/pipeline/submit', {
        method: 'POST',
        body: { source_url: url },
      });
      setSubmitUrl('');
      setToast({
        msg: res?.duplicate ? `Already queued/known (${res.slug})` : `Queued for processing (${res.slug})`,
        sev: 'success',
      });
    } catch (err) {
      console.error('submit failed', err);
      setToast({ msg: 'Submit failed – check the URL', sev: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  if (!signedIn || !isModerator) return null;

  return (
    <Container maxWidth="lg" sx={{ px: { xs: 1, sm: 3 } }}>
      <Typography
        variant="h4"
        sx={{ mt: 4, mb: 2, color: '#e0e0e0', textAlign: 'center' }}
      >
        Review queue {loading ? '' : `(${items.length})`}
      </Typography>

      <Paper sx={{ p: 2.5, mb: 3, bgcolor: '#2e2e2e', color: '#e0e0e0', borderRadius: 2 }}>
        <Typography variant="h6" gutterBottom>Submit a game URL for processing</Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
          <TextField
            fullWidth
            size="small"
            placeholder="https://author.neocities.org/game/"
            value={submitUrl}
            onChange={(e) => setSubmitUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            InputProps={{ style: { color: '#e0e0e0' } }}
            sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
          />
          <Button
            variant="contained"
            onClick={submit}
            disabled={submitting || !submitUrl.trim()}
            startIcon={submitting ? <CircularProgress size={18} color="inherit" /> : null}
            sx={{ whiteSpace: 'nowrap' }}
          >
            Queue it
          </Button>
        </Box>
        <Typography variant="caption" sx={{ color: '#888' }}>
          The nightly worker downloads, mirrors and sends it back here for review.
        </Typography>
      </Paper>

      {loading && (
        <Box sx={{ textAlign: 'center', mt: 4 }}><CircularProgress /></Box>
      )}

      {!loading && items.length === 0 && (
        <Typography sx={{ textAlign: 'center', color: '#888', mt: 6 }}>
          No games awaiting review 🎉
        </Typography>
      )}

      {!loading && items.length > 0 && (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            placeholder="Search: title / author / slug…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            InputProps={{ style: { color: '#e0e0e0' } }}
            sx={{ minWidth: 280, '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
          />
          <Typography variant="body2" sx={{ color: '#888' }}>
            {filtered.length === items.length
              ? `${filtered.length} games`
              : `${filtered.length} of ${items.length} games`}
          </Typography>
          {pageCount > 1 && (
            <Pagination
              count={pageCount}
              page={safePage}
              onChange={(_, p) => { setPage(p); window.scrollTo(0, 0); }}
              sx={{ ml: 'auto', '& .MuiPaginationItem-root': { color: '#e0e0e0' } }}
            />
          )}
        </Box>
      )}

      {pageItems.map((it) => {
        const link = it.source_url || it.original_url || '';
        return (
        <Paper key={it.id} sx={{ p: { xs: 1.5, sm: 3 }, my: 3, bgcolor: '#2e2e2e', color: '#e0e0e0', borderRadius: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
            <Typography variant="h6">{it.title || it.slug}</Typography>
            <Typography sx={{ color: '#aaa' }}>by {it.author || 'unknown'}</Typography>
            <Chip
              size="small"
              label={it.type || (it.nsfw ? 'NSFW' : 'type not set')}
              color={it.type === 'NSFW' || it.nsfw ? 'error' : it.type === 'SFW' ? 'success' : 'warning'}
            />
            {it.publish_mode && it.publish_mode !== 'create' && (
              <Chip size="small" variant="outlined" color="info" label={`mode: ${it.publish_mode}`} />
            )}
            {it.community && (
              <Chip
                size="small"
                color="secondary"
                label={it.submitter ? `suggested by ${it.submitter}` : 'community suggestion'}
              />
            )}
          </Box>

          {(it.review_reasons?.length > 0 || it.dedup_note) && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: it.dedup_note ? 0.5 : 0 }}>
                {it.review_reasons?.map((r) => (
                  <Chip key={r} size="small" color="warning"
                    label={REASON_LABEL[r] || r} />
                ))}
              </Box>
              {it.dedup_note && (
                <Typography variant="body2">
                  {it.dedup_note}
                  {it.dedup_candidate && (
                    <>
                      {' – '}
                      <a
                        href={`/game/${it.dedup_candidate}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#90caf9' }}
                      >
                        {it.dedup_candidate_title || it.dedup_candidate} ↗
                      </a>
                    </>
                  )}
                </Typography>
              )}
            </Alert>
          )}

          {link && (
            <Typography variant="body2" sx={{ color: '#aaa', mb: 1, wordBreak: 'break-all' }}>
              Source:{' '}
              <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: '#90caf9' }}>
                {link} ↗
              </a>
            </Typography>
          )}

          {it.image && <ReviewScreenshot id={it.id} title={it.title || it.slug} />}

          {it.description ? (
            <Box
              sx={{
                my: 1.5, p: 1.5, bgcolor: '#262626', borderRadius: 1,
                maxHeight: 220, overflowY: 'auto',
              }}
            >
              <Typography variant="body2" sx={{ color: '#ccc', whiteSpace: 'pre-wrap' }}>
                {it.description}
              </Typography>
            </Box>
          ) : (
            <Typography variant="body2" sx={{ color: '#888', my: 1.5, fontStyle: 'italic' }}>
              No description.
            </Typography>
          )}

          <Box sx={{ my: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ color: '#e0e0e0' }}>Tags</Typography>
              <Button
                size="small"
                onClick={() => setOpenEdit((p) => ({ ...p, [it.id]: !p[it.id] }))}
              >
                {openEdit[it.id] ? 'Done editing' : 'Edit title / authors / tags'}
              </Button>
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {it.tags.map((t) => (
                <Chip key={t.id} size="small" label={t.name} />
              ))}
              {it.tags.length === 0 && (
                <Typography variant="caption" sx={{ color: '#888' }}>No tags</Typography>
              )}
            </Box>
            {it.aliases && (
              <Typography variant="caption" sx={{ color: '#888', display: 'block', mt: 0.5 }}>
                aka {it.aliases.split('\n').filter(Boolean).join(' · ')}
              </Typography>
            )}
            <Collapse in={!!openEdit[it.id]} unmountOnExit>
              <Box sx={{ mt: 1.5, borderTop: '1px solid #444', pt: 1.5 }}>
                <GameMetaEditor
                  value={{
                    title: it.title || '',
                    aliases: it.aliases || '',
                    authors: it.authors || [],
                    tags: it.tags || [],
                  }}
                  fields={['title', 'aliases', 'authors', 'tags']}
                  adapter={pipelineAdapter(it.id, { aliases: it.has_aliases !== false })}
                  onSaved={(patch) => applyMeta(it.id, patch)}
                  saveLabel="Save metadata"
                  dense
                />
              </Box>
            </Collapse>
          </Box>

          <Box sx={{ my: 2 }}>
            <Button size="small" href={it.hosted_url} target="_blank" rel="noopener noreferrer">
              Open in new tab ↗
            </Button>
            {openFrame[it.id] ? (
              <Box
                component="iframe"
                src={it.hosted_url}
                title={it.slug}
                sandbox="allow-scripts allow-same-origin allow-popups"
                sx={{
                  mt: 1, height: '70vh', border: '1px solid #555',
                  width: { xs: '100vw', md: '100%' },
                  ml: { xs: 'calc(50% - 50vw)', md: 0 },
                  borderRadius: { xs: 0, md: 1 },
                  borderLeft: { xs: 'none', md: '1px solid #555' },
                  borderRight: { xs: 'none', md: '1px solid #555' },
                }}
              />
            ) : (
              <Box
                onClick={() => setOpenFrame((p) => ({ ...p, [it.id]: true }))}
                sx={{
                  mt: 1, py: 6, textAlign: 'center', cursor: 'pointer',
                  border: '1px dashed #555', color: '#888', '&:hover': { bgcolor: '#383838' },
                  width: { xs: '100vw', md: '100%' },
                  ml: { xs: 'calc(50% - 50vw)', md: 0 },
                  borderRadius: { xs: 0, md: 1 },
                  borderLeft: { xs: 'none', md: '1px dashed #555' },
                  borderRight: { xs: 'none', md: '1px dashed #555' },
                }}
              >
                ▶ Load live preview
              </Box>
            )}
          </Box>

          {/* Moderator note: free text, audit trail for another moderator. */}
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 2 }}>
            <TextField
              fullWidth
              size="small"
              multiline
              maxRows={4}
              placeholder="Moderator note (optional)…"
              value={noteDraft[it.id] ?? it.moderator_note ?? ''}
              onChange={(e) => setNoteDraft((p) => ({ ...p, [it.id]: e.target.value }))}
              InputProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}
            />
            <Button
              variant="outlined"
              disabled={savingNote === it.id || (noteDraft[it.id] ?? it.moderator_note ?? '') === (it.moderator_note ?? '')}
              onClick={() => saveNote(it.id)}
              startIcon={savingNote === it.id ? <CircularProgress size={16} color="inherit" /> : null}
              sx={{ whiteSpace: 'nowrap', mt: 0.25 }}
            >
              Save note
            </Button>
          </Box>

          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              variant="contained"
              color="success"
              disabled={busyId === it.id}
              onClick={() => act(it.id, 'approve')}
            >
              Approve → publish
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={busyId === it.id}
              onClick={() => act(it.id, 'reject')}
            >
              Reject
            </Button>
          </Box>
        </Paper>
        );
      })}

      <Snackbar
        open={!!toast}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.sev} onClose={() => setToast(null)} variant="filled">
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Container>
  );
}
