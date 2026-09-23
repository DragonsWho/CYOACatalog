// The user's personal block list, so blocks can be undone (before, a blocked person vanished from
// chat with no way back). Names fetched by id via fetchProfile: the block list stores only ids
// (shoutbox_blocks.go) and the person may be in no open feed.

import { useEffect, useState } from 'react';
import {
  Avatar, Box, Button, CircularProgress, Dialog, DialogContent, DialogTitle,
  IconButton, List, ListItem, ListItemAvatar, ListItemText, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { ShoutProfile, avatarUrlOf, fetchProfile } from '../Shoutbox/shoutboxApi';
import { nickColor } from '../Shoutbox/anonIdentity';
import { staffNickColor, useChatAdmins } from './staff';
import { useChatNotes } from '../Shoutbox/chatNotes';

type Props = {
  open: boolean;
  ids: string[];
  onClose: () => void;
  onUnblock: (id: string) => void;
};

export default function BlockedUsersDialog({ open, ids, onClose, onUnblock }: Props) {
  const { notes } = useChatNotes();
  const admins = useChatAdmins();
  // undefined = loading, null = not found (account may be gone).
  const [cards, setCards] = useState<Record<string, ShoutProfile | null | undefined>>({});

  // Each open fetches only unseen ids.
  useEffect(() => {
    if (!open) return;
    const missing = ids.filter((id) => !(id in cards));
    if (missing.length === 0) return;
    let dead = false;
    missing.forEach((id) => {
      fetchProfile(id).then((p) => {
        if (dead) return;
        setCards((cur) => ({ ...cur, [id]: p }));
      });
    });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ids]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pr: 6 }}>
        Blocked users
        <IconButton
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
          aria-label="Close"
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ pt: 0 }}>
        {ids.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
            Nobody blocked. Messages from people you block here will stay hidden
            until you unblock them.
          </Typography>
        ) : (
          <List dense disablePadding>
            {ids.map((id) => {
              const card = cards[id];
              const alias = notes[id]?.a;
              const name = alias || card?.name || card?.username || 'User';
              return (
                <ListItem
                  key={id}
                  disableGutters
                  secondaryAction={(
                    <Button size="small" onClick={() => onUnblock(id)}>
                      Unblock
                    </Button>
                  )}
                >
                  <ListItemAvatar sx={{ minWidth: 40 }}>
                    <Avatar src={card ? avatarUrlOf(card) : undefined} sx={{ width: 28, height: 28, fontSize: 13 }}>
                      {name[0]}
                    </Avatar>
                  </ListItemAvatar>
                  {card === undefined ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <CircularProgress size={14} />
                      <Typography variant="body2" color="text.secondary">Loading…</Typography>
                    </Box>
                  ) : (
                    <ListItemText
                      primary={name}
                      primaryTypographyProps={{
                        sx: { color: staffNickColor(id, card?.isModerator, admins) ?? nickColor(id) },
                      }}
                      secondary={card?.username ? `@${card.username}` : undefined}
                    />
                  )}
                </ListItem>
              );
            })}
          </List>
        )}
      </DialogContent>
    </Dialog>
  );
}
