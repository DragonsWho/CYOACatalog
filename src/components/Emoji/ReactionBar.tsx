// Reaction row under a message: pills with counts + "add". Input is the record's raw reactions
// field ({"fire": ["uid1","uid2"]}); counts and "mine" computed here — the map arrives with the
// message and updates via realtime with it.

import { useMemo, useRef, useState } from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import AddReactionOutlinedIcon from '@mui/icons-material/AddReactionOutlined';
import EmojiImg from './EmojiImg';
import EmojiPicker from './EmojiPicker';
import {
  EmojiDef, EMOJI_SIZE, ReactionMap, useEmojiPack,
} from './registry';

export type { ReactionMap };

interface Props {
  reactions: ReactionMap | null | undefined;
  meId?: string;
  onToggle: (name: string) => void;
  showAdd?: boolean;
  // Embedded inside another row (topic OP footer): no own top margin.
  inline?: boolean;
  // Picker contents: full pack by default; narrowed only by the /emoji-lab stand.
  available?: EmojiDef[];
  quick?: EmojiDef[];
}

export default function ReactionBar({
  reactions, meId, onToggle, showAdd = false, inline = false, available, quick,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const pack = useEmojiPack();
  // Pills render from the FULL pack even if the picker is narrowed: a hidden emoji someone already
  // used must not vanish with its count.
  const byName = pack.byName;

  const live = useMemo(() => Object.entries(reactions ?? {})
    // Order by name, not count: otherwise pills swap under the cursor when someone reacts.
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, uids]) => ({
      name,
      def: byName.get(name),
      count: Array.isArray(uids) ? uids.length : 0,
      mine: Boolean(meId) && Array.isArray(uids) && uids.includes(meId!),
    }))
    .filter((r) => r.count > 0 && r.def), [reactions, byName, meId]);

  if (live.length === 0 && !showAdd) return null;

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: inline ? 0 : 0.5 }}>
      {live.map((r) => (
        <Tooltip key={r.name} title={`:${r.name}:`} placement="top" enterDelay={400}>
          <Box
            component="button"
            type="button"
            onClick={() => onToggle(r.name)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 0.75,
              height: 24,
              borderRadius: 99,
              bgcolor: r.mine ? 'rgba(88,101,242,0.25)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${r.mine ? 'rgba(88,101,242,0.9)' : 'transparent'}`,
              transition: 'background-color .12s',
              '&:hover': { bgcolor: r.mine ? 'rgba(88,101,242,0.35)' : 'rgba(255,255,255,0.12)' },
            }}
          >
            <EmojiImg emoji={r.def!} size={EMOJI_SIZE.reaction} />
            <Typography
              variant="caption"
              sx={{ color: r.mine ? '#c9cdfb' : '#bbb', fontWeight: 600, lineHeight: 1 }}
            >
              {r.count}
            </Typography>
          </Box>
        </Tooltip>
      ))}

      {showAdd && (
        <Tooltip title="Add reaction" placement="top">
          <Box
            component="button"
            ref={addRef}
            type="button"
            onClick={() => setPickerOpen(true)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 24,
              borderRadius: 99,
              bgcolor: 'rgba(255,255,255,0.06)',
              color: '#aaa',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.12)', color: '#fff' },
            }}
          >
            <AddReactionOutlinedIcon sx={{ fontSize: 16 }} />
          </Box>
        </Tooltip>
      )}

      <EmojiPicker
        open={pickerOpen}
        anchorEl={addRef.current}
        onClose={() => setPickerOpen(false)}
        emoji={available ?? pack.all}
        quick={quick ?? pack.quick}
        onPick={(e) => onToggle(e.name)}
      />
    </Box>
  );
}
