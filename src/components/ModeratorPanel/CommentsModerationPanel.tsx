import { Fragment, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Link, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import { authedFetch } from '../../pocketbase/pocketbase';
import CommentBody from '../CyoaPage/Comments/CommentBody';
import { BUILD_MARKER } from '../CyoaPage/Comments/buildComment';
import { deleteComment, pinComment } from '../CyoaPage/Comments/commentsApi';

type Entry = {
  id: string; content: string; created: string; updated: string; parent: string;
  game: string; game_title: string; game_slug: string; author: string; author_name: string;
  deleted: boolean; pinned: boolean; replies: number; parent_content: string; parent_author: string;
};
type Note = { id: string; anchor: string; anchor_created: string; game: string; game_title: string; author_name: string; content: string; kind: string; scope: string; created: string };
type Page<T> = { items: T[]; next: string; notes_available?: boolean };
const date = (s: string) => new Date(s).toLocaleString();
const commentURL = (c: Entry) => `/game/${encodeURIComponent(c.game_slug || c.game)}#comment-${c.id}`;
const message = (e: unknown) => e instanceof Error ? e.message : 'Request failed';
async function request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const res = await authedFetch(`/api/custom/mod/comments${path}`, {
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function NoteCard({ note }: { note: Note }) {
  return <Paper variant="outlined" sx={{ p: 2, my: 1, borderColor: note.kind === 'checkpoint' ? 'success.main' : 'info.main', borderLeftWidth: 4 }}>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      <Chip size="small" color={note.kind === 'checkpoint' ? 'success' : 'info'} label={note.kind === 'checkpoint' ? 'Review checkpoint' : 'Internal note'} />
      <Typography variant="caption">{note.author_name} · {date(note.created)}</Typography>
    </Stack>
    <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', mt: 1 }}>{note.content}</Typography>
    {note.scope && <Typography variant="caption" color="text.secondary" display="block">View at time of review: {note.scope}</Typography>}
  </Paper>;
}

function Thread({ target }: { target: Entry }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (cursor = '', signal?: AbortSignal) => {
    setBusy(true); setError('');
    try {
      const data = await request<Page<Entry>>(`/${target.id}/thread?${new URLSearchParams({ cursor })}`, undefined, signal);
      if (signal?.aborted) return;
      setRows(old => cursor ? [...old, ...data.items.filter(r => !old.some(o => o.id === r.id))] : data.items); setNext(data.next);
    } catch (e) { if (!signal?.aborted) setError(message(e)); }
    finally { if (!signal?.aborted) setBusy(false); }
  };
  useEffect(() => {
    const controller = new AbortController(); void load('', controller.signal);
    return () => controller.abort();
    // A thread component is keyed by comment id and remounted when reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);
  const byID = new Map(rows.map(r => [r.id, r]));
  const depth = (row: Entry) => {
    const seen = new Set([row.id]); let parent = row.parent; let n = 0;
    while (parent && byID.has(parent) && !seen.has(parent)) { seen.add(parent); n++; parent = byID.get(parent)!.parent; }
    return Math.min(n, 5);
  };
  return <Box sx={{ mt: 2, borderTop: 1, borderColor: 'divider', pt: 2 }}>
    <Typography variant="subtitle2">Discussion · oldest first · all comment types</Typography>
    {rows.map(row => <Paper key={row.id} variant="outlined" sx={{ p: 1.5, my: 1, ml: { xs: Math.min(depth(row), 2), sm: depth(row) * 2 }, borderColor: row.id === target.id ? 'primary.main' : 'divider' }}>
      <Typography variant="caption">{row.author_name} · {date(row.created)} · <Link href={commentURL(row)} target="_blank" rel="noopener">Open comment ↗</Link></Typography>
      {row.parent && <Typography variant="caption" display="block" color="text.secondary">Reply to {row.parent_author || 'deleted author'} · {row.parent}</Typography>}
      {row.deleted ? <Typography color="text.secondary">Deleted comment</Typography> : <CommentBody content={row.content} />}
    </Paper>)}
    {error && <Alert severity="error" action={<Button onClick={() => void load(next)}>Retry</Button>}>{error}</Alert>}
    {busy && <CircularProgress size={22} />}
    {next && !busy && <Button onClick={() => void load(next)}>Load more of this discussion</Button>}
  </Box>;
}

export default function CommentsModerationPanel() {
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const journal = params.get('view') === 'notes';
  const [search, setSearch] = useState(params.get('q') || '');
  const [rows, setRows] = useState<Entry[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [next, setNext] = useState('');
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ entry: Entry; kind: 'note' | 'checkpoint' } | null>(null);
  const [text, setText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Entry | null>(null);
  const generation = useRef(0);
  const requestController = useRef<AbortController>();
  const queryRef = useRef(query); queryRef.current = query;
  const scope = [params.get('type') || 'all', params.get('q') && `search: ${params.get('q')}`, params.get('game') && `game: ${params.get('game')}`, params.get('author') && `author: ${params.get('author')}`, params.get('replies') && `replies: ${params.get('replies')}`].filter(Boolean).join(' · ');
  const change = (key: string, value: string) => { const p = new URLSearchParams(params); if (value) p.set(key, value); else p.delete(key); setParams(p); };

  async function load(cursor = '') {
    requestController.current?.abort();
    const controller = new AbortController(); requestController.current = controller;
    const token = ++generation.current;
    const valid = () => !controller.signal.aborted && token === generation.current && queryRef.current === query;
    setBusy(true); setError('');
    const q = new URLSearchParams(query); q.set('cursor', cursor);
    try {
      if (journal) {
        const data = await request<Page<Note>>(`/notes?${q}`, undefined, controller.signal);
        if (!valid()) return;
        setNotes(old => cursor ? [...old, ...data.items] : data.items); setNext(data.next);
      } else {
        const data = await request<Page<Entry>>(`?${q}`, undefined, controller.signal);
        if (!valid()) return;
        setRows(old => cursor ? [...old, ...data.items.filter(r => !old.some(o => o.id === r.id))] : data.items);
        setNext(data.next); setAvailable(!!data.notes_available);
        if (!cursor) setNotes([]);
        if (data.notes_available && data.items.length) {
          const nq = new URLSearchParams({ anchors: data.items.map(r => r.id).join(',') });
          let more = ''; const found: Note[] = [];
          do {
            nq.set('cursor', more);
            const page = await request<Page<Note>>(`/notes?${nq}`, undefined, controller.signal);
            if (!valid()) return;
            found.push(...page.items); more = page.next;
          } while (more);
          setNotes(old => cursor ? [...old, ...found.filter(n => !old.some(o => o.id === n.id))] : found);
        }
      }
    } catch (e) { if (valid()) setError(message(e)); }
    finally { if (valid()) setBusy(false); }
  }
  useEffect(() => {
    setRows([]); setNotes([]); setNext(''); setOpenThreads(new Set()); setSearch(params.get('q') || '');
    void load();
    return () => { requestController.current?.abort(); };
    // query is the complete URL filter state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function saveNote() {
    if (!draft) return;
    setSaving(true); setError('');
    try {
      await request('/notes', { anchor: draft.entry.id, kind: draft.kind, content: text, scope });
      setDraft(null); setNotice('Internal note saved. Visible only to comment moderators.');
      // Refresh notes only: preserve the moderator's position in the feed.
      const q = new URLSearchParams({ anchors: draft.entry.id });
      const found: Note[] = []; let more = '';
      do { q.set('cursor', more); const page = await request<Page<Note>>(`/notes?${q}`); found.push(...page.items); more = page.next; } while (more);
      setNotes(old => [...old.filter(n => n.anchor !== draft.entry.id), ...found]);
    } catch (e) { setError(message(e)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!deleteTarget) return;
    setSaving(true); setError('');
    try {
      await deleteComment(deleteTarget.id);
      setRows(old => old.map(r => r.id === deleteTarget.id ? { ...r, deleted: true, content: '' } : r));
      setOpenThreads(new Set()); setDeleteTarget(null); setNotice('Comment deleted. Refresh to update reply counts.');
    } catch (e) { setError(message(e)); }
    finally { setSaving(false); }
  }
  async function pin(row: Entry) {
    setSaving(true); setError('');
    try { await pinComment(row.id, !row.pinned); setRows(old => old.map(r => r.id === row.id ? { ...r, pinned: !r.pinned } : r)); }
    catch (e) { setError(message(e)); } finally { setSaving(false); }
  }
  return <Box sx={{ maxWidth: 1100, mx: 'auto', py: 3 }}>
    <Typography variant="h4" component="h1">Comment moderation</Typography>
    <Typography color="text.secondary" sx={{ my: 1 }}>Site-wide comments, newest first. Internal notes and review checkpoints stay private.</Typography>
    <Stack direction="row" gap={1} flexWrap="wrap" sx={{ my: 2 }}>
      <Button variant={!journal ? 'contained' : 'outlined'} onClick={() => change('view', '')}>Comments</Button>
      <Button variant={journal ? 'contained' : 'outlined'} onClick={() => change('view', 'notes')}>Notes & checkpoints</Button>
      <Button disabled={busy} onClick={() => { setOpenThreads(new Set()); void load(); }}>Refresh newest</Button>
    </Stack>
    {!journal && <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Box component="form" onSubmit={e => { e.preventDefault(); change('q', search.trim()); }} sx={{ display: 'flex', gap: 1, mb: 2 }}>
        <TextField size="small" fullWidth label="Search text, game or author" value={search} onChange={e => setSearch(e.target.value)} inputProps={{ maxLength: 200 }} />
        <Button type="submit">Search</Button>
      </Box>
      <Stack direction="row" gap={2} flexWrap="wrap">
        <TextField id="mod-comment-type" select size="small" label="Type" value={params.get('type') || 'all'} onChange={e => change('type', e.target.value)} sx={{ minWidth: 170 }}>
          <MenuItem value="all">All posts</MenuItem><MenuItem value="comments">Comments only</MenuItem><MenuItem value="builds">Builds only</MenuItem>
        </TextField>
        <TextField id="mod-comment-replies" select size="small" label="Replies" value={params.get('replies') || 'any'} onChange={e => change('replies', e.target.value === 'any' ? '' : e.target.value)} sx={{ minWidth: 170 }}>
          <MenuItem value="any">Any</MenuItem><MenuItem value="yes">Has replies</MenuItem><MenuItem value="no">No replies</MenuItem>
        </TextField>
        {['game', 'author'].map(k => params.get(k) && <Chip key={k} label={`${k}: ${params.get(k)}`} onDelete={() => change(k, '')} />)}
        <Button onClick={() => setParams({})}>Reset filters</Button>
      </Stack>
    </Paper>}
    {!available && !journal && <Alert severity="info" sx={{ mb: 2 }}>The feed works now. Internal notes require the owner to run PB/add_comment_moderation_notes.py manually.</Alert>}
    {error && <Alert severity="error" sx={{ my: 2 }} onClose={() => setError('')}>{error}</Alert>}
    {notice && <Alert severity="success" sx={{ my: 2 }} onClose={() => setNotice('')}>{notice}</Alert>}
    {journal ? notes.map(note => <Box key={note.id} sx={{ mb: 3 }}>
      <NoteCard note={note} />
      <Typography variant="caption">At comment from {date(note.anchor_created)} · <Link href={`/game/${encodeURIComponent(note.game)}#comment-${note.anchor}`} target="_blank" rel="noopener">{note.game_title || 'Game'} ↗</Link> · anchor: {note.anchor}</Typography>
    </Box>) : rows.map(row => <Fragment key={row.id}>
      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, my: 2 }}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ mb: 1 }}>
          <Link href={commentURL(row)} target="_blank" rel="noopener" fontWeight={700}>{row.game_title} ↗</Link>
          <Chip size="small" label={row.content.includes(BUILD_MARKER) ? 'Build' : 'Comment'} />
          {row.pinned && <Chip size="small" label="Pinned" color="info" />}
          {row.deleted && <Chip size="small" label="Deleted" />}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{row.author_name} · {date(row.created)}{row.updated !== row.created && ` · updated ${date(row.updated)}`} · {row.replies} {row.replies === 1 ? 'reply' : 'replies'}</Typography>
        {row.parent && <Box sx={{ borderLeft: 3, borderColor: 'divider', pl: 1.5, mb: 2 }}>
          <Typography variant="caption">Reply to {row.parent_author || 'deleted author'} · <Link href={`/game/${encodeURIComponent(row.game_slug)}#comment-${row.parent}`} target="_blank" rel="noopener">parent comment ↗</Link></Typography>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{row.parent_content || 'Parent unavailable'}</Typography>
        </Box>}
        {row.deleted ? <Typography color="text.secondary">Deleted comment</Typography> : <CommentBody content={row.content} />}
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2 }}>
          <Button size="small" onClick={() => setOpenThreads(old => { const s = new Set(old); if (s.has(row.id)) s.delete(row.id); else s.add(row.id); return s; })}>{openThreads.has(row.id) ? 'Hide discussion' : 'Expand discussion'}</Button>
          <Button size="small" onClick={() => change('game', row.game)}>This game</Button>
          {row.author && <Button size="small" onClick={() => change('author', row.author)}>This author</Button>}
          {!row.parent && !row.deleted && <Button size="small" disabled={saving} onClick={() => void pin(row)}>{row.pinned ? 'Unpin' : 'Pin'}</Button>}
          {!row.deleted && <Button size="small" color="error" disabled={saving} onClick={() => setDeleteTarget(row)}>Delete</Button>}
        </Stack>
        {openThreads.has(row.id) && <Thread key={row.id} target={row} />}
      </Paper>
      {notes.filter(n => n.anchor === row.id).sort((a, b) => a.created.localeCompare(b.created)).map(note => <NoteCard key={note.id} note={note} />)}
      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ pl: 2, mb: 2 }}>
        <Button size="small" disabled={!available || row.deleted} onClick={() => { setDraft({ entry: row, kind: 'note' }); setText(''); }}>+ Internal note here</Button>
        <Button size="small" color="success" disabled={!available || row.deleted} onClick={() => { setDraft({ entry: row, kind: 'checkpoint' }); setText('Checked through this comment.'); }}>✓ Checked to here</Button>
      </Stack>
    </Fragment>)}
    {!busy && !error && (journal ? notes : rows).length === 0 && <Alert severity="info">{journal ? 'No internal notes yet.' : 'No comments match these filters.'}</Alert>}
    {busy && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={28} /></Box>}
    {next && !busy && <Button fullWidth variant="outlined" onClick={() => void load(next)}>Load older {journal ? 'notes' : 'comments'}</Button>}
    <Dialog open={!!draft} onClose={() => { if (!saving) setDraft(null); }} fullWidth maxWidth="sm">
      <DialogTitle>{draft?.kind === 'checkpoint' ? 'Review checkpoint' : 'Internal moderator note'}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>Attached after {draft?.entry.author_name}’s comment in {draft?.entry.game_title}. Only comment moderators can read this.</Typography>
        {draft?.kind === 'checkpoint' && <Alert severity="info" sx={{ mb: 2 }}>This records your review position, not an automatic approval of other comments. Current view: {scope}</Alert>}
        <TextField autoFocus fullWidth multiline minRows={3} label="Note" value={text} onChange={e => setText(e.target.value)} inputProps={{ maxLength: 4000 }} />
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions><Button disabled={saving} onClick={() => setDraft(null)}>Cancel</Button><Button disabled={saving || !text.trim()} onClick={() => void saveNote()}>Save private note</Button></DialogActions>
    </Dialog>
    <Dialog open={!!deleteTarget} onClose={() => { if (!saving) setDeleteTarget(null); }}>
      <DialogTitle>Delete this comment?</DialogTitle>
      <DialogContent><Typography>By {deleteTarget?.author_name} in {deleteTarget?.game_title}. Existing replies will be preserved.</Typography>{error && <Alert severity="error">{error}</Alert>}</DialogContent>
      <DialogActions><Button disabled={saving} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button color="error" disabled={saving} onClick={() => void remove()}>Delete comment</Button></DialogActions>
    </Dialog>
  </Box>;
}
