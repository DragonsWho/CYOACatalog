// Pinned strip above the feed (Telegram model, not Discord). A pin is a message property and used
// to exist ONLY as amber row highlighting — findable only by scrolling to it, which defeats
// pinning. The strip hangs the message above the conversation; click jumps to it. No Discord-style
// shelf (few rooms, a pin or two each); the secondary list opens via a button next to the counter
// when >1 pin.

import { useState } from 'react';
import { Box, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import CloseIcon from '@mui/icons-material/Close';
import { anonIdentity, nickColor } from '../Shoutbox/anonIdentity';
import { staffNickColor, useChatAdmins } from './staff';
import { renderRichText } from '../Shoutbox/richText';
import { EMOJI_SIZE } from '../Emoji/registry';
import { chatTime } from '../CyoaPage/Comments/relativeTime';
import type { ShoutMessage } from '../Shoutbox/shoutboxApi';

const BAR_ID = 'chat-pinned-bar';

type Props = {
  pins: ShoutMessage[];
  isModerator: boolean;
  // Jump to the message; `false` = not in the feed memory window.
  onJump: (m: ShoutMessage) => boolean;
  onUnpin: (m: ShoutMessage) => void;
};

// Author name/color follow the feed row rules: anonymous persona only for real anons (anon_key).
function authorOf(m: ShoutMessage, admins: ReadonlySet<string>): { name: string; color?: string } {
  const u = m.expand?.user;
  if (u) {
    return {
      name: u.name || u.username || 'User',
      color: staffNickColor(u.id, u.isModerator, admins) ?? nickColor(u.id),
    };
  }
  if (m.anon_key) {
    const a = anonIdentity(m.anon_key, m.anon_mask);
    return { name: a.name, color: a.color };
  }
  return { name: 'Anonymous' };
}

// One line: first text line without quote markup. No text = an image; name it in words or the strip
// is empty.
function preview(m: ShoutMessage): string {
  const line = (m.text || '')
    .split('\n')
    .map((s) => s.replace(/^>\s?/, '').trim())
    .find((s) => s.length > 0);
  if (line) return line;
  return m.image ? 'Image' : '…';
}

export default function PinnedBar({
  pins, isModerator, onJump, onUnpin,
}: Props) {
  const [idx, setIdx] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const admins = useChatAdmins();
  // Pins re-arrive on room switch and each pin; keep the shown index in bounds here rather than an
  // effect per arrival.
  const at = pins.length > 0 ? idx % pins.length : 0;
  const cur = pins[at];
  const [missing, setMissing] = useState('');

  if (!cur) return null;

  const go = (m: ShoutMessage, fromList: boolean) => {
    if (onJump(m)) {
      setMissing('');
      setAnchor(null);
      // Clicking the strip cycles pins (Telegram-style).
      if (!fromList && pins.length > 1) setIdx(at + 1);
      return;
    }
    // Can't jump but it must still be readable: open the list (pin shown in full) instead of an
    // error.
    setMissing(m.id);
    if (!fromList) setAnchor(document.getElementById(BAR_ID));
  };

  const author = authorOf(cur, admins);

  return (
    <>
      <Box
        id={BAR_ID}
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: { xs: 0.75, sm: 1.25 },
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          // Same amber as the pinned feed row: strip and row must read as one thing.
          bgcolor: 'rgba(255,193,7,0.07)',
          boxShadow: 'inset 3px 0 0 #ffc107',
        }}
      >
        <PushPinOutlinedIcon sx={{ fontSize: 15, color: 'warning.main', flexShrink: 0 }} />
        <Box
          component="button"
          type="button"
          onClick={() => go(cur, false)}
          title="Go to the pinned message"
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'baseline',
            gap: 0.75,
            border: 0,
            p: 0,
            bgcolor: 'transparent',
            color: 'text.secondary',
            fontFamily: 'inherit',
            fontSize: 12,
            textAlign: 'left',
            cursor: 'pointer',
            '&:hover .pin-text': { color: 'text.primary' },
          }}
        >
          <Box component="span" sx={{ flexShrink: 0, fontWeight: 700, color: 'warning.main' }}>
            Pinned{pins.length > 1 ? ` ${at + 1}/${pins.length}` : ''}
          </Box>
          <Box component="span" sx={{ flexShrink: 0, fontWeight: 600 }} style={{ color: author.color }}>
            {author.name}:
          </Box>
          {/*
            Single line with ellipsis: a long pin must not grow the strip and eat the feed; full
            text in the list.
          */}
          <Box
            component="span"
            className="pin-text"
            sx={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {preview(cur)}
          </Box>
        </Box>

        {pins.length > 1 && (
          <Tooltip title="All pinned messages">
            <IconButton
              size="small"
              onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
              sx={{ flexShrink: 0 }}
            >
              <ListAltOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        {isModerator && (
          <Tooltip title="Unpin this message">
            <IconButton size="small" onClick={() => onUnpin(cur)} sx={{ flexShrink: 0 }}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => { setAnchor(null); setMissing(''); }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: '94vw', borderRadius: 2 } } }}
      >
        <Box sx={{ maxHeight: 360, overflowY: 'auto', py: 0.5 }}>
          {pins.map((m) => {
            const a = authorOf(m, admins);
            return (
              <Box
                key={m.id}
                onClick={() => go(m, true)}
                sx={{
                  px: 1.25,
                  py: 0.75,
                  cursor: 'pointer',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
                  '& + &': { borderTop: 1, borderColor: 'divider' },
                }}
              >
                <Stack direction="row" alignItems="baseline" spacing={0.75}>
                  <Typography variant="caption" sx={{ fontWeight: 700 }} style={{ color: a.color }}>
                    {a.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                    {chatTime(m.created)}
                  </Typography>
                  {isModerator && (
                    <Tooltip title="Unpin">
                      <IconButton
                        size="small"
                        onClick={(e) => { e.stopPropagation(); onUnpin(m); }}
                      >
                        <CloseIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Stack>
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.25 }}
                >
                  {/* Emoji smaller than in the feed: full-size would stretch the strip. */}
                  {m.text
                    ? renderRichText(m.text, { emojiSize: EMOJI_SIZE.reaction })
                    : <i>Image</i>}
                </Typography>
                {missing === m.id && (
                  <Typography variant="caption" color="text.secondary">
                    Too far back to jump to — but here it is.
                  </Typography>
                )}
              </Box>
            );
          })}
        </Box>
      </Popover>
    </>
  );
}
