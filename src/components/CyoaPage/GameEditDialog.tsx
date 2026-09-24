// Card management dialogs for the owner (games.uploader) and moderators. games.updateRule is
// moderator-only, so ALL edits go through Go endpoints /api/custom/games/:id/{edit,bump,hide}
// (game_edits.go): each writes a revision to game_revisions, displaced files are archived in R2 —
// everything is reversible; "delete" = hide.

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
import { Game, authedFetch, pb } from '../../pocketbase/pocketbase';
import { makeBlurPlaceholder } from '../../utils/blurPlaceholder';
import GameMetaEditor from '../GameMeta/GameMetaEditor';
import { GameMetaField, GameMetaValue, gameMetaPatch } from '../GameMeta/types';
import CardImageCropper from '../Add/CardImageCropper';
import CyoaImageUploader from '../Add/CyoaImageUploader';
import GameRelationshipEditor from '../GameRelationships/GameRelationshipEditor';
import GameVariantsEditor from '../GameVariants/GameVariantsEditor';

import { BUMP_COOLDOWN_MS } from './bumpCooldown';

export { BUMP_COOLDOWN_MS };
const SELF_DELETE_WINDOW_MS = 60 * 60 * 1000;

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

interface GameEditDialogProps {
  open: boolean;
  onClose: () => void;
  game: Game;
  isModerator: boolean;
  isOwner: boolean;
  onSaved: () => void;
}

export function GameEditDialog({ open, onClose, game, isModerator, isOwner, onSaved }: GameEditDialogProps) {
  // Title/aliases/authors via the shared GameMeta editor in controlled mode (saved by the same
  // "Save changes"). Aliases and authors are moderator fields (search impact; attribution of
  // someone's work) — hidden from owners.
  const baseMeta = useMemo<GameMetaValue>(
    () => ({
      title: game.title || '',
      aliases: game.aliases || '',
      authors: (game.expand?.authors || []).map((a) => ({ id: a.id, name: a.name })),
      tags: [],
    }),
    [game],
  );
  const metaFields = useMemo<GameMetaField[]>(
    () => (isModerator ? ['title', 'aliases', 'authors'] : ['title']),
    [isModerator],
  );
  const [meta, setMeta] = useState<GameMetaValue>(baseMeta);
  const [description, setDescription] = useState(game.description || '');
  const [releaseDate, setReleaseDate] = useState((game.release_date || '').slice(0, 10));
  const [originalLink, setOriginalLink] = useState(game.original_link || '');
  // iframe_url is a moderator field (it swaps the game content itself), see game_edits.go.
  const [iframeUrl, setIframeUrl] = useState(game.iframe_url || '');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [removedPages, setRemovedPages] = useState<Set<string>>(new Set());
  const [newPages, setNewPages] = useState<File[]>([]);
  // Browsers won't render too-tall images: the uploader offers to split them and blocks saving
  // until then.
  const [needsSplit, setNeedsSplit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isImgGame = game.img_or_link === 'img';
  const currentPages = useMemo(() => game.cyoa_pages || [], [game]);

  // Self-delete window: owner 1 hour after creation; moderator always.
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
      // Metadata diff computed by the shared editor: aliases compared normalized, authors as an id
      // set.
      const metaPatch = gameMetaPatch(baseMeta, meta, metaFields);
      if (metaPatch.title !== undefined) payload.title = metaPatch.title;
      if (metaPatch.aliases !== undefined) payload.aliases = metaPatch.aliases;
      if (metaPatch.authors !== undefined) payload.authors = metaPatch.authors.map((a) => a.id);
      if (description !== (game.description || '')) payload.description = description;
      if (releaseDate !== (game.release_date || '').slice(0, 10)) payload.release_date = releaseDate;
      if (originalLink !== (game.original_link || '')) payload.original_link = originalLink;
      if (isModerator && iframeUrl !== (game.iframe_url || '')) payload.iframe_url = iframeUrl;

      const formData = new FormData();
      if (imageFile) {
        formData.append('image', imageFile);
        const b64 = await makeBlurPlaceholder(imageFile);
        if (b64) payload.image_base64 = b64;
      }
      if (removedPages.size > 0) {
        payload.cyoa_pages_keep = currentPages.filter((n) => !removedPages.has(n));
      }
      // New pages converted to webp like CreateGame; original as fallback.
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
    <Dialog open={open} onClose={submitting ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        Edit game
        <IconButton onClick={onClose} disabled={submitting} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 0.5 }}>
          <GameMetaEditor
            value={meta}
            fields={metaFields}
            onChange={setMeta}
            disabled={submitting}
          />
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

          {isModerator && (
            <TextField
              label="Iframe URL"
              value={iframeUrl}
              onChange={(e) => setIframeUrl(e.target.value)}
              fullWidth
              size="small"
              helperText="Where the interactive game is actually served from. Moderators only — this swaps the game itself."
            />
          )}

          <Box>
            <Typography variant="subtitle2" gutterBottom>Cover image</Typography>
            {game.image && !imageFile && (
              <Box
                component="a"
                href={pb.files.getUrl(game, game.image)}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ display: 'inline-block', mb: 1 }}
              >
                <img
                  src={pb.files.getUrl(game, game.image, { thumb: '120x160' })}
                  alt="Current cover"
                  style={{ display: 'block', width: 90, borderRadius: 4, border: '1px solid rgba(255,255,255,0.15)' }}
                />
              </Box>
            )}
            <CardImageCropper
              onImageChange={setImageFile}
              buttonText={imageFile ? 'Pick another cover…' : 'Replace cover image…'}
            />
          </Box>

          {isImgGame && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Pages ({currentPages.length - removedPages.size} kept
                {newPages.length > 0 ? `, +${newPages.length} new` : ''})
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                Click a page to remove/restore it. New pages are appended at the end and can be
                dragged into order. Replaced pages are archived server-side and can be restored
                by a moderator.
              </Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxHeight: 260, overflowY: 'auto', mb: 1 }}>
                {currentPages.map((name, i) => {
                  const removed = removedPages.has(name);
                  return (
                    <Tooltip key={name} title={removed ? `${name} — will be removed` : name} arrow>
                      <Box
                        onClick={() => togglePage(name)}
                        sx={{
                          position: 'relative',
                          width: 84,
                          cursor: 'pointer',
                          borderRadius: 1,
                          overflow: 'hidden',
                          border: '2px solid',
                          borderColor: removed ? 'error.main' : 'divider',
                          opacity: removed ? 0.4 : 1,
                        }}
                      >
                        <img
                          src={pb.files.getUrl(game, name, { thumb: '160x220' })}
                          alt={`Page ${i + 1}`}
                          style={{ display: 'block', width: '100%', height: 100, objectFit: 'cover' }}
                        />
                        <Chip
                          label={removed ? 'removed' : `p${i + 1}`}
                          size="small"
                          color={removed ? 'error' : 'default'}
                          icon={removed ? <RestoreIcon /> : undefined}
                          sx={{ position: 'absolute', left: 2, bottom: 2, height: 20, fontSize: '0.65rem' }}
                        />
                      </Box>
                    </Tooltip>
                  );
                })}
              </Box>
              <CyoaImageUploader onImagesChange={setNewPages} onNeedsSplitChange={setNeedsSplit} />
              {needsSplit && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  One or more new pages are too tall and need splitting before saving.
                </Alert>
              )}
            </Box>
          )}

          {isModerator && (
            <GameRelationshipEditor selectedGame={game} />
          )}

          {isModerator && (
            <GameVariantsEditor game={game} disabled={submitting} />
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
        <Button onClick={handleSave} variant="contained" disabled={submitting || needsSplit}>
          {submitting ? <CircularProgress size={20} /> : 'Save changes'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

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

  // Cooldown from bumped_at; the server is the source of truth, this is UX only.
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
