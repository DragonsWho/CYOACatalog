// src/components/AddGame/SuggestLink.tsx
//
// Section ① of /add-next: paste a link → the night pipeline does the rest.
// Talks to POST /api/pipeline/submit (suggested state for regular users),
// GET /api/pipeline/my-submissions and GET /api/pipeline/suggestions/public.

import { useState, useEffect, useCallback, useContext } from 'react';
import {
  Box, Button, TextField, Typography, Alert, Stack, Chip, Link,
  ToggleButton, ToggleButtonGroup, CircularProgress, Collapse,
  List, ListItem, ListItemText, Divider, Checkbox, FormControlLabel,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import { Link as RouterLink } from 'react-router-dom';
import { AuthContext, authedFetch, gamesCollectionPublic } from '../../pocketbase/pocketbase';

type PublicStatus =
  | 'pending' | 'queued' | 'processing' | 'review'
  | 'published' | 'failed' | 'declined';

interface MySubmission {
  id: string;
  url: string;
  title: string;
  status: PublicStatus;
  detail: string;
  game_id: string;
  slug?: string; // pretty-URL key, resolved client-side from game_id (pipeline API returns only id)
  created: string;
}

interface QueueItem {
  title: string;
  url: string;
  status: PublicStatus;
  created: string;
}

const STATUS_CHIP: Record<PublicStatus, { label: string; color: 'default' | 'info' | 'warning' | 'success' | 'error' }> = {
  pending: { label: 'Waiting for check', color: 'default' },
  queued: { label: 'In queue', color: 'info' },
  processing: { label: 'Processing', color: 'info' },
  review: { label: 'Final review', color: 'warning' },
  published: { label: 'Published', color: 'success' },
  failed: { label: "Couldn't process", color: 'error' },
  declined: { label: 'Declined', color: 'default' },
};

const hostOf = (url: string) => {
  const m = url.match(/^https?:\/\/([^/]+)/i);
  return m ? m[1] : url;
};

// Cloudflare cuts request bodies around 100 MB, so big packs are sent in
// several ~45 MB batches: the first creates the suggestion, the rest append
// to it via /api/pipeline/submit/{id}/pages. Only a single file over the
// per-request ceiling is truly impossible.
const MAX_FILE_MB = 95; // per-request Cloudflare ceiling → hard cap per file
const MAX_UPLOAD_FILES = 300; // server-side cyoa_pages cap
const BATCH_MB = 45; // safety margin under the per-request limit

export default function SuggestLink() {
  const { signedIn } = useContext(AuthContext);

  const [url, setUrl] = useState('');
  const [kind, setKind] = useState<'interactive' | 'static'>('interactive');
  // Rating mirrors the catalog rating tags. Default NSFW on purpose: a wrong
  // "NSFW" hides a safe game behind a click, a wrong "SFW" leaks porn onto
  // the safe side of the site.
  const [rating, setRating] = useState<'SFW' | 'Ecchi' | 'NSFW' | 'Extreme'>('NSFW');
  const [note, setNote] = useState('');
  // Static CYOA page images attached instead of (or alongside) a link.
  const [files, setFiles] = useState<File[]>([]);
  // "I'm the author" — original release; gets pinned on the front page.
  const [original, setOriginal] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ severity: 'success' | 'info' | 'error'; node: React.ReactNode } | null>(null);

  const [mine, setMine] = useState<MySubmission[]>([]);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [pipelineTotal, setPipelineTotal] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);

  const fetchMine = useCallback(async () => {
    if (!signedIn) { setMine([]); return; }
    try {
      const res = await authedFetch('/api/pipeline/my-submissions');
      if (res.ok) {
        const data = await res.json();
        const items: MySubmission[] = data.items || [];
        // The pipeline API returns only game_id; resolve pretty slugs in one batch
        // so "published" links go to /game/<slug> like everywhere else (id-fallback
        // if a game has no slug). Cosmetic — failure just leaves the id link.
        const ids = [...new Set(items.map((s) => s.game_id).filter(Boolean))];
        if (ids.length) {
          try {
            const games = await gamesCollectionPublic.getFullList({
              filter: ids.map((id) => `id="${id}"`).join(' || '), fields: 'id,slug',
            });
            const slugById = new Map(games.map((g) => [g.id, (g as { slug?: string }).slug]));
            for (const s of items) { const sl = slugById.get(s.game_id); if (sl) s.slug = sl; }
          } catch { /* slug is cosmetic — keep id links */ }
        }
        setMine(items);
      }
    } catch { /* list is auxiliary — stay quiet */ }
  }, [signedIn]);

  const fetchQueue = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline/suggestions/public');
      if (res.ok) {
        const data = await res.json();
        setQueueCount(data.count ?? 0);
        setQueueItems(data.items || []);
        setPipelineTotal(data.pipeline_total ?? 0);
      }
    } catch { /* same */ }
  }, []);

  useEffect(() => { fetchMine(); }, [fetchMine]);
  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  const isUpload = kind === 'static' && files.length > 0;
  const uploadMB = files.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
  const uploadTooBig =
    files.length > MAX_UPLOAD_FILES ||
    files.some((f) => f.size > MAX_FILE_MB * 1024 * 1024);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() && !isUpload) return;
    setSubmitting(true);
    setResult(null);
    try {
      // Pack attached files into batches under the per-request size limit;
      // the first batch creates the suggestion, the rest append to it.
      const batches: File[][] = [];
      if (isUpload) {
        let cur: File[] = [];
        let curBytes = 0;
        for (const f of files) {
          if (cur.length && (curBytes + f.size > BATCH_MB * 1024 * 1024 || cur.length >= 100)) {
            batches.push(cur);
            cur = [];
            curBytes = 0;
          }
          cur.push(f);
          curBytes += f.size;
        }
        if (cur.length) batches.push(cur);
      }

      let body: FormData | string;
      if (isUpload) {
        const fd = new FormData();
        fd.append('source_url', url.trim());
        fd.append('type', rating);
        fd.append('kind', kind);
        fd.append('note', note.trim());
        fd.append('original', original ? 'true' : 'false');
        batches[0].forEach((f) => fd.append('pages', f));
        body = fd;
      } else {
        body = JSON.stringify({
          source_url: url.trim(),
          type: rating,
          kind,
          note: note.trim(),
          original,
        });
      }
      if (batches.length > 1) setUploadProgress(`Uploading batch 1 of ${batches.length}…`);
      const res = await authedFetch('/api/pipeline/submit', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.duplicate) {
        if (data.where === 'catalog' && data.game_id) {
          // Pipeline API returns only the id; resolve the pretty slug so the link
          // matches the rest of the site (id-fallback if lookup fails / no slug).
          let dupKey: string = data.game_id;
          try {
            const g = await gamesCollectionPublic.getOne(data.game_id, { fields: 'id,slug' });
            if ((g as { slug?: string }).slug) dupKey = (g as { slug?: string }).slug!;
          } catch { /* keep id — GameDetails redirects it to the slug anyway */ }
          setResult({
            severity: 'info',
            node: (
              <>
                Good news – this game is already in the catalog:{' '}
                <Link component={RouterLink} to={`/game/${dupKey}`}>
                  {data.title || 'open its page'}
                </Link>
                .
              </>
            ),
          });
        } else if (data.where === 'declined') {
          setResult({
            severity: 'info',
            node: <>This link was suggested before and reviewed – the moderators decided not to add it.</>,
          });
        } else {
          setResult({
            severity: 'info',
            node: <>This link is already in the queue – it will show up in the catalog once it's processed.</>,
          });
        }
      } else if (res.ok) {
        // Remaining batches append to the record created by the first request.
        let appendFailed = 0;
        for (let i = 1; i < batches.length; i++) {
          setUploadProgress(`Uploading batch ${i + 1} of ${batches.length}…`);
          const fd = new FormData();
          batches[i].forEach((f) => fd.append('pages', f));
          try {
            const r2 = await authedFetch(`/api/pipeline/submit/${data.id}/pages`, { method: 'POST', body: fd });
            if (!r2.ok) appendFailed += batches[i].length;
          } catch {
            appendFailed += batches[i].length;
          }
        }
        setUrl('');
        setNote('');
        setRating('NSFW');
        setFiles([]);
        setOriginal(false);
        setResult(appendFailed > 0
          ? {
            severity: 'info',
            node: <>Submitted, but {appendFailed} of {files.length} images failed to upload – the pack is partial. Try suggesting the missing pages again or mention it in the note.</>,
          }
          : {
            severity: 'success',
            node: <>Thanks! Your suggestion is in. A moderator will take a look, then our script picks it up – usually within a day or two. Track it below.</>,
          });
        fetchMine();
        fetchQueue();
      } else {
        setResult({ severity: 'error', node: <>{data.message || 'Something went wrong – please try again.'}</> });
      }
    } catch {
      setResult({ severity: 'error', node: <>Network error – please try again.</> });
    } finally {
      setSubmitting(false);
      setUploadProgress(null);
    }
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Found a CYOA somewhere on the internet that's missing from the catalog?
        Paste the link – we'll download it, host it and publish it for you.
        Static (image) CYOAs too: paste an imgchest link or attach the pages.
      </Typography>

      {!signedIn ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          <Link component={RouterLink} to="/login">Log in</Link> to suggest a game – it takes one click with Google/Discord.
        </Alert>
      ) : (
        <form onSubmit={handleSubmit}>
          <Stack spacing={1.5}>
            <TextField
              label="Game link"
              placeholder={kind === 'static'
                ? 'https://imgchest.com/p/…'
                : 'https://example.neocities.org/my-favorite-cyoa/'}
              helperText={kind === 'static'
                ? 'An imgchest.com link with the pages – or attach the images below instead.'
                : undefined}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              fullWidth
              required={!isUpload}
              type="url"
              inputProps={{ inputMode: 'url' }}
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
              <ToggleButtonGroup
                value={kind}
                exclusive
                size="small"
                onChange={(_, v) => { if (v) { setKind(v); if (v !== 'static') setFiles([]); } }}
              >
                <ToggleButton value="interactive">Interactive</ToggleButton>
                <ToggleButton value="static">Static (images)</ToggleButton>
              </ToggleButtonGroup>
              <ToggleButtonGroup
                value={rating}
                exclusive
                size="small"
                onChange={(_, v) => { if (v) setRating(v); }}
              >
                <ToggleButton value="SFW">SFW</ToggleButton>
                <ToggleButton value="Ecchi">Ecchi</ToggleButton>
                <ToggleButton value="NSFW">NSFW</ToggleButton>
                <ToggleButton value="Extreme">Extreme</ToggleButton>
              </ToggleButtonGroup>
            </Stack>

            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={original}
                  onChange={(e) => setOriginal(e.target.checked)}
                />
              }
              label={
                <Box>
                  <Typography variant="body2">
                    This is a new game, not a repost
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Tick this only if you're the author releasing it here. New
                    releases get pinned to the top of the front page for 5 days,
                    so repost floods don't bury them.
                  </Typography>
                </Box>
              }
              sx={{ mt: -0.5, alignItems: 'flex-start' }}
            />

            {kind === 'static' && (
              <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                <Button component="label" variant="outlined" size="small">
                  Attach images
                  <input
                    type="file"
                    hidden
                    multiple
                    accept="image/*"
                    onChange={(e) => {
                      setFiles(Array.from(e.target.files ?? []));
                      e.target.value = '';
                    }}
                  />
                </Button>
                {files.length > 0 && (
                  <>
                    <Typography variant="caption" color={uploadTooBig ? 'error' : 'text.secondary'}>
                      {files.length} image{files.length > 1 ? 's' : ''}, {uploadMB.toFixed(1)} MB
                      {uploadTooBig && ` – max ${MAX_UPLOAD_FILES} files, ${MAX_FILE_MB} MB per file; upload to imgchest.com and paste the link instead`}
                      {!uploadTooBig && uploadMB > BATCH_MB && ' – big pack, will upload in several batches'}
                    </Typography>
                    <Button size="small" onClick={() => setFiles([])}>Clear</Button>
                  </>
                )}
              </Stack>
            )}

            <TextField
              label="Title, other names, author, notes"
              placeholder="Game title, any other names it's known by (re-releases, translations, thread nicknames), author, version – anything you know helps us publish it right."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              fullWidth
              multiline
              rows={2}
              inputProps={{ maxLength: 500 }}
            />

            <Stack direction="row" spacing={1.5} alignItems="center">
              <Button
                type="submit"
                variant="contained"
                disabled={submitting || (!url.trim() && !isUpload) || (isUpload && uploadTooBig)}
                sx={{ minWidth: 160 }}
              >
                {submitting ? <CircularProgress size={22} /> : 'Suggest game'}
              </Button>
              {submitting && uploadProgress && (
                <Typography variant="caption" color="text.secondary">{uploadProgress}</Typography>
              )}
            </Stack>
          </Stack>
        </form>
      )}

      {result && (
        <Alert severity={result.severity} sx={{ mt: 2 }} onClose={() => setResult(null)}>
          {result.node}
        </Alert>
      )}

      {signedIn && mine.length > 0 && (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>My suggestions</Typography>
          <List dense disablePadding>
            {mine.map((s) => {
              const chip = STATUS_CHIP[s.status] ?? STATUS_CHIP.processing;
              return (
                <ListItem key={s.id} disableGutters sx={{ alignItems: 'flex-start' }}
                  secondaryAction={
                    s.status === 'published' && s.game_id ? (
                      <Button size="small" component={RouterLink} to={`/game/${s.slug || s.game_id}`}>
                        View
                      </Button>
                    ) : undefined
                  }
                >
                  <ListItemText
                    primary={
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                          {s.title || hostOf(s.url)}
                        </Typography>
                        <Chip size="small" label={chip.label} color={chip.color} variant="outlined" />
                      </Stack>
                    }
                    secondary={
                      <>
                        <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all', display: 'block' }}>
                          {s.url}
                        </Typography>
                        {s.status === 'failed' && (
                          <Typography variant="caption" color="text.secondary">
                            We couldn't process this one automatically{s.detail ? ` – ${s.detail}` : ''}. It stays on our radar for a manual fix.
                          </Typography>
                        )}
                        {s.status === 'declined' && s.detail && (
                          <Typography variant="caption" color="text.secondary">
                            Reason: {s.detail}
                          </Typography>
                        )}
                      </>
                    }
                  />
                </ListItem>
              );
            })}
          </List>
        </Box>
      )}

      {queueCount !== null && (
        <Box sx={{ mt: 3 }}>
          <Divider sx={{ mb: 1.5 }} />
          <Stack
            direction="row" spacing={0.5} alignItems="center"
            onClick={() => setQueueOpen((o) => !o)}
            sx={{ cursor: 'pointer', userSelect: 'none' }}
          >
            <Typography variant="subtitle2">
              {queueCount === 0
                ? 'Community queue is empty – your find could be next!'
                : `Community queue: ${queueCount} game${queueCount === 1 ? '' : 's'} waiting`}
            </Typography>
            {queueCount > 0 && (queueOpen
              ? <KeyboardArrowUpIcon fontSize="small" />
              : <KeyboardArrowDownIcon fontSize="small" />)}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Suggested games are published in batches – usually within a day or two.
            {pipelineTotal > (queueCount ?? 0) && (
              <> Our own intake pipeline is working through {pipelineTotal - (queueCount ?? 0)} more games in the background.</>
            )}
          </Typography>
          <Collapse in={queueOpen}>
            <List dense disablePadding sx={{ mt: 1 }}>
              {queueItems.map((q, i) => {
                const chip = STATUS_CHIP[q.status] ?? STATUS_CHIP.processing;
                return (
                  <ListItem key={i} disableGutters>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
                          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                            {q.title || hostOf(q.url)}
                          </Typography>
                          <Chip size="small" label={chip.label} color={chip.color} variant="outlined" />
                        </Stack>
                      }
                    />
                  </ListItem>
                );
              })}
              {queueCount !== null && queueCount > queueItems.length && (
                <ListItem disableGutters>
                  <ListItemText
                    primary={
                      <Typography variant="caption" color="text.secondary">
                        …and {queueCount - queueItems.length} more
                      </Typography>
                    }
                  />
                </ListItem>
              )}
            </List>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
