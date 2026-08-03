// src/components/CyoaPage/GameEditDialog.tsx
//
// Диалоги управления карточкой для владельца (games.uploader) и модераторов.
// games.updateRule = moderator-only, поэтому ВСЕ правки идут через Go-эндпоинты
// /api/custom/games/:id/{edit,bump,hide} (см. game_edits.go): каждая правка
// пишет ревизию в game_revisions, вытесняемые файлы архивируются в R2 —
// откатываемо всё, «удаление» = скрытие.
import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RestoreIcon from '@mui/icons-material/Restore';
import { encode as webpencode } from '@jsquash/webp';
import { Game, authedFetch } from '../../pocketbase/pocketbase';
import { makeBlurPlaceholder } from '../../utils/blurPlaceholder';

export const BUMP_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const SELF_DELETE_WINDOW_MS = 60 * 60 * 1000;

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

// ─────────────────────────── Edit dialog ───────────────────────────

interface GameEditDialogProps {
  open: boolean;
  onClose: () => void;
  game: Game;
  isModerator: boolean;
  isOwner: boolean;
  onSaved: () => void;
}

export function GameEditDialog({ open, onClose, game, isModerator, isOwner, onSaved }: GameEditDialogProps) {
  const [title, setTitle] = useState(game.title || '');
  const [description, setDescription] = useState(game.description || '');
  const [releaseDate, setReleaseDate] = useState((game.release_date || '').slice(0, 10));
  const [originalLink, setOriginalLink] = useState(game.original_link || '');
  // Альт-названия — модерское поле (влияет на поиск), владельцу игры не показываем.
  const [aliases, setAliases] = useState(game.aliases || '');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [removedPages, setRemovedPages] = useState<Set<string>>(new Set());
  const [newPages, setNewPages] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isImgGame = game.img_or_link === 'img';
  const currentPages = useMemo(() => game.cyoa_pages || [], [game]);

  // Окно самоудаления: владелец — 1 час после создания; модер — всегда.
  const canHide = useMemo(() => {
    if (isModerator) return true;
    if (!isOwner || !game.created) return false;
    return Date.now() - new Date(game.created.replace(' ', 'T')).getTime() < SELF_DELETE_WINDOW_MS;
  }, [isModerator, isOwner, game.created]);

  const togglePage = (name: string) => {
    setRemovedPages((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (title !== (game.title || '')) payload.title = title;
      if (description !== (game.description || '')) payload.description = description;
      if (releaseDate !== (game.release_date || '').slice(0, 10)) payload.release_date = releaseDate;
      if (originalLink !== (game.original_link || '')) payload.original_link = originalLink;
      if (isModerator && aliases !== (game.aliases || '')) payload.aliases = aliases;

      const formData = new FormData();
      if (imageFile) {
        formData.append('image', imageFile);
        const b64 = await makeBlurPlaceholder(imageFile);
        if (b64) payload.image_base64 = b64;
      }
      if (removedPages.size > 0) {
        payload.cyoa_pages_keep = currentPages.filter((n) => !removedPages.has(n));
      }
      // Новые страницы конвертим в webp как CreateGame; оригинал — запасной путь.
      for (const [index, f] of newPages.entries()) {
        try {
          const image = await createImageBitmap(f);
          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('No context');
          ctx.drawImage(image, 0, 0);
          const buf = await webpencode(ctx.getImageData(0, 0, image.width, image.height), { lossless: 1 });
          const name = `${f.name.split('.').slice(0, -1).join('.')}_new${index + 1}.webp`;
          formData.append('cyoa_pages', new Blob([buf], { type: 'image/webp' }), name);
        } catch {
          formData.append('cyoa_pages', f);
        }
      }

      if (Object.keys(payload).length === 0 && !imageFile && newPages.length === 0) {
        onClose();
        return;
      }
      formData.append('payload', JSON.stringify(payload));

      const res = await authedFetch(`/api/custom/games/${game.id}/edit`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(await extractError(res, `Save failed (${res.status})`));
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHide = async () => {
    if (!window.confirm('Hide this game from the catalog? A moderator can restore it later.')) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/custom/games/${game.id}/hide`, { method: 'POST' });
      if (!res.ok) throw new Error(await extractError(res, `Hide failed (${res.status})`));
      window.location.href = '/';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hide failed');
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        Edit game
        <IconButton onClick={onClose} disabled={submitting} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 0.5 }}>
          <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth size="small" />
          {isModerator && (
            <TextField
              label="Alternative titles"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              fullWidth
              multiline
              minRows={2}
              maxRows={8}
              size="small"
              inputProps={{ maxLength: 2000 }}
              helperText="One per line: other names this CYOA is known by (re-releases, translations, thread nicknames). Searchable, shown greyed out under the title. Moderators only."
            />
          )}
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            minRows={4}
            maxRows={14}
            size="small"
            helperText="Basic HTML is allowed (<p>, <a>, <b>, …) and is sanitized on display."
          />
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label="Release date"
              type="date"
              value={releaseDate}
              onChange={(e) => setReleaseDate(e.target.value)}
              size="small"
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              label="Original link"
              value={originalLink}
              onChange={(e) => setOriginalLink(e.target.value)}
              size="small"
              sx={{ flex: 1, minWidth: 200 }}
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Cover image</Typography>
            <Button variant="outlined" component="label" size="small">
              {imageFile ? `Replace with: ${imageFile.name}` : 'Replace cover image…'}
              <input
                hidden
                type="file"
                accept="image/*"
                onChange={(e) => setImageFile(e.target.files?.[0] || null)}
              />
            </Button>
            {imageFile && (
              <Button size="small" onClick={() => setImageFile(null)} sx={{ ml: 1 }}>
                Keep current
              </Button>
            )}
          </Box>

          {isImgGame && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Pages ({currentPages.length - removedPages.size} kept
                {newPages.length > 0 ? `, +${newPages.length} new` : ''})
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Click a page to remove/restore it. New pages are appended at the end.
                Replaced pages are archived server-side and can be restored by a moderator.
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, maxHeight: 180, overflowY: 'auto' }}>
                {currentPages.map((name, i) => (
                  <Tooltip key={name} title={name} arrow>
                    <Chip
                      label={`p${i + 1}`}
                      size="small"
                      color={removedPages.has(name) ? 'error' : 'default'}
                      variant={removedPages.has(name) ? 'filled' : 'outlined'}
                      onClick={() => togglePage(name)}
                      onDelete={() => togglePage(name)}
                      deleteIcon={removedPages.has(name) ? <RestoreIcon /> : undefined}
                    />
                  </Tooltip>
                ))}
              </Box>
              <Button variant="outlined" component="label" size="small" sx={{ mt: 1 }}>
                Add pages…
                <input
                  hidden
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setNewPages(Array.from(e.target.files || []))}
                />
              </Button>
              {newPages.length > 0 && (
                <Button size="small" onClick={() => setNewPages([])} sx={{ ml: 1 }}>
                  Clear new pages
                </Button>
              )}
            </Box>
          )}

          {error && <Alert severity="error">{error}</Alert>}

          {canHide && (
            <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.5 }}>
              <Button color="error" size="small" onClick={handleHide} disabled={submitting}>
                Delete (hide) this game
              </Button>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {isModerator
                  ? 'Soft-hide: the card disappears from the catalog but nothing is deleted.'
                  : 'Available within 1 hour of upload. Later — ask a moderator (@moderator in comments).'}
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={submitting}>
          {submitting ? <CircularProgress size={20} /> : 'Save changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ─────────────────────────── Bump dialog ───────────────────────────

interface BumpDialogProps {
  open: boolean;
  onClose: () => void;
  game: Game;
  isModerator: boolean;
  onBumped: () => void;
}

export function BumpDialog({ open, onClose, game, isModerator, onBumped }: BumpDialogProps) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Кулдаун считаем от bumped_at; сервер — источник истины, тут только UX.
  const nextBumpAt = useMemo(() => {
    if (!game.bumped_at) return null;
    return new Date(new Date(game.bumped_at.replace(' ', 'T')).getTime() + BUMP_COOLDOWN_MS);
  }, [game.bumped_at]);
  const onCooldown = !isModerator && nextBumpAt !== null && nextBumpAt.getTime() > Date.now();

  const handleBump = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await authedFetch(`/api/custom/games/${game.id}/bump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => null);
        const when = data?.next_bump_at ? new Date(data.next_bump_at).toLocaleDateString() : 'later';
        throw new Error(`Bump is on cooldown — available ${when}.`);
      }
      if (!res.ok) throw new Error(await extractError(res, `Bump failed (${res.status})`));
      onBumped();
      onClose();
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bump failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Update Bump</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          For updated games only: after you update your game, bump it to the top of the
          catalog. Your note is added to the game's pinned changelog — describe what changed.
        </Typography>
        {onCooldown && nextBumpAt && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            Next bump available on <b>{nextBumpAt.toLocaleDateString()}</b> (once every 14 days).
          </Alert>
        )}
        <TextField
          label="What's new?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          fullWidth
          multiline
          minRows={2}
          size="small"
          disabled={onCooldown}
          placeholder="e.g. v2.1: three new endings, fixed typos in chapter 4"
        />
        {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button
          onClick={handleBump}
          variant="contained"
          disabled={submitting || onCooldown || note.trim().length === 0}
        >
          {submitting ? <CircularProgress size={20} /> : 'Bump'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
