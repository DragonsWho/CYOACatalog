// Pick your anon mask (the label you post under without a name). Stored in the browser indefinitely
// (anonMask.ts); this dialog is the only place it changes, for guests and logged-in users alike.
// The "Anon" prefix is NOT editable on purpose: it's drawn identically everywhere (anonIdentity);
// without it "Anon Fox" next to a real "Fox" would read as one person.

import { useEffect, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle,
  InputAdornment, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';

import { nickColor } from '../Shoutbox/anonIdentity';
import {
  ANON_MASK_MAX, anonMask, anonMaskProblem, rerollAnonMask, setAnonMask,
} from '../Shoutbox/anonMask';
import AnonMaskIcon from './AnonMaskIcon';

export default function AnonMaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  // Show errors only after the user starts editing.
  const [touched, setTouched] = useState(false);

  // Load current value on OPEN, not mount: the dialog stays mounted and would show last time's
  // unsaved text.
  useEffect(() => {
    if (!open) return;
    setText(anonMask());
    setTouched(false);
  }, [open]);

  const problem = anonMaskProblem(text);
  const shown = text.trim() || anonMask();

  const save = () => {
    if (problem) { setTouched(true); return; }
    setAnonMask(text);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>Your anon name</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <AnonMaskIcon sx={{ fontSize: 20, color: 'text.disabled' }} />
            <Typography sx={{ fontWeight: 600, color: nickColor(`mask:${shown.toLowerCase()}`) }}>
              Anon {shown}
            </Typography>
          </Stack>
          <TextField
            autoFocus
            size="small"
            value={text}
            onChange={(e) => { setText(e.target.value); setTouched(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
            error={touched && Boolean(problem)}
            helperText={(touched && problem) || `Up to ${ANON_MASK_MAX} characters.`}
            inputProps={{ maxLength: ANON_MASK_MAX }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <Box component="span" sx={{ color: 'text.disabled' }}>Anon</Box>
                </InputAdornment>
              ),
              endAdornment: (
                <InputAdornment position="end">
                  <Tooltip title="Another one">
                    <Button
                      size="small"
                      onClick={() => { setText(rerollAnonMask()); setTouched(true); }}
                      sx={{ minWidth: 0, px: 0.5 }}
                    >
                      <CasinoOutlinedIcon fontSize="small" />
                    </Button>
                  </Tooltip>
                </InputAdornment>
              ),
            }}
          />
          {/* Must say: a mask doesn't prove identity and doesn't move to other devices. */}
          <Typography variant="caption" color="text.secondary">
            Saved in this browser and kept until you change it. It&apos;s a signature,
            not an account — anyone can pick the same one, and it doesn&apos;t carry
            your posts to another device.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={Boolean(problem)}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
