// Emoji picker: search + grid grouped by pack. Two roles (reaction, insert into composer) — only
// what the caller does with onPick differs.

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Popover, TextField, Typography, InputAdornment, Divider, IconButton, Tooltip,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import SearchIcon from '@mui/icons-material/Search';
import TuneIcon from '@mui/icons-material/Tune';
import EmojiImg from './EmojiImg';
import { EmojiDef, EMOJI_SIZE } from './registry';
import { AuthContext } from '../../pocketbase/pocketbase';

const PACK_TITLES: Record<string, string> = {
  service: 'Reactions',
  anime: 'Anime',
};

// Utility pack first: 90% of reactions are thumbs and hearts; they mustn't be buried under anime
// faces.
const PACK_ORDER = ['service', 'anime'];
const packRank = (p: string) => {
  const i = PACK_ORDER.indexOf(p);
  return i < 0 ? PACK_ORDER.length : i;
};

interface Props {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  emoji: EmojiDef[];
  quick: EmojiDef[];
  onPick: (e: EmojiDef) => void;
  // Stay open after a pick — for entering several emoji.
  keepOpen?: boolean;
  cell?: number;
}

export default function EmojiPicker({
  anchorEl, open, onClose, emoji, quick, onPick, keepOpen = false,
  cell = EMOJI_SIZE.picker,
}: Props) {
  const [q, setQ] = useState('');
  const [hover, setHover] = useState<EmojiDef | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The pack admin page is otherwise undiscoverable without the URL — link it where people think
  // about the pack.
  const { isModerator } = useContext(AuthContext);

  // Every open starts clean, else the old search hides half the pack.
  useEffect(() => {
    if (open) {
      setQ('');
      setHover(null);
    }
  }, [open]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = needle ? emoji.filter((e) => e.name.toLowerCase().includes(needle)) : emoji;

    const out: { key: string; title: string; items: EmojiDef[] }[] = [];
    if (!needle && quick.length) {
      out.push({ key: 'quick', title: 'Frequently used', items: quick });
    }
    [...new Set(hit.map((e) => e.pack))]
      .sort((a, b) => packRank(a) - packRank(b) || a.localeCompare(b))
      .forEach((p) => {
        out.push({ key: p, title: PACK_TITLES[p] ?? p, items: hit.filter((e) => e.pack === p) });
      });
    return out.filter((g) => g.items.length > 0);
  }, [emoji, quick, q]);

  const total = groups.reduce((n, g) => n + (g.key === 'quick' ? 0 : g.items.length), 0);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      slotProps={{
        paper: {
          sx: {
            width: 340,
            bgcolor: '#1a1a1a',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 2,
          },
        },
      }}
      TransitionProps={{ onEntered: () => searchRef.current?.focus() }}
    >
      <Box sx={{ p: 1.25, pb: 1 }}>
        <TextField
          inputRef={searchRef}
          size="small"
          fullWidth
          placeholder="Search emoji…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" sx={{ color: '#777' }} />
              </InputAdornment>
            ),
          }}
        />
      </Box>

      <Box sx={{ maxHeight: 300, overflowY: 'auto', px: 1.25, pb: 1 }}>
        {groups.length === 0 && (
          <Typography variant="body2" sx={{ color: '#888', py: 3, textAlign: 'center' }}>
            Nothing found
          </Typography>
        )}
        {groups.map((g) => (
          <Box key={g.key} sx={{ mb: 1 }}>
            <Typography
              variant="caption"
              sx={{
                color: '#888', textTransform: 'uppercase', fontWeight: 700,
                letterSpacing: 0.5, display: 'block', mb: 0.5,
              }}
            >
              {g.title}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: `repeat(auto-fill, minmax(${cell + 8}px, 1fr))`,
                gap: 0.25,
              }}
            >
              {g.items.map((e) => (
                <Box
                  key={`${g.key}-${e.name}`}
                  component="button"
                  type="button"
                  onClick={() => { onPick(e); if (!keepOpen) onClose(); }}
                  onMouseEnter={() => setHover(e)}
                  sx={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 0.5,
                    borderRadius: 1,
                    '&:hover, &:focus-visible': { bgcolor: 'rgba(255,255,255,0.1)' },
                  }}
                >
                  <EmojiImg emoji={e} size={cell} />
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
      <Box sx={{
        px: 1.25, py: 0.75, display: 'flex', alignItems: 'center', gap: 1, minHeight: 40,
      }}
      >
        {hover ? (
          <>
            <EmojiImg emoji={hover} size={24} />
            <Typography
              variant="body2"
              sx={{
                color: '#ddd', fontFamily: 'monospace', overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {`:${hover.name}:`}
            </Typography>
          </>
        ) : (
          <Typography variant="caption" sx={{ color: '#777' }}>
            {`${total} emoji`}
          </Typography>
        )}
        {isModerator && (
          <Tooltip title="Manage the emoji pack">
            <IconButton
              size="small"
              component={RouterLink}
              to="/emoji-lab"
              onClick={onClose}
              sx={{ ml: 'auto', color: '#777', '&:hover': { color: '#ddd' } }}
            >
              <TuneIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
    </Popover>
  );
}
