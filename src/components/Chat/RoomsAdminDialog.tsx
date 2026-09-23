// Moderator view of shared rooms: create, rename, reorder, hide from menu, make private. Separate
// from RoomDialog (personal rooms with friends vs chat structure).
// Deliberately NOT supported:
// - delete: a room is also all its history; "hide from menu" (enabled) does what people want and is
// reversible;
// - slug editing: it's in links and the Discord bridge; renaming is cosmetic, don't break links;
// - showing others' private rooms: the server never returns them, else "make public" = "publish
// someone's private chat".
// The staff room is in the same list but created by a separate button: membership is NOT manual —
// the server keeps exactly the moderators there (shoutbox_staff.go). Create and resync only; never
// public.

import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, IconButton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import SyncIcon from '@mui/icons-material/Sync';
import {
  AdminRoom, ShoutChannel, STAFF_ROOM_SLUG, createPublicRoom, fetchAdminRooms,
  moveAdminRoom, syncStaffRoom, updateAdminRoom,
} from '../Shoutbox/shoutboxApi';
import RoomDialog from './RoomDialog';

// Caps mirror the server (shoutbox_rooms_admin.go). Change together.
const TITLE_MAX = 40;
const DESC_MAX = 200;

type Props = {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  // Who opened the panel: the member dialog shows invite only to the room owner (server rule).
  meId: string;
};

export default function RoomsAdminDialog({ open, onClose, onChanged, meId }: Props) {
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [newTitle, setNewTitle] = useState('');
  // One room edited at a time: two open field sets is how you save to the wrong one.
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState({ title: '', description: '' });
  // Membership view uses the same dialog owners use for private rooms — there must not be a second
  // member list.
  const [members, setMembers] = useState<AdminRoom | null>(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    setEditing('');
    setNewTitle('');
    setMembers(null);
    setLoading(true);
    fetchAdminRooms()
      .then(setRooms)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the rooms'))
      .finally(() => setLoading(false));
  }, [open]);

  const run = useCallback(async (id: string, fn: () => Promise<AdminRoom[]>) => {
    setBusy(id || 'new');
    setError('');
    try {
      setRooms(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  }, [onChanged]);

  const create = () => {
    const title = newTitle.trim();
    if (!title) return;
    void run('', () => createPublicRoom(title)).then(() => setNewTitle(''));
  };

  const startEdit = (r: AdminRoom) => {
    setEditing(r.id);
    setDraft({ title: r.title, description: r.description });
  };

  const saveEdit = (r: AdminRoom) => {
    setEditing('');
    const title = draft.title.trim();
    const description = draft.description.trim();
    if (!title) return;
    // Send only changed fields: an empty key means "don't touch" on the server.
    const patch: { title?: string; description?: string } = {};
    if (title !== r.title) patch.title = title;
    if (description !== r.description) patch.description = description;
    if (!patch.title && patch.description === undefined) return;
    void run(r.id, () => updateAdminRoom(r.id, patch));
  };

  const publicRooms = rooms.filter((r) => !r.is_private).map((r) => r.id);
  const staff = rooms.find((r) => r.slug === STAFF_ROOM_SLUG && r.is_private);
  // One button for "create" and "resync" staff room: one server request either way.
  const syncStaff = () => { void run(staff?.id || 'staff', syncStaffRoom); };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ pr: 6 }}>
        Chat rooms
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}

        {/* Slug derived from the name on the server. */}
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <TextField
            size="small"
            fullWidth
            label="New room"
            placeholder="Off Topic"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value.slice(0, TITLE_MAX))}
            onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            disabled={busy !== ''}
          />
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={create}
            disabled={!newTitle.trim() || busy !== ''}
          >
            Add
          </Button>
        </Stack>

        {!loading && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ mb: 2, px: 1, py: 1, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.03)' }}
          >
            <ShieldOutlinedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {staff ? (staff.title || 'Staff') : 'Staff room'}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="div">
                {staff
                  ? `#${staff.slug} · ${staff.members.length} member${staff.members.length === 1 ? '' : 's'} · every moderator, kept in sync`
                  : 'A private room only moderators see. Its members follow the moderator list.'}
              </Typography>
            </Box>
            <Button
              size="small"
              variant={staff ? 'outlined' : 'contained'}
              startIcon={staff ? <SyncIcon fontSize="small" /> : <AddIcon />}
              onClick={syncStaff}
              disabled={busy !== ''}
            >
              {staff ? 'Sync' : 'Create'}
            </Button>
          </Stack>
        )}

        {loading && <Box sx={{ textAlign: 'center', py: 3 }}><CircularProgress size={24} /></Box>}

        {!loading && rooms.length === 0 && (
          <Typography variant="body2" color="text.secondary">No rooms yet.</Typography>
        )}

        <Stack spacing={0.5}>
          {rooms.map((r) => {
            const working = busy === r.id;
            const isStaff = r.slug === STAFF_ROOM_SLUG && r.is_private;
            // First/last computed within the PUBLIC row: private rooms are listed but not in menu
            // order; "up" on a neighbor would do nothing.
            const at = publicRooms.indexOf(r.id);
            return (
              <Stack
                key={r.id}
                direction="row"
                alignItems="center"
                spacing={0.5}
                sx={{
                  px: 1, py: 0.75, borderRadius: 1,
                  bgcolor: 'rgba(255,255,255,0.03)',
                  opacity: r.enabled ? 1 : 0.5,
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  {editing === r.id ? (
                    <Stack spacing={1} sx={{ py: 0.5 }}>
                      <TextField
                        size="small"
                        fullWidth
                        autoFocus
                        label="Name"
                        value={draft.title}
                        inputProps={{ maxLength: TITLE_MAX }}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditing('');
                          if (e.key === 'Enter') saveEdit(r);
                        }}
                      />
                      <TextField
                        size="small"
                        fullWidth
                        label="Description"
                        placeholder="What this room is for"
                        value={draft.description}
                        inputProps={{ maxLength: DESC_MAX }}
                        onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditing('');
                          if (e.key === 'Enter') saveEdit(r);
                        }}
                      />
                      <Stack direction="row" spacing={1}>
                        <Button size="small" variant="contained" onClick={() => saveEdit(r)}>Save</Button>
                        <Button size="small" onClick={() => setEditing('')}>Cancel</Button>
                      </Stack>
                    </Stack>
                  ) : (
                    <>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                        {r.title || r.slug}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        #{r.slug}
                        {r.is_private && ' · private'}
                        {!r.enabled && ' · hidden'}
                      </Typography>
                    </>
                  )}
                </Box>

                {working
                  ? <CircularProgress size={18} sx={{ mx: 1 }} />
                  : (
                    <>
                      {/* Order only for public rooms: a private room isn't in the shared menu. */}
                      <Tooltip title={r.is_private ? 'Only public rooms are ordered' : 'Move up'}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy !== '' || r.is_private || at === 0}
                            onClick={() => run(r.id, () => moveAdminRoom(r.id, 'up'))}
                          >
                            <KeyboardArrowUpIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title={r.is_private ? 'Only public rooms are ordered' : 'Move down'}>
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy !== '' || r.is_private || at === publicRooms.length - 1}
                            onClick={() => run(r.id, () => moveAdminRoom(r.id, 'down'))}
                          >
                            <KeyboardArrowDownIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>

                      <Tooltip title="Rename">
                        <IconButton size="small" disabled={busy !== ''} onClick={() => startEdit(r)}>
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>

                      {/*
                        Membership only for private rooms; staff membership is server-managed and
                        manual edits wouldn't survive resync.
                      */}
                      {r.is_private && !isStaff && (
                        <Tooltip title="Members — invite or remove people">
                          <IconButton size="small" disabled={busy !== ''} onClick={() => setMembers(r)}>
                            <GroupOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      )}

                      <Tooltip title={isStaff
                        ? 'The staff room is always private'
                        : (r.is_private
                          ? 'Private: only invited members see it. Click to open it to everyone'
                          : 'Public: everyone sees it. Click to make it private')}
                      >
                        <span>
                          <IconButton
                            size="small"
                            disabled={busy !== '' || isStaff}
                            onClick={() => run(r.id, () => updateAdminRoom(r.id, { is_private: !r.is_private }))}
                          >
                            {r.is_private
                              ? <LockOutlinedIcon fontSize="small" />
                              : <LockOpenOutlinedIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>

                      <Tooltip title={r.enabled
                        ? 'Visible in the chat. Click to hide it (nothing is deleted)'
                        : 'Hidden from the chat. Click to bring it back'}
                      >
                        <IconButton
                          size="small"
                          disabled={busy !== ''}
                          onClick={() => run(r.id, () => updateAdminRoom(r.id, { enabled: !r.enabled }))}
                        >
                          {r.enabled
                            ? <VisibilityOutlinedIcon fontSize="small" />
                            : <VisibilityOffOutlinedIcon fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
              </Stack>
            );
          })}
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
          Rooms are never deleted here — hiding one keeps every message in it, and
          you can bring it back at any time. Making a room private leaves it
          visible to you and to whoever is already a member.
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Renaming a room does not change its address — that one is already part
          of links people have shared.
        </Typography>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>

      {/*
        Private room membership edited via the owner's dialog; the server still checks ownership —
        moderators see but can't invite, and the dialog says so.
      */}
      {members && (
        <RoomDialog
          open
          room={members as ShoutChannel}
          meId={meId}
          onClose={() => setMembers(null)}
          onDone={() => {
            // Membership changed → refetch the whole list, or member counts stay stale.
            void run(members.id, fetchAdminRooms);
            setMembers(null);
          }}
        />
      )}
    </Dialog>
  );
}
