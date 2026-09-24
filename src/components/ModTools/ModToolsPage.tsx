// /moderator/mod-tools — moderators add games with the helper app (tools/cyoa-helper) running on
// their own computer. The page never talks to the helper directly: it creates jobs on the server
// (modkit.go) that the paired helper claims, and polls their progress. Flow per game: download (or
// import a folder/zip in the helper menu) → check report → upload under the AUTHOR's reserved
// hosting account → card into the publication queue (flagged until another moderator checks it),
// or a language version of an existing card.

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Collapse, Container, Divider, FormControlLabel,
  LinearProgress, Link, MenuItem, Paper, Radio, RadioGroup, Select, Snackbar, Stack, Switch,
  TextField, Typography,
} from '@mui/material';
import { AuthContext, pb } from '../../pocketbase/pocketbase';
import GameMetaEditor from '../GameMeta/GameMetaEditor';
import { GameMetaValue, emptyGameMeta } from '../GameMeta/types';
import {
  ApiError, CheckReport, DupHit, HELPER_RELEASES_URL, HelperDevice, HelperJob, HostingAccount,
  addVariant, cancelJob, confirmPairing, createHostingAccount, createJob, dupCheck,
  findHostingAccounts, gameRefFromInput, getJob, listDevices, listJobs, revokeDevice, slugify,
  submitCard,
} from './api';
import { prepareCover, PreparedCover } from './cover';
import { COVER_HANDOFF_CHANNEL, CoverHandoffMessage } from './coverHandoff';

const paperSx = { p: { xs: 1.5, sm: 2.5 }, mb: 3, bgcolor: '#2e2e2e', color: '#e0e0e0', borderRadius: 2 };
const fieldSx = { '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#888' } } };

const fmtBytes = (n?: number) => {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
};

const fmtAgo = (s: string) => {
  const t = new Date(s.replace(' ', 'T')).getTime();
  if (!t) return '';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// One game on a helper = one workspace item; several jobs (download, re-check, upload) refer to it.
interface ItemView {
  item: string;
  report: CheckReport | null;
  latest: HelperJob;
  upload: HelperJob | null;
  jobs: HelperJob[];
}

function itemOf(j: HelperJob): string {
  return (j.result as { item?: string })?.item || j.input?.item || '';
}

function groupItems(jobs: HelperJob[]): { items: ItemView[]; pending: HelperJob[] } {
  const byItem = new Map<string, ItemView>();
  const pending: HelperJob[] = [];
  // jobs arrive newest first
  for (const j of jobs) {
    const item = itemOf(j);
    if (!item) {
      if (j.status === 'queued' || j.status === 'running' || j.status === 'failed') pending.push(j);
      continue;
    }
    let v = byItem.get(item);
    if (!v) {
      v = { item, report: null, latest: j, upload: null, jobs: [] };
      byItem.set(item, v);
    }
    v.jobs.push(j);
    if (j.kind === 'upload') {
      // Newest upload job, but a finished one wins over a later failed/cancelled retry.
      if (!v.upload || (v.upload.status !== 'done' && j.status === 'done')) v.upload = j;
    } else if (!v.report && j.status === 'done' && (j.result as CheckReport)?.files !== undefined) {
      v.report = j.result as CheckReport;
    }
  }
  return { items: [...byItem.values()], pending };
}

const STATUS_COLOR: Record<string, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  queued: 'default', running: 'info', done: 'success', failed: 'error', cancelled: 'warning',
};

function JobLine({ job, onCancel }: { job: HelperJob; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const p = job.progress || {};
  const active = job.status === 'queued' || job.status === 'running';
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => getJob(job.id).then((j) => { if (alive) setLog(j.log || ''); }).catch(() => {});
    load();
    const t = active ? window.setInterval(load, 2500) : undefined;
    return () => { alive = false; if (t) window.clearInterval(t); };
  }, [open, job.id, active]);
  return (
    <Box sx={{ py: 0.75 }}>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip size="small" label={job.kind} variant="outlined" />
        <Chip size="small" label={job.status} color={STATUS_COLOR[job.status]} />
        <Typography variant="body2" sx={{ color: '#bbb', minWidth: 0, flex: 1, wordBreak: 'break-all' }}>
          {job.kind === 'download' ? job.input.url : job.kind === 'upload' ? `${job.input.user_slug}.cyoa.cafe/${job.input.slug}/` : job.input.name || job.input.item}
          {p.message ? ` — ${p.message}` : ''}
        </Typography>
        <Typography variant="caption" sx={{ color: '#777' }}>{fmtAgo(job.updated)}</Typography>
        <Button size="small" onClick={() => setOpen((o) => !o)}>{open ? 'Hide log' : 'Log'}</Button>
        {active && onCancel && <Button size="small" color="warning" onClick={onCancel}>Cancel</Button>}
      </Box>
      {active && (
        <LinearProgress
          variant={p.total ? 'determinate' : 'indeterminate'}
          value={p.total ? Math.min(100, ((p.done || 0) / p.total) * 100) : undefined}
          sx={{ mt: 0.5 }}
        />
      )}
      {job.status === 'failed' && job.error && <Alert severity="error" sx={{ mt: 0.5 }}>{job.error}</Alert>}
      <Collapse in={open} unmountOnExit>
        <Box component="pre" sx={{
          mt: 0.5, p: 1, bgcolor: '#1c1c1c', color: '#bbb', fontSize: 12, maxHeight: 260, overflow: 'auto',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', borderRadius: 1,
        }}>
          {log === null ? 'Loading…' : log || '(empty)'}
        </Box>
      </Collapse>
    </Box>
  );
}

function ReportView({ r }: { r: CheckReport }) {
  const sev = r.verdict === 'ok' ? 'success' : r.verdict === 'warn' ? 'warning' : 'error';
  const headline = r.verdict === 'ok'
    ? 'Looks complete: every file the game refers to is on your computer.'
    : r.verdict === 'warn'
      ? 'Downloaded, but check the notes below before uploading.'
      : 'This copy is broken — uploading it would give players a broken game.';
  return (
    <Alert severity={sev} sx={{ '& .MuiAlert-message': { width: '100%' } }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{headline}</Typography>
      <Typography variant="body2">
        {r.files} files, {fmtBytes(r.bytes)}
        {r.engine ? ` · engine: ${r.engine}` : ''}
        {r.refs !== undefined ? ` · ${r.refs} image/font/audio links checked` : ''}
      </Typography>
      {!r.has_index && <Typography variant="body2">No index.html at the top of the game folder.</Typography>}
      {(r.missing_count || 0) > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <Typography variant="body2">Missing files: {r.missing_count}</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5, maxHeight: 140, overflow: 'auto', fontSize: 12 }}>
            {(r.missing || []).slice(0, 40).map((m) => <li key={m}>{m}</li>)}
          </Box>
        </Box>
      )}
      {(r.hotlink_count || 0) > 0 && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {r.hotlink_count} image(s) still load from other sites (they may disappear later).
        </Typography>
      )}
      {(r.warnings || []).map((w) => <Typography key={w} variant="body2" sx={{ mt: 0.5 }}>• {w}</Typography>)}
      {r.preview_url && (
        <Typography variant="body2" sx={{ mt: 1 }}>
          <Link href={r.preview_url} target="_blank" rel="noopener noreferrer">
            ▶ Play the downloaded copy on your computer ↗
          </Link>{' '}
          <span style={{ color: '#999' }}>(works while the helper is running)</span>
        </Typography>
      )}
    </Alert>
  );
}

// ---------------------------------------------------------------------------------------------

function HelperPanel({ devices, reload, pairCode }: {
  devices: HelperDevice[]; reload: () => void; pairCode: string;
}) {
  const [code, setCode] = useState(pairCode);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ sev: 'success' | 'error'; text: string } | null>(null);
  const [showHelp, setShowHelp] = useState(devices.length === 0);

  useEffect(() => { if (devices.length === 0) setShowHelp(true); }, [devices.length]);

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { device } = await confirmPairing(code);
      setMsg({ sev: 'success', text: `Connected “${device.name}”. The helper window will say so in a few seconds.` });
      setCode('');
      reload();
    } catch (e) {
      setMsg({ sev: 'error', text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (d: HelperDevice) => {
    if (!window.confirm(`Disconnect “${d.name}”? It will have to be paired again.`)) return;
    try {
      await revokeDevice(d.id);
      reload();
    } catch (e) {
      setMsg({ sev: 'error', text: errText(e) });
    }
  };

  return (
    <Paper sx={paperSx}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h6" sx={{ flex: 1 }}>Your helper</Typography>
        <Button size="small" onClick={() => setShowHelp((s) => !s)}>{showHelp ? 'Hide setup' : 'How to set up'}</Button>
      </Box>

      <Collapse in={showHelp}>
        <Box component="ol" sx={{ mt: 0, pl: 2.5, color: '#ccc', '& li': { mb: 0.75 } }}>
          <li>
            Download the helper for your computer from{' '}
            <Link href={HELPER_RELEASES_URL} target="_blank" rel="noopener noreferrer">the releases page ↗</Link>{' '}
            (<b>cyoa-helper-windows.exe</b>, <b>cyoa-helper-linux</b> or <b>cyoa-helper-macos</b>). It is one
            file, nothing to install.
          </li>
          <li>Run it. On Windows, if SmartScreen warns you, click “More info” → “Run anyway”.</li>
          <li>In its menu choose <b>1 (Connect)</b>. It shows a code like <code>ABCD-2345</code>.</li>
          <li>Type the code below. Keep the helper window open while you work — the games are downloaded to your computer by it.</li>
        </Box>
      </Collapse>

      {devices.length > 0 && (
        <Stack spacing={0.5} sx={{ mb: 1.5 }}>
          {devices.map((d) => (
            <Box key={d.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: d.online ? '#4caf50' : '#666' }} />
              <Typography sx={{ fontWeight: 500 }}>{d.name}</Typography>
              <Typography variant="caption" sx={{ color: '#999' }}>
                {d.online ? 'online' : `last seen ${fmtAgo(d.last_seen) || 'never'}`}
                {d.platform ? ` · ${d.platform}` : ''}{d.client_version ? ` · v${d.client_version}` : ''}
              </Typography>
              <Button size="small" color="warning" onClick={() => revoke(d)}>Disconnect</Button>
            </Box>
          ))}
        </Stack>
      )}

      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField size="small" label={devices.length ? 'Connect another helper: code' : 'Code from the helper'}
          value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && code.trim() && connect()}
          placeholder="ABCD-2345" sx={{ width: 260, ...fieldSx }} />
        <Button variant="contained" onClick={connect} disabled={busy || code.trim().length < 8}>
          {busy ? <CircularProgress size={18} color="inherit" /> : 'Connect'}
        </Button>
      </Box>
      {msg && <Alert severity={msg.sev} sx={{ mt: 1 }}>{msg.text}</Alert>}
    </Paper>
  );
}

// ---------------------------------------------------------------------------------------------

function AuthorAccountPicker({ initialName, value, onChange }: {
  initialName: string;
  value: HostingAccount | null;
  onChange: (a: HostingAccount | null) => void;
}) {
  const [name, setName] = useState(initialName);
  const [accounts, setAccounts] = useState<HostingAccount[]>([]);
  const [suggestion, setSuggestion] = useState<{ slug: string; available: boolean; reason: string } | null>(null);
  const [newSlug, setNewSlug] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = name.trim();
    if (q.length < 2) { setAccounts([]); setSuggestion(null); return; }
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await findHostingAccounts(q);
        setAccounts(res.accounts);
        setSuggestion(res.suggestion || null);
        setNewSlug(res.suggestion?.slug || '');
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [name]);

  const create = async () => {
    setError('');
    try {
      const { account } = await createHostingAccount(name.trim(), newSlug.trim());
      onChange(account);
    } catch (e) {
      if (e instanceof ApiError && e.data.account) {
        setError(`${e.message}: ${(e.data.account as HostingAccount).username}`);
      } else setError(errText(e));
    }
  };

  if (value) {
    return (
      <Alert severity="success" action={<Button color="inherit" size="small" onClick={() => onChange(null)}>Change</Button>}>
        The game will live at <b>{value.hosting_slug}.cyoa.cafe</b> (reserved account of {value.name || value.username}
        {value.games ? `, ${value.games} game(s) already` : ''}).
      </Alert>
    );
  }

  return (
    <Box>
      <TextField size="small" fullWidth label="Author's name (as they sign their CYOAs)" value={name}
        onChange={(e) => setName(e.target.value)} sx={fieldSx}
        helperText="The game is hosted on the author's own address, not yours. An empty “reserved” account is created for authors who aren't on the site; they can claim it later." />
      {loading && <LinearProgress sx={{ mt: 1 }} />}
      {accounts.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          {accounts.map((a) => (
            <Box key={a.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ flex: 1 }}>
                <b>{a.hosting_slug || '(no address)'}</b>.cyoa.cafe — {a.name || a.username}
                {a.reserved ? ' · reserved' : ' · real account'} · {a.games} game(s)
              </Typography>
              {a.reserved && a.hosting_slug ? (
                <Button size="small" variant="outlined" onClick={() => onChange(a)}>Use this</Button>
              ) : (
                <Typography variant="caption" sx={{ color: '#ffb74d' }}>
                  The author has a real account — only they or an admin can upload there.
                </Typography>
              )}
            </Box>
          ))}
        </Stack>
      )}
      {suggestion && (
        <Box sx={{ mt: 1.5, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2">None of these? Create a reserved account:</Typography>
          <TextField size="small" value={newSlug} onChange={(e) => setNewSlug(slugify(e.target.value, 40))}
            sx={{ width: 200, ...fieldSx }} InputProps={{ endAdornment: <Typography variant="caption" sx={{ color: '#888' }}>.cyoa.cafe</Typography> }} />
          <Button size="small" variant="contained" onClick={create} disabled={newSlug.length < 3}>Create</Button>
          {!suggestion.available && newSlug === suggestion.slug && (
            <Typography variant="caption" sx={{ color: '#ffb74d' }}>{suggestion.reason}</Typography>
          )}
        </Box>
      )}
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------

function PublishWizard({ view, device, onChanged, onToast }: {
  view: ItemView;
  device: HelperDevice | null;
  onChanged: () => void;
  onToast: (sev: 'success' | 'error', msg: string) => void;
}) {
  const r = view.report;
  const upload = view.upload;
  const hosted = upload?.status === 'done' ? (upload.result as { hosted?: { url: string } }).hosted : undefined;

  const [mode, setMode] = useState<'new' | 'variant'>('new');
  const [account, setAccount] = useState<HostingAccount | null>(null);
  const [slug, setSlug] = useState(r?.suggested_slug || slugify(r?.title || ''));
  const [title, setTitle] = useState(r?.title || '');
  const [sourceUrl, setSourceUrl] = useState(r?.source_url || '');
  const [dups, setDups] = useState<DupHit[] | null>(null);
  const [notDup, setNotDup] = useState(false);
  const [busy, setBusy] = useState(false);

  // card
  const [meta, setMeta] = useState<GameMetaValue>({ ...emptyGameMeta(), title: r?.title || '' });
  const [description, setDescription] = useState('');
  const [nsfw, setNsfw] = useState(true);
  const [cover, setCover] = useState<PreparedCover | null>(null);
  const [coverUrl, setCoverUrl] = useState('');
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState<string>('');

  // variant
  const [gameInput, setGameInput] = useState('');
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);
  const [language, setLanguage] = useState('ko');
  const [versionLabel, setVersionLabel] = useState('');
  const [vTitle, setVTitle] = useState('');
  const [vDesc, setVDesc] = useState('');

  const handoffId = useMemo(() => `${view.item}-${Math.random().toString(36).slice(2, 8)}`, [view.item]);

  useEffect(() => {
    if (!coverUrl) return;
    return () => URL.revokeObjectURL(coverUrl);
  }, [coverUrl]);

  const setPrepared = (p: PreparedCover) => {
    setCover(p);
    setCoverUrl(URL.createObjectURL(p.blob));
  };

  // Screenshot Studio (other tab) posts the capture back here.
  useEffect(() => {
    const ch = new BroadcastChannel(COVER_HANDOFF_CHANNEL);
    ch.onmessage = (ev: MessageEvent<CoverHandoffMessage>) => {
      if (ev.data?.handoff !== handoffId) return;
      setPrepared({ blob: ev.data.blob, placeholder: ev.data.placeholder });
      onToast('success', 'Cover received from Screenshot Studio');
    };
    return () => ch.close();
  }, [handoffId, onToast]);

  useEffect(() => {
    if (mode !== 'new') return;
    let alive = true;
    dupCheck(sourceUrl, title || r?.title || '')
      .then((res) => { if (alive) setDups(res.hits); })
      .catch(() => { if (alive) setDups([]); });
    return () => { alive = false; };
  }, [mode, sourceUrl, title, r?.title]);

  const resolveTarget = async () => {
    const ref = gameRefFromInput(gameInput);
    if (!ref) return;
    try {
      let g: { id: string; title: string };
      try {
        g = await pb.collection('games').getOne(ref, { fields: 'id,title' });
      } catch {
        g = await pb.collection('games').getFirstListItem(`slug = "${ref.replace(/"/g, '')}"`, { fields: 'id,title' });
      }
      setTarget(g);
      if (!title) setTitle(`${g.title} (${language})`);
    } catch {
      onToast('error', 'No card found for that link');
    }
  };

  const startUpload = async () => {
    if (!device || !account) return;
    setBusy(true);
    try {
      await createJob(device.id, 'upload', {
        item: view.item, user_slug: account.hosting_slug, slug, title: title.trim(), source_url: sourceUrl.trim(),
      });
      onToast('success', 'Upload started — watch the progress above');
      onChanged();
    } catch (e) {
      onToast('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPrepared(await prepareCover(f));
    } catch (e) {
      onToast('error', errText(e));
    }
  };

  const openStudio = () => {
    if (!hosted) return;
    window.open(`/moderator/screenshots?url=${encodeURIComponent(hosted.url)}&handoff=${encodeURIComponent(handoffId)}`, '_blank');
  };

  const missing: string[] = [];
  if (!meta.title.trim()) missing.push('title');
  if (meta.authors.length === 0) missing.push('authors');
  if (meta.tags.length === 0) missing.push('tags');
  if (!description.trim()) missing.push('description');
  if (!cover) missing.push('cover');
  const needsDupConfirm = (dups?.length || 0) > 0 && !notDup;

  const submit = async () => {
    if (!cover || !upload) return;
    setBusy(true);
    try {
      const res = await submitCard({
        title: meta.title.trim(), description: description.trim(),
        authors: meta.authors.map((a) => a.id), tags: meta.tags.map((t) => t.id),
        nsfw, source_url: sourceUrl.trim(), upload_job: upload.id, aliases: meta.aliases,
        image_base64: cover.placeholder, confirm_not_duplicate: notDup, note,
      }, cover.blob);
      setSubmitted(res.slug);
      onToast('success', 'Sent to the publication queue');
    } catch (e) {
      if (e instanceof ApiError && e.data.duplicates) {
        setDups(e.data.duplicates as DupHit[]);
        setNotDup(false);
      }
      onToast('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitVariant = async () => {
    if (!target || !hosted) return;
    setBusy(true);
    try {
      await addVariant(target.id, {
        language: language.trim().toLowerCase(), version_label: versionLabel.trim(),
        title: vTitle.trim(), description: vDesc.trim(), iframe_url: hosted.url,
      });
      setSubmitted(target.id);
      onToast('success', 'Language version added to the card');
    } catch (e) {
      onToast('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const step = (n: number, label: string) => (
    <Typography variant="subtitle1" sx={{ mt: 2.5, mb: 1, fontWeight: 600 }}>
      <Box component="span" sx={{ color: '#ff9100', mr: 1 }}>{n}.</Box>{label}
    </Typography>
  );

  if (submitted) {
    return (
      <Alert severity="success" sx={{ mt: 2 }}>
        {mode === 'new' ? (
          <>Done! The card is in the <Link href="/moderator/queue">publication queue</Link> with an orange
            “MOD UPLOAD” label. Another moderator checks it there, then the timer publishes it.</>
        ) : (
          <>Done! <Link href={`/game/${submitted}?lang=${encodeURIComponent(language)}`}>Open the card ↗</Link></>
        )}
      </Alert>
    );
  }

  return (
    <Box>
      {step(1, 'What is this?')}
      <RadioGroup row value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'variant')}>
        <FormControlLabel value="new" control={<Radio />} label="A game that isn't on the site yet" />
        <FormControlLabel value="variant" control={<Radio />} label="Another language / version of a game already on the site" />
      </RadioGroup>

      {mode === 'variant' && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField size="small" label="Link to the existing card (cyoa.cafe/game/…)" value={gameInput}
            onChange={(e) => { setGameInput(e.target.value); setTarget(null); }} sx={{ flex: '1 1 320px', ...fieldSx }} />
          <Button variant="outlined" onClick={resolveTarget} disabled={!gameInput.trim()}>Find</Button>
          {target && <Chip color="success" label={`✓ ${target.title}`} />}
        </Box>
      )}

      {mode === 'new' && dups && dups.length > 0 && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Possibly already on the site:</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {dups.map((d) => (
              <li key={d.where + d.id}>
                {d.where === 'catalog'
                  ? <Link href={`/game/${d.id}`} target="_blank" rel="noopener noreferrer">{d.title || d.id} ↗</Link>
                  : <>{d.title || d.id} (in the processing pipeline, state: {d.state})</>}
                {' '}— {d.why}
              </li>
            ))}
          </Box>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            Same game in another language? Choose “Another language / version” above instead.
          </Typography>
          <FormControlLabel control={<Switch checked={notDup} onChange={(e) => setNotDup(e.target.checked)} />}
            label="I checked: this is a different game" />
        </Alert>
      )}

      {step(2, 'Upload to the author’s address')}
      {hosted ? (
        <Alert severity="success">
          Uploaded: <Link href={hosted.url} target="_blank" rel="noopener noreferrer">{hosted.url} ↗</Link> — open it and
          make sure it plays.
        </Alert>
      ) : upload && (upload.status === 'queued' || upload.status === 'running') ? (
        <Alert severity="info">Uploading… progress is shown in the job list of this game.</Alert>
      ) : (
        <Stack spacing={1.5}>
          <AuthorAccountPicker initialName={r?.author_guess || ''} value={account} onChange={setAccount} />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <TextField size="small" label="Game title" value={title} onChange={(e) => setTitle(e.target.value)}
              sx={{ flex: '1 1 260px', ...fieldSx }} />
            <TextField size="small" label="Game address" value={slug}
              onChange={(e) => setSlug(slugify(e.target.value))} sx={{ flex: '1 1 200px', ...fieldSx }}
              helperText={account ? `https://${account.hosting_slug}.cyoa.cafe/${slug || '…'}/` : 'pick the author first'} />
          </Box>
          <TextField size="small" label="Original link (where the game was published)" value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)} sx={fieldSx} />
          {upload?.status === 'failed' && <Alert severity="error">Last upload failed: {upload.error}</Alert>}
          {r?.verdict === 'bad' && (
            <Alert severity="error">The check found this copy broken. Fix it or ask an admin before uploading.</Alert>
          )}
          <Box>
            <Button variant="contained" onClick={startUpload}
              disabled={busy || !device?.online || !account || slug.length < 3 || !title.trim() || (mode === 'new' && needsDupConfirm) || (mode === 'variant' && !target)}>
              Upload
            </Button>
            {!device?.online && <Typography variant="caption" sx={{ ml: 1, color: '#ffb74d' }}>the helper is offline</Typography>}
          </Box>
        </Stack>
      )}

      {hosted && mode === 'new' && (
        <>
          {step(3, 'Card: authors, tags, description, cover')}
          <Stack spacing={2}>
            <GameMetaEditor value={meta} onChange={setMeta} fields={['title', 'aliases', 'authors', 'tags']} />
            <TextField label="Description" multiline minRows={4} maxRows={14} value={description}
              onChange={(e) => setDescription(e.target.value)} sx={fieldSx}
              helperText="What the game is about, in 2–5 sentences. Shown on the card." />
            <FormControlLabel control={<Switch checked={nsfw} onChange={(e) => setNsfw(e.target.checked)} color="error" />}
              label={nsfw ? 'NSFW (adult content)' : 'SFW (safe for work)'} />
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Cover</Typography>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {coverUrl ? (
                  <Box component="img" src={coverUrl} alt="cover" sx={{ width: 150, height: 200, objectFit: 'cover', borderRadius: 1 }} />
                ) : (
                  <Box sx={{ width: 150, height: 200, border: '1px dashed #666', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#777', fontSize: 12, textAlign: 'center', p: 1 }}>
                    no cover yet
                  </Box>
                )}
                <Stack spacing={1}>
                  <Button variant="contained" color="warning" onClick={openStudio}>Take a screenshot</Button>
                  <Typography variant="caption" sx={{ color: '#999', maxWidth: 320 }}>
                    Opens Screenshot Studio with this game. After “Capture”, press “Use as cover in Mod Tools” and come back to this tab.
                  </Typography>
                  <Button variant="outlined" component="label">
                    …or choose an image file
                    <input hidden type="file" accept="image/*" onChange={(e) => pickFile(e.target.files?.[0])} />
                  </Button>
                </Stack>
              </Box>
            </Box>
            <TextField size="small" label="Note for the moderator who checks it (optional)" value={note}
              onChange={(e) => setNote(e.target.value)} sx={fieldSx} />
            {missing.length > 0 && (
              <Typography variant="body2" sx={{ color: '#ffb74d' }}>Still needed: {missing.join(', ')}</Typography>
            )}
            <Box>
              <Button variant="contained" color="success" onClick={submit}
                disabled={busy || missing.length > 0 || needsDupConfirm}>
                {busy ? <CircularProgress size={18} color="inherit" /> : 'Send to the publication queue'}
              </Button>
            </Box>
          </Stack>
        </>
      )}

      {hosted && mode === 'variant' && (
        <>
          {step(3, 'Language version')}
          <Stack spacing={1.5}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Select size="small" value={language} onChange={(e) => setLanguage(e.target.value)} sx={{ minWidth: 180 }}>
                {[['ko', 'Korean'], ['ja', 'Japanese'], ['zh', 'Chinese'], ['ru', 'Russian'], ['es', 'Spanish'],
                  ['pt', 'Portuguese'], ['de', 'German'], ['fr', 'French'], ['en', 'English']].map(([k, l]) => (
                  <MenuItem key={k} value={k}>{l} ({k})</MenuItem>
                ))}
              </Select>
              <TextField size="small" label="Version label (optional)" value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)} sx={fieldSx} />
            </Box>
            <TextField size="small" label="Title in that language (optional)" value={vTitle}
              onChange={(e) => setVTitle(e.target.value)} sx={fieldSx} />
            <TextField label="Description in that language (optional)" multiline minRows={3} value={vDesc}
              onChange={(e) => setVDesc(e.target.value)} sx={fieldSx} />
            <Box>
              <Button variant="contained" color="success" onClick={submitVariant} disabled={busy || !target}>
                Add to “{target?.title || '…'}”
              </Button>
            </Box>
          </Stack>
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------

export default function ModToolsPage() {
  const { signedIn } = useContext(AuthContext);
  const [devices, setDevices] = useState<HelperDevice[]>([]);
  const [jobs, setJobs] = useState<HelperJob[]>([]);
  const [setupError, setSetupError] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [openItem, setOpenItem] = useState('');
  const [toast, setToast] = useState<{ sev: 'success' | 'error'; msg: string } | null>(null);
  const pairCode = useMemo(() => new URLSearchParams(window.location.search).get('pair') || '', []);

  const loadDevices = useCallback(async () => {
    try {
      const res = await listDevices();
      setDevices(res.devices);
      setSetupError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setSetupError(e.message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const res = await listJobs(60);
      setJobs(res.jobs);
    } catch { /* keep the last list */ }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    loadDevices();
    loadJobs();
    const t = window.setInterval(loadDevices, 15000);
    return () => window.clearInterval(t);
  }, [signedIn, loadDevices, loadJobs]);

  const active = jobs.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!signedIn) return;
    const t = window.setInterval(() => loadJobs(), active ? 2000 : 8000);
    return () => window.clearInterval(t);
  }, [signedIn, active, loadJobs]);

  useEffect(() => {
    if (deviceId && devices.some((d) => d.id === deviceId)) return;
    const online = devices.find((d) => d.online) || devices[0];
    setDeviceId(online?.id || '');
  }, [devices, deviceId]);

  const device = devices.find((d) => d.id === deviceId) || null;
  const { items, pending } = useMemo(() => groupItems(jobs), [jobs]);

  const onToast = useCallback((sev: 'success' | 'error', msg: string) => setToast({ sev, msg }), []);

  const startDownload = async () => {
    if (!device) return;
    setBusy(true);
    try {
      await createJob(device.id, 'download', { url: url.trim() });
      setUrl('');
      loadJobs();
    } catch (e) {
      onToast('error', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const recheck = async (item: string) => {
    if (!device) return;
    try {
      await createJob(device.id, 'check', { item });
      loadJobs();
    } catch (e) {
      onToast('error', errText(e));
    }
  };

  const cancel = async (id: string) => {
    try {
      await cancelJob(id);
      loadJobs();
    } catch (e) {
      onToast('error', errText(e));
    }
  };

  return (
    <Container maxWidth="md" sx={{ px: { xs: 1, sm: 3 } }}>
      <Typography variant="h4" sx={{ mt: 4, mb: 1, color: '#e0e0e0', textAlign: 'center' }}>Mod Tools</Typography>
      <Typography sx={{ color: '#aaa', textAlign: 'center', mb: 3 }}>
        Download a CYOA to your computer, check it, host it on the author’s address and send the card for publishing.
      </Typography>

      {setupError && <Alert severity="error" sx={{ mb: 2 }}>{setupError}</Alert>}

      <HelperPanel devices={devices} reload={loadDevices} pairCode={pairCode} />

      <Paper sx={paperSx}>
        <Typography variant="h6" sx={{ mb: 1 }}>Get a game</Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField size="small" fullWidth label="Link to the game (neocities, github.io, itch…)" value={url}
            onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && device && startDownload()}
            sx={{ flex: '1 1 320px', ...fieldSx }} />
          {devices.length > 1 && (
            <Select size="small" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} sx={{ minWidth: 160 }}>
              {devices.map((d) => <MenuItem key={d.id} value={d.id}>{d.name}{d.online ? '' : ' (offline)'}</MenuItem>)}
            </Select>
          )}
          <Button variant="contained" onClick={startDownload} disabled={busy || !url.trim() || !device}>Download</Button>
        </Box>
        <Typography variant="caption" sx={{ color: '#999', display: 'block', mt: 1 }}>
          Already have the game as a folder or a .zip (from Discord, a translator, etc.)? In the helper window
          choose <b>Import a folder or zip</b> — it shows up below.
          {device && !device.online && ' Your helper is offline: start it, the download begins as soon as it connects.'}
        </Typography>
        {pending.length > 0 && (
          <Box sx={{ mt: 1.5 }}>
            {pending.map((j) => <JobLine key={j.id} job={j} onCancel={() => cancel(j.id)} />)}
          </Box>
        )}
      </Paper>

      {items.map((v) => {
        const open = openItem === v.item;
        const running = v.jobs.find((j) => j.status === 'queued' || j.status === 'running');
        const r = v.report;
        const hosted = v.upload?.status === 'done';
        return (
          <Paper key={v.item} sx={{ ...paperSx, border: open ? '1px solid #ff9100' : '1px solid transparent' }}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="h6" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                {r?.title || v.item}
              </Typography>
              {r && <Chip size="small" label={r.verdict === 'ok' ? 'complete' : r.verdict === 'warn' ? 'check notes' : 'broken'}
                color={r.verdict === 'ok' ? 'success' : r.verdict === 'warn' ? 'warning' : 'error'} />}
              {hosted && <Chip size="small" color="info" label="uploaded" />}
              <Button size="small" variant={open ? 'outlined' : 'contained'} onClick={() => setOpenItem(open ? '' : v.item)}
                disabled={!r && !running}>
                {open ? 'Close' : 'Continue'}
              </Button>
            </Box>
            {r?.source_url && (
              <Typography variant="caption" sx={{ color: '#888', wordBreak: 'break-all' }}>{r.source_url}</Typography>
            )}
            <Box sx={{ mt: 1 }}>
              {v.jobs.slice(0, open ? 10 : 1).map((j) => <JobLine key={j.id} job={j} onCancel={() => cancel(j.id)} />)}
            </Box>
            <Collapse in={open} unmountOnExit>
              <Divider sx={{ my: 1.5, borderColor: '#444' }} />
              {r && <ReportView r={r} />}
              {r && (
                <Box sx={{ mt: 1 }}>
                  <Button size="small" onClick={() => recheck(v.item)} disabled={!device?.online || !!running}>
                    Check again
                  </Button>
                  <Typography variant="caption" sx={{ color: '#888' }}>
                    (after you fixed files by hand in the helper’s folder)
                  </Typography>
                </Box>
              )}
              {r && <PublishWizard key={v.item} view={v} device={device} onChanged={loadJobs} onToast={onToast} />}
            </Collapse>
          </Paper>
        );
      })}

      {items.length === 0 && pending.length === 0 && devices.length > 0 && (
        <Typography sx={{ color: '#777', textAlign: 'center', mb: 4 }}>No games yet — paste a link above.</Typography>
      )}

      <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {toast ? <Alert severity={toast.sev} onClose={() => setToast(null)} variant="filled">{toast.msg}</Alert> : undefined}
      </Snackbar>
    </Container>
  );
}
