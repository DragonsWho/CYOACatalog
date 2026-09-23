// Moderator editor for language/version variants (multilang hybrid model,
// wiki/components/multilang-variants-spec.md). One variant = one alternative version (translation,
// another release), picked on the card via LanguageSwitcher. game_variants.updateRule is admin-only
// in the PB schema, so writes go through moderator Go endpoints /api/custom/games/:id/variants[...]
// (game_variants.go) — the path previously available only via PB/add_game_variant.py.

import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, IconButton, Link, List, ListItem,
  ListItemText, TextField, Tooltip, Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CloseIcon from '@mui/icons-material/Close';
import { authedFetch, Game, GameVariant, gameVariantsCollectionPublic, VARIANT_FIELDS } from '../../pocketbase/pocketbase';

interface VariantDraft {
  language: string;
  versionLabel: string;
  title: string;
  description: string;
  iframeUrl: string;
}

const EMPTY_DRAFT: VariantDraft = { language: '', versionLabel: '', title: '', description: '', iframeUrl: '' };

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

interface GameVariantsEditorProps {
  game: Game;
  disabled?: boolean;
}

export default function GameVariantsEditor({ game, disabled }: GameVariantsEditorProps) {
  const [variants, setVariants] = useState<GameVariant[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // editingId === null with an empty draft → add form. '' never occurs (ids are non-empty), so null
  // unambiguously means "new variant".
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<VariantDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fetchVariants = async () => {
    setLoading(true);
    setListError(null);
    try {
      const result = await gameVariantsCollectionPublic.getFullList({
        filter: `game = "${game.id}"`,
        fields: VARIANT_FIELDS + ',game',
        sort: 'language',
      });
      setVariants(result);
    } catch (err) {
      console.error('GameVariantsEditor: fetch variants failed', err);
      setListError('Failed to load translations/variants.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchVariants(); }, [game.id]);

  const isImgGame = game.img_or_link === 'img';

  const startEdit = (v: GameVariant) => {
    setEditingId(v.id);
    setDraft({
      language: v.language || '',
      versionLabel: v.version_label || '',
      title: v.title || '',
      description: v.description || '',
      iframeUrl: v.iframe_url || '',
    });
    setFormError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  };

  const handleDelete = async (variant: GameVariant) => {
    const label = variant.version_label ? `${variant.language}/${variant.version_label}` : variant.language;
    if (!window.confirm(`Remove the "${label}" variant? The translation link will stop showing on the card.`)) return;
    try {
      const res = await authedFetch(`/api/custom/games/${game.id}/variants/${variant.id}/delete`, { method: 'POST' });
      if (!res.ok) throw new Error(await extractError(res, `Delete failed (${res.status})`));
      setVariants((prev) => prev.filter((v) => v.id !== variant.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleSubmit = async () => {
    const language = draft.language.trim();
    if (!language) { setFormError('Language code is required (e.g. ko, ja, ru).'); return; }
    // Static games (image pages) are uploaded as files this editor can't upload yet — see
    // add_game_variant.py "Static TODO".
    if (isImgGame && !editingId) {
      setFormError('This is an image-pages game — static variant uploads aren\'t supported here yet. Ask for a script-based add.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const payload: Record<string, unknown> = {
        language,
        version_label: draft.versionLabel.trim(),
        title: draft.title.trim(),
        description: draft.description.trim(),
        iframe_url: draft.iframeUrl.trim(),
      };
      const path = editingId
        ? `/api/custom/games/${game.id}/variants/${editingId}/edit`
        : `/api/custom/games/${game.id}/variants`;
      const res = await authedFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await extractError(res, `Save failed (${res.status})`));
      cancelEdit();
      await fetchVariants();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const formTitle = editingId ? 'Edit variant' : 'Add translation / version';

  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1.5 }}>
      <Typography variant="subtitle1" gutterBottom>Translations &amp; versions</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Alternate languages or re-releases of this game, switchable in-place on the card (no separate
        listing, likes/comments/tags stay shared with the original).
      </Typography>

      {loading && <CircularProgress size={20} />}
      {listError && <Alert severity="error" sx={{ mb: 1 }}>{listError}</Alert>}
      {!loading && !listError && variants.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>No variants yet.</Typography>
      )}
      {!loading && !listError && variants.length > 0 && (
        <List dense sx={{ mb: 1 }}>
          {variants.map((v) => (
            <ListItem
              key={v.id}
              disableGutters
              secondaryAction={
                <>
                  <Tooltip title="Edit">
                    <IconButton edge="end" size="small" onClick={() => startEdit(v)} disabled={disabled}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton edge="end" size="small" onClick={() => handleDelete(v)} disabled={disabled}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </>
              }
            >
              <ListItemText
                primary={
                  <Typography variant="body2" component="span">
                    <b>{v.language}</b>{v.version_label ? ` / ${v.version_label}` : ''}
                    {v.title ? ` — ${v.title}` : ''}
                  </Typography>
                }
                secondary={
                  v.iframe_url ? (
                    <Link href={v.iframe_url} target="_blank" rel="noopener noreferrer" sx={{ fontSize: '0.75rem' }}>
                      {v.iframe_url}
                    </Link>
                  ) : (
                    <Typography variant="caption" color="text.secondary">no iframe URL set</Typography>
                  )
                }
              />
            </ListItem>
          ))}
        </List>
      )}

      <Typography variant="subtitle2" sx={{ mt: 1, mb: 1 }}>
        {formTitle}
        {editingId && (
          <IconButton size="small" onClick={cancelEdit} sx={{ ml: 0.5 }}>
            <CloseIcon fontSize="inherit" />
          </IconButton>
        )}
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
        <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap' }}>
          <TextField
            label="Language code"
            value={draft.language}
            onChange={(e) => setDraft((d) => ({ ...d, language: e.target.value }))}
            size="small"
            sx={{ width: 160 }}
            disabled={disabled || submitting || !!editingId}
            helperText="ISO 639-1: ko, ja, ru…"
            inputProps={{ maxLength: 8 }}
          />
          <TextField
            label="Version label"
            value={draft.versionLabel}
            onChange={(e) => setDraft((d) => ({ ...d, versionLabel: e.target.value }))}
            size="small"
            sx={{ width: 160 }}
            disabled={disabled || submitting}
            helperText="Optional: v2, Director's Cut…"
            inputProps={{ maxLength: 60 }}
          />
          <TextField
            label="Title override"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            size="small"
            sx={{ flex: 1, minWidth: 200 }}
            disabled={disabled || submitting}
            helperText="Empty = use the original title"
            inputProps={{ maxLength: 300 }}
          />
        </Box>
        <TextField
          label="Iframe URL"
          value={draft.iframeUrl}
          onChange={(e) => setDraft((d) => ({ ...d, iframeUrl: e.target.value }))}
          fullWidth
          size="small"
          disabled={disabled || submitting}
          helperText="Where this version of the game is served from"
        />
        <TextField
          label="Description override"
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          fullWidth
          multiline
          minRows={2}
          maxRows={6}
          size="small"
          disabled={disabled || submitting}
          helperText="Empty = use the original description"
        />
        {formError && <Alert severity="error">{formError}</Alert>}
        <Box>
          <Button
            variant="outlined"
            size="small"
            onClick={handleSubmit}
            disabled={disabled || submitting}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {editingId ? 'Save variant' : 'Add variant'}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
