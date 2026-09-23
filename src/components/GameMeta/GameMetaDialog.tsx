// Modal around GameMetaEditor for places where editing is a separate action (/moderator/queue row,
// card button). Diff and save live in the editor; the dialog frames it and closes after success.

import { Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import GameMetaEditor from './GameMetaEditor';
import { GameMetaAdapter, GameMetaField, GameMetaValue } from './types';

interface GameMetaDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  value: GameMetaValue;
  fields: GameMetaField[];
  adapter: GameMetaAdapter;
  onSaved?: (patch: Partial<GameMetaValue>, next: GameMetaValue) => void;
  closeOnSave?: boolean;
}

export default function GameMetaDialog({
  open,
  onClose,
  title = 'Edit game metadata',
  value,
  fields,
  adapter,
  onSaved,
  closeOnSave = true,
}: GameMetaDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ pr: 6 }}>
        {title}
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {/*
          The editor keeps its draft from mount, so unmount on close — the next open starts from
          current values.
        */}
        {open && (
          <GameMetaEditor
            value={value}
            fields={fields}
            adapter={adapter}
            saveLabel="Save changes"
            onSaved={(patch, next) => {
              onSaved?.(patch, next);
              if (closeOnSave) onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
