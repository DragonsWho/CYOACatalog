// One card metadata editor for all four moderator screens (/moderator/review, /moderator/queue,
// /game/:id edit dialog, /moderator). Two modes because callers save at different paces:
// - controlled (no adapter): fields + onChange(next). For the card dialog, where one "Save changes"
// packs everything (incl. cover and pages) into one multipart POST — a second save button inside it
// would be a regression;
// - standalone (adapter given): own draft, Save button and diff (review queue rows).
// Standalone state initializes ONCE on mount: to show another game, mount with key={row.id}.

import { useMemo, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Link, TextField, Typography } from '@mui/material';
import AuthorSelector from '../Add/AuthorSelector';
import ModeratorTagSelector from '../ModeratorPanel/ModeratorTagSelector';
import { Author } from '../../pocketbase/pocketbase';
import { useAuthorsCatalog, useTagNames } from './catalogs';
import { GameMetaAdapter, GameMetaField, GameMetaValue, gameMetaPatch } from './types';

export interface GameMetaEditorProps {
  value: GameMetaValue;
  fields: GameMetaField[];
  onChange?: (next: GameMetaValue) => void;
  adapter?: GameMetaAdapter;
  onSaved?: (patch: Partial<GameMetaValue>, next: GameMetaValue) => void;
  disabled?: boolean;
  dense?: boolean;
  saveLabel?: string;
}

export default function GameMetaEditor({
  value,
  fields,
  onChange,
  adapter,
  onSaved,
  disabled,
  dense,
  saveLabel = 'Save',
}: GameMetaEditorProps) {
  const controlled = !adapter;

  const [draft, setDraft] = useState<GameMetaValue>(value);
  const [baseline, setBaseline] = useState<GameMetaValue>(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = controlled ? value : draft;

  // Show a field if the caller asked AND the storage supports it (the queue may lack the aliases
  // column yet).
  const visible = useMemo(
    () => fields.filter((f) => !adapter || adapter.supports(f)),
    [fields, adapter],
  );
  const show = (f: GameMetaField) => visible.includes(f);

  const {
    authors: authorCatalog, setAuthors: publishAuthors,
    error: authorsError, retry: retryAuthors,
  } = useAuthorsCatalog(show('authors'));
  const tagNames = useTagNames(show('tags'));

  const update = (patch: Partial<GameMetaValue>) => {
    const next = { ...current, ...patch };
    if (controlled) onChange?.(next);
    else setDraft(next);
  };

  // AuthorSelector works with full collection records; the queue sends trimmed {id,name} —
  // substitute registry records when found.
  const selectedAuthors = useMemo(
    () => current.authors.map((a) => authorCatalog.find((x) => x.id === a.id) ?? ({ ...a } as Author)),
    [current.authors, authorCatalog],
  );

  const patch = useMemo(
    () => (controlled ? {} : gameMetaPatch(baseline, draft, visible)),
    [controlled, baseline, draft, visible],
  );
  const dirty = Object.keys(patch).length > 0;

  const handleSave = async () => {
    if (!adapter || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await adapter.save(patch);
      setBaseline(draft);
      onSaved?.(patch, draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const gap = dense ? 1.25 : 2;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap }}>
      {show('title') && (
        <TextField
          label="Title"
          value={current.title}
          onChange={(e) => update({ title: e.target.value })}
          fullWidth
          size="small"
          disabled={disabled || saving}
          inputProps={{ maxLength: 300 }}
        />
      )}

      {show('aliases') && (
        <TextField
          label="Alternative titles"
          value={current.aliases}
          onChange={(e) => update({ aliases: e.target.value })}
          fullWidth
          multiline
          minRows={dense ? 1 : 2}
          maxRows={8}
          size="small"
          disabled={disabled || saving}
          inputProps={{ maxLength: 2000 }}
          helperText="One per line: other names this CYOA is known by (re-releases, translations, thread nicknames). Searchable, shown greyed out under the title. Moderators only."
        />
      )}

      {show('authors') && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Authors</Typography>
          {/*
            Registry failed to load: a silently empty list looks like "nobody in the DB" and
            moderators create duplicate authors. Say so and offer retry without reloading.
          */}
          {authorsError && (
            <Typography variant="caption" color="error" sx={{ display: 'block', mb: 0.5 }}>
              {authorsError}{' '}
              <Link component="button" type="button" variant="caption" onClick={retryAuthors}>
                Retry
              </Link>
            </Typography>
          )}
          <AuthorSelector
            value={selectedAuthors}
            onChange={(list) => update({ authors: list.map((a) => ({ id: a.id, name: a.name })) })}
            availableAuthors={authorCatalog}
            onAuthorsChange={publishAuthors}
          />
        </Box>
      )}

      {show('tags') && (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Tags</Typography>
          <ModeratorTagSelector
            gameTags={current.tags}
            onTagsChange={(ids) =>
              update({ tags: ids.map((id) => ({ id, name: tagNames[id] || id })) })}
          />
        </Box>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      {!controlled && (
        <Box>
          <Button
            variant="outlined"
            size="small"
            onClick={handleSave}
            disabled={disabled || saving || !dirty}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
          >
            {saveLabel}
          </Button>
        </Box>
      )}
    </Box>
  );
}
