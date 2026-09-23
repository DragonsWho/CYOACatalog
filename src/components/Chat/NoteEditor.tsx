// Personal note about a person (chat profile card). Two things: assigned name (shown EVERYWHERE
// instead of the real one — feed, members list, DM list) and a free note (shown only here). Private
// to the author: the collection is locked; only Go reads/writes it (shoutbox_user_state.go).

import { useEffect, useState } from 'react';
import { Box, Button, Stack, TextField, Typography } from '@mui/material';
import { saveChatNote } from '../Shoutbox/shoutboxApi';
import type { ChatNote } from '../Shoutbox/chatNotes';

// Same caps as the server: it truncates anyway, but better to hit the counter than have half the
// line silently cut.
const ALIAS_MAX = 32;
const NOTE_MAX = 280;

type Props = {
  userId: string;
  realName: string;
  note?: ChatNote;
};

export default function NoteEditor({ userId, realName, note }: Props) {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState(note?.a ?? '');
  const [text, setText] = useState(note?.n ?? '');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  // One card for all people — fields must reset when switching person, or a note goes to the wrong
  // one.
  useEffect(() => {
    setOpen(false);
    setAlias(note?.a ?? '');
    setText(note?.n ?? '');
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    setSaveError(false);
    try {
      await saveChatNote(userId, alias.trim(), text.trim());
      setOpen(false);
    } catch {
      // Save failed → keep the form open with the text, and say so: otherwise the user thinks it
      // saved.
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    const has = Boolean(note?.a || note?.n);
    return (
      <Box>
        {note?.n && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', whiteSpace: 'pre-wrap', mb: 0.5 }}
          >
            {note.n}
          </Typography>
        )}
        <Button size="small" variant="text" onClick={() => setOpen(true)}>
          {has ? 'Edit note' : 'Add note'}
        </Button>
      </Box>
    );
  }

  return (
    <Stack spacing={1}>
      <TextField
        size="small"
        label="Nickname"
        placeholder={realName}
        value={alias}
        onChange={(e) => setAlias(e.target.value.slice(0, ALIAS_MAX))}
        helperText="Shown instead of their name — only to you"
      />
      <TextField
        size="small"
        label="Note"
        multiline
        minRows={2}
        maxRows={6}
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, NOTE_MAX))}
      />
      <Stack direction="row" spacing={1}>
        <Button size="small" variant="contained" disabled={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button
          size="small"
          variant="text"
          disabled={busy}
          onClick={() => {
            setAlias(note?.a ?? '');
            setText(note?.n ?? '');
            setSaveError(false);
            setOpen(false);
          }}
        >
          Cancel
        </Button>
      </Stack>
      {saveError && (
        <Typography variant="caption" color="error">
          Could not save note. Try again.
        </Typography>
      )}
    </Stack>
  );
}
