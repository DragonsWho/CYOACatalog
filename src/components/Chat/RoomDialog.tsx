// Private room dialog: create, or view/edit membership. DMs deliberately excluded: nothing to
// configure in a two-person conversation (invite/kick/leave all refused by the server).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Avatar, Box, Button, Chip, CircularProgress, Dialog,
  DialogActions, DialogContent, DialogTitle, IconButton, Stack, TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import {
  MentionUser, ShoutChannel, avatarUrlOf, createRoom, leaveRoom, memberCard,
  searchMentionUsers, updateRoomMembers,
} from '../Shoutbox/shoutboxApi';

const MENTION_SEARCH_DEBOUNCE_MS = 300;

// Caps mirror the server (shoutbox_rooms.go) so the field refuses immediately. Change together.
const ROOM_TITLE_MAX = 40;
const ROOM_MEMBERS_MAX = 20;

type Props = {
  open: boolean;
  room?: ShoutChannel;
  meId: string;
  onClose: () => void;
  onDone: (room: ShoutChannel | null, opened?: boolean) => void;
};

export default function RoomDialog({ open, room, meId, onClose, onDone }: Props) {
  const creating = !room;
  const isOwner = Boolean(room && room.owner === meId);

  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<MentionUser[]>([]);
  const [options, setOptions] = useState<MentionUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Every open starts clean: one dialog for all rooms.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setPicked([]);
    setOptions([]);
    setError('');
  }, [open, room?.id]);

  // People search used to hit the server on EVERY keystroke without ordering: a slow "an" response
  // arrived after a fast "anna" and replaced the list. Debounce + generation counter: apply only
  // the latest request's answer.
  const searchTimerRef = useRef<number | undefined>(undefined);
  const searchGenRef = useRef(0);

  const search = useCallback((q: string) => {
    window.clearTimeout(searchTimerRef.current);
    const term = q.trim();
    if (term.length < 2) { searchGenRef.current += 1; setOptions([]); return; }
    searchTimerRef.current = window.setTimeout(() => {
      const gen = ++searchGenRef.current;
      searchMentionUsers(term)
        .then((rows) => { if (gen === searchGenRef.current) setOptions(rows); })
        .catch(() => { if (gen === searchGenRef.current) setOptions([]); });
    }, MENTION_SEARCH_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(searchTimerRef.current), []);

  const submitCreate = async () => {
    setBusy(true);
    setError('');
    try {
      const ch = await createRoom(title.trim(), picked.map((u) => u.id));
      onDone(ch, true);
      onClose();
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to create the room.');
    } finally {
      setBusy(false);
    }
  };

  const invite = async () => {
    if (!room || picked.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const ch = await updateRoomMembers(room.id, picked.map((u) => u.id));
      setPicked([]);
      onDone(ch);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to invite.');
    } finally {
      setBusy(false);
    }
  };

  const kick = async (id: string) => {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      const ch = await updateRoomMembers(room.id, [], [id]);
      onDone(ch);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to remove.');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!room) return;
    setBusy(true);
    setError('');
    try {
      await leaveRoom(room.id);
      onDone(null);
      onClose();
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to leave.');
    } finally {
      setBusy(false);
    }
  };

  const members = room?.members ?? [];
  const canInvite = isOwner && members.length + picked.length <= ROOM_MEMBERS_MAX;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pr: 6 }}>
        {creating ? 'New private room' : room?.title}
        <IconButton
          onClick={onClose}
          disabled={busy}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          aria-label="Close"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {creating && (
            <TextField
              autoFocus
              size="small"
              label="Room name"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, ROOM_TITLE_MAX))}
              helperText={`${title.length}/${ROOM_TITLE_MAX}`}
              fullWidth
            />
          )}

          {!creating && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                {members.length === 1 ? '1 member' : `${members.length} members`}
              </Typography>
              <Stack direction="row" flexWrap="wrap" gap={0.75} sx={{ mt: 0.75 }}>
                {members.map((id) => {
                  const card = memberCard(id);
                  return (
                    <Chip
                      key={id}
                      size="small"
                      avatar={<Avatar src={avatarUrlOf(card)}>{(card?.name || '?')[0]}</Avatar>}
                      label={card?.name || 'User'}
                      // The owner can't be kicked from their own room — they leave, and the room
                      // passes to the next member.
                      onDelete={isOwner && id !== meId ? () => kick(id) : undefined}
                    />
                  );
                })}
              </Stack>
            </Box>
          )}

          {(creating || isOwner) && (
            <Autocomplete
              multiple
              size="small"
              options={options}
              value={picked}
              onChange={(_, v) => setPicked(v.slice(0, ROOM_MEMBERS_MAX))}
              onInputChange={(_, v) => search(v)}
              getOptionLabel={(u) => u.name || u.username}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              // No client filter: the server already filtered by the query; a built-in one would
              // drop half the matches again.
              filterOptions={(x) => x}
              renderInput={(params) => (
                <TextField {...params} label={creating ? 'Invite (optional)' : 'Invite'} />
              )}
              fullWidth
            />
          )}

          {!creating && !isOwner && (
            <Typography variant="caption" color="text.secondary">
              Only the room owner can invite or remove people.
            </Typography>
          )}

          {error && <Alert severity="warning">{error}</Alert>}
        </Stack>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        {!creating && (
          <Button color="error" onClick={leave} disabled={busy} sx={{ mr: 'auto' }}>
            Leave room
          </Button>
        )}
        {creating ? (
          <Button
            variant="contained"
            onClick={submitCreate}
            disabled={busy || title.trim().length === 0}
            startIcon={busy ? <CircularProgress size={16} /> : undefined}
          >
            Create
          </Button>
        ) : (
          isOwner && (
            <Button
              variant="contained"
              onClick={invite}
              disabled={busy || picked.length === 0 || !canInvite}
              startIcon={busy ? <CircularProgress size={16} /> : undefined}
            >
              Invite
            </Button>
          )
        )}
      </DialogActions>
    </Dialog>
  );
}
