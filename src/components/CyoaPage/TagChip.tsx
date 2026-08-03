// src/components/CyoaPage/TagChip.tsx

import { useState } from 'react';
import { Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { keyframes } from '@mui/system';
import { Tag, GameTagVote } from '../../pocketbase/pocketbase';
import { requestSearchTag } from '../../utils/searchTagBus';
import {
  isProposedVotes,
  proposedMiniScore,
  acceptedBar,
  proposedBar,
} from './tagBar';

const CHIP_HEIGHT = '26px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';

// Personal-vote accent: a colored border, shown only in edit mode.
const BORDER_UP = '#67ad5b';
const BORDER_DOWN = '#c8453a';

// Accepted-tag community fill (soft by default, stronger once you've voted).
const ACC_UP_SOFT = 'rgba(103,173,91,0.30)';
const ACC_UP_STRONG = 'rgba(103,173,91,0.55)';
const ACC_DOWN_SOFT = 'rgba(200,69,58,0.30)';
const ACC_DOWN_STRONG = 'rgba(200,69,58,0.55)';

// Delete-ballot fill (accepted tag past the fade point, score <= -5). Deep,
// solid red + black diagonal stripes so the second "vote to fully remove" reads
// as distinct from — and more serious than — the soft fade fill above.
const DEL_FILL_RED = 'rgba(150,28,22,0.85)';

// Proposed-tag look: striped purple chip + dark green/red striped progress bar.
// The fill underlay is hsl(106|4, 50%, 35%) at 75% opacity (the tuned "Подложка").
const PROP_FILL_GREEN = 'rgba(65,134,45,0.75)';
const PROP_FILL_RED = 'rgba(134,51,45,0.75)';
const PROP_BAR_STRIPES =
  'repeating-linear-gradient(45deg, rgba(0,0,0,0.25) 0, rgba(0,0,0,0.25) 6px, transparent 6px, transparent 12px)';
const PROP_BG_STRIPES =
  'repeating-linear-gradient(45deg, hsla(271,80%,65%,0.30) 0, hsla(271,80%,65%,0.30) 6px, rgba(168,85,247,0.15) 6px, rgba(168,85,247,0.15) 12px)';
const PROP_OUTLINE = '#a855f7';
const PROP_TEXT = '#e9eefb';

// Gold (defining) tag.
const GOLD_TEXT = '#ffec85';
const GOLD_BG = '#4a4a44';

const popKf = keyframes`
  0% { transform: scale(1); }
  50% { transform: scale(1.03); }
  100% { transform: scale(1); }
`;

interface TagChipProps {
  tag: Tag;
  vote?: GameTagVote;
  isUpdating?: boolean;
  editing?: boolean;
  isGold?: boolean;
  user: any; // Тип для пользователя
  onClick: () => void;
}

export default function TagChip({ tag, vote, isUpdating, editing = false, isGold = false, user, onClick }: TagChipProps) {
  const theme = useTheme();
  const [popping, setPopping] = useState(false);

  const votes = vote?.votes ?? 0;
  const proposed = isProposedVotes(votes);
  const isUserUp = user ? !!vote?.upVoters?.includes(user.id || '') : false;
  const isUserDown = user ? !!vote?.downVoters?.includes(user.id || '') : false;
  const involved = isUserUp || isUserDown;

  // Bar geometry (pure, see tagBar.ts). Proposed tags run a small -5..+5 ballot;
  // accepted tags use a two-phase negative scale — a "fade" ballot (0→-5) then a
  // fresh "delete" ballot (-5→-15) — so the removal vote shows real progress
  // instead of a bar pegged full. `score` remains the display value for below.
  const score = proposed ? proposedMiniScore(votes) : votes;
  const bar = proposed ? proposedBar(score) : acceptedBar(score);
  const dir = bar.dir;
  const w = bar.w;

  const faded = !proposed && !isGold && bar.phase === 'delete';

  // ── Fill (community gauge), shown only in edit mode ──────────────────
  let fillColor = 'transparent';
  let fillImage = 'none';
  if (proposed) {
    fillColor = dir === 'pos' ? PROP_FILL_GREEN : PROP_FILL_RED;
    fillImage = PROP_BAR_STRIPES;
  } else if (dir === 'pos') {
    fillColor = involved ? ACC_UP_STRONG : ACC_UP_SOFT;
  } else if (bar.phase === 'delete') {
    // Second, serious ballot toward full removal — distinct striped deep red.
    fillColor = DEL_FILL_RED;
    fillImage = PROP_BAR_STRIPES;
  } else if (dir === 'neg') {
    fillColor = involved ? ACC_DOWN_STRONG : ACC_DOWN_SOFT;
  }

  // Bars are always full-width and masked with clip-path, so changing the value
  // re-clips in place instead of resizing — no sliding/jumping on click.
  const clip =
    dir === 'pos'
      ? `inset(0 calc(100% - ${w}%) 0 0)`
      : `inset(0 0 0 calc(100% - ${w}%))`;
  const fillVisible = editing && !!dir;

  // ── Chip styling ─────────────────────────────────────────────────────
  const styles: any = {
    position: 'relative',
    overflow: 'hidden',
    height: CHIP_HEIGHT,
    borderRadius: CHIP_BORDER_RADIUS,
    border: '1.5px solid transparent',
    backgroundColor: theme.palette.grey[800],
    color: theme.palette.text.primary,
    // Resting (non-edit) chips are filter shortcuts: a click opens the header search
    // with this tag (parity with the compact mobile view). Edit mode keeps voting.
    cursor: editing ? (user ? 'pointer' : 'default') : 'pointer',
    opacity: isUpdating ? 0.7 : 1,
    transition: 'background .15s, border-color .2s, color .2s, transform .14s ease, opacity .25s',
  };

  if (proposed) {
    // Striped purple chip with a dashed purple outline.
    styles.backgroundColor = 'transparent';
    styles.backgroundImage = PROP_BG_STRIPES;
    styles.outline = `1.5px dashed ${PROP_OUTLINE}`;
    styles.outlineOffset = '1px';
    styles.color = PROP_TEXT;
  } else if (isGold) {
    styles.backgroundColor = GOLD_BG;
    styles.color = GOLD_TEXT;
    styles.fontWeight = 'bold';
    styles.letterSpacing = '0.02em';
  } else if (faded) {
    styles.opacity = isUpdating ? 0.7 : 0.55;
    styles.color = theme.palette.text.secondary;
  }

  // Your vote = a colored border, only while editing (resting chips stay clean).
  if (editing) {
    if (isUserUp) styles.borderColor = BORDER_UP;
    else if (isUserDown) styles.borderColor = BORDER_DOWN;
  }

  if (popping) {
    styles.animation = `${popKf} .18s ease-out`;
  }

  styles['&::before'] = {
    content: '""',
    position: 'absolute',
    inset: 0,
    zIndex: 0,
    backgroundColor: fillColor,
    backgroundImage: fillImage,
    clipPath: fillVisible ? clip : 'inset(0 100% 0 0)',
    opacity: fillVisible ? 1 : 0,
    transition: 'clip-path .24s ease, opacity .2s',
  };

  styles['& .MuiChip-label'] = {
    position: 'relative',
    zIndex: 1,
    fontSize: CHIP_FONT_SIZE,
    padding: CHIP_PADDING,
  };

  styles['&:hover'] = {
    backgroundColor:
      (editing && user && !proposed && !isGold) || (!editing && !proposed && !isGold)
        ? theme.palette.grey[700]
        : undefined,
  };

  const handleClick = () => {
    if (!user || !editing || isUpdating) return;
    setPopping(true);
    window.setTimeout(() => setPopping(false), 200);
    onClick();
  };

  // Resting click → search by this tag (edit mode votes instead, above).
  const handleSearchClick = () => {
    if (isUpdating) return;
    requestSearchTag(tag.name);
  };

  return (
    <Chip
      label={tag.name}
      size="small"
      onClick={editing ? (user ? handleClick : undefined) : handleSearchClick}
      sx={styles}
      disabled={isUpdating}
    />
  );
}
