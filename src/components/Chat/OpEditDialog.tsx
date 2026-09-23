// "Edit OP" dialog: topic owner (or moderator) edits text, images and their order. Title and tags
// are not editable here — the topic was already found, remembered and linked by them.

import { useEffect, useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack,
} from '@mui/material';
import OpPostField from './OpPostField';
import {
  opImages,
  opImageUrlAt,
  updateCommunityOp,
  type CommunityRoom,
  type OpImageSlot,
} from './communityApi';

type Props = {
  open: boolean;
  room: CommunityRoom | null;
  onClose: () => void;
  onSaved: (room: CommunityRoom) => void;
};

export default function OpEditDialog({ open, room, onClose, onSaved }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<OpImageSlot[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Every open starts from the current topic state, not the previous edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    setText(room?.op_text ?? '');
    // Saved images come as filenames: reorder/remove without re-uploading.
    setImages((room ? opImages(room) : []).map((name) => ({ name })));
    setError('');
    setBusy(false);
  }, [open, room?.id, room?.op_text]);

  const save = async () => {
    if (!room || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await updateCommunityOp({
        room: room.id,
        opText: text.trim(),
        images,
      });
      onSaved(next);
    } catch (e) {
      const msg = (e as { response?: { message?: string }; message?: string });
      setError(msg.response?.message || msg.message || 'Failed to save the post.');
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Edit the opening post</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
          <OpPostField
            autoFocus
            text={text}
            onText={setText}
            images={images}
            onImages={setImages}
            urlOf={(name) => {
              const i = room ? opImages(room).indexOf(name) : -1;
              return i >= 0 && room ? opImageUrlAt(room, i, '160x160') : undefined;
            }}
            disabled={busy}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !room}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
