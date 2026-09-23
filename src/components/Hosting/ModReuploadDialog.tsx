// Moderator re-upload from the card: attach an archive → becomes a new version at the same public
// URL. All past versions live in R2 forever (only mod/purge deletes), so rollback = switching the
// version number, no re-upload. Server: hosting_versions.go
// (/api/hosting/mod/versions|reupload|version). Owner counterpart: Hosting.tsx; endpoint bodies are
// shared.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, Link, TextField, Typography,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { authedFetch } from '../../pocketbase/pocketbase';

// Cloudflare cuts requests at the edge around 100 MB (plan limit). Larger games can't go from the
// browser — the author uploads them in chunks from the workstation (./hub → upload-to-hosting).
const CF_UPLOAD_LIMIT = 95 * 1024 * 1024;

interface VersionMeta {
  v: number;
  uploaded_at: string;
  size_bytes: number;
  file_count: number;
  note?: string;
}

interface VersionsInfo {
  hosted_id: string;
  slug: string;
  title: string;
  status: string;
  owner: string;
  owner_slug: string;
  current: number;
  versions: VersionMeta[];
  url: string;
  max_upload_mb: number;
}

interface ModReuploadDialogProps {
  open: boolean;
  onClose: () => void;
  gameId: string;
  gameTitle?: string;
}

function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDatetime(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function errorText(res: Response, fallback: string) {
  try {
    const data = await res.json();
    if (data?.error) return String(data.error);
  } catch { }
  return fallback;
}

export default function ModReuploadDialog({ open, onClose, gameId, gameTitle }: ModReuploadDialogProps) {
  const [info, setInfo] = useState<VersionsInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/hosting/mod/versions/${gameId}`);
      if (!res.ok) throw new Error(await errorText(res, `Failed to load versions (${res.status})`));
      setInfo(await res.json());
    } catch (e) {
      setInfo(null);
      setError(e instanceof Error ? e.message : 'Failed to load versions');
    } finally {
      setLoading(false);
    }
  }, [gameId]);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setNote('');
    setSuccess(null);
    load();
  }, [open, load]);

  const tooBig = file !== null && file.size > CF_UPLOAD_LIMIT;

  const handleUpload = async () => {
    if (!file || tooBig) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const form = new FormData();
      form.append('archive', file);
      if (note.trim()) form.append('version_note', note.trim());
      const res = await authedFetch(`/api/hosting/mod/reupload/${gameId}`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await errorText(res, `Upload failed (${res.status})`));
      const data = await res.json();
      setFile(null);
      setNote('');
      setSuccess(`Uploaded as v${data.version} (${data.files} files, ${formatSize(data.size)}). Cloudflare cache purged.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async (v: number) => {
    if (!confirm(`Switch the game back to v${v}? Files are not touched — the current version stays in R2.`)) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await authedFetch(`/api/hosting/mod/version/${gameId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: v }),
      });
      if (!res.ok) throw new Error(await errorText(res, `Rollback failed (${res.status})`));
      setSuccess(`Switched to v${v}. Cloudflare cache purged.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setBusy(false);
    }
  };

  const versions = info ? [...info.versions].sort((a, b) => b.v - a.v) : [];

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Re-upload game files{gameTitle ? ` — ${gameTitle}` : ''}</DialogTitle>
      <DialogContent dividers>
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={28} />
          </Box>
        )}

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

        {info && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box>
              <Typography variant="body2">
                Hosted as <b>{info.owner_slug}/{info.slug}</b> · owner <b>{info.owner}</b> · currently <b>v{info.current}</b>
                {info.status && info.status !== 'active' ? ` · status: ${info.status}` : ''}
              </Typography>
              <Link href={info.url} target="_blank" rel="noreferrer" variant="caption">
                {info.url}
              </Link>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Button variant="outlined" component="label" disabled={busy}>
                {file ? `${file.name} (${formatSize(file.size)})` : 'Choose .zip archive'}
                <input
                  type="file"
                  accept=".zip"
                  hidden
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setSuccess(null);
                  }}
                />
              </Button>
              {tooBig && (
                <Alert severity="warning">
                  Archive is {formatSize(file!.size)} — over the Cloudflare edge limit ({CF_UPLOAD_LIMIT >> 20} MB).
                  Upload it from the workstation instead: <code>./hub</code> → upload-to-hosting.
                </Alert>
              )}
              <TextField
                label="Version note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                fullWidth
                size="small"
                disabled={busy}
                placeholder="what changed in this build"
              />
              <Box>
                <Button
                  variant="contained"
                  onClick={handleUpload}
                  disabled={busy || !file || tooBig}
                  startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}
                >
                  Upload as v{info.current + 1}
                </Button>
              </Box>
            </Box>

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Version history</Typography>
              {versions.length === 0 && (
                <Typography variant="caption" color="text.secondary">
                  No version history recorded — the game was uploaded before versions_meta existed.
                </Typography>
              )}
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                {versions.map((ver) => {
                  const isCurrent = ver.v === info.current;
                  return (
                    <Box
                      key={ver.v}
                      sx={{
                        px: 1.5, py: 1, borderRadius: 1,
                        border: '1px solid',
                        borderColor: isCurrent ? 'primary.main' : 'divider',
                        bgcolor: isCurrent ? 'action.selected' : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1,
                      }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: isCurrent ? 600 : 400, display: 'flex', alignItems: 'center', gap: 0.5 }}
                        >
                          {isCurrent && <CheckCircleIcon sx={{ fontSize: 16, color: 'primary.main' }} />}
                          v{ver.v}{isCurrent && ' (active)'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {formatDatetime(ver.uploaded_at)} · {formatSize(ver.size_bytes)} · {ver.file_count} files
                        </Typography>
                        {ver.note && (
                          <Typography variant="caption" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
                            {ver.note}
                          </Typography>
                        )}
                      </Box>
                      {!isCurrent && (
                        <Button size="small" onClick={() => handleRollback(ver.v)} disabled={busy}>
                          Roll back
                        </Button>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
