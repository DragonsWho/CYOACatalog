// "Who's here" list: permanent right column on wide screens, swipe-in panel on phones
// (slide/gesture live in ChatView.tsx).
// Only registered, non-hidden users are listed: guest names are random and can't be messaged (DMs
// are accounts-only). Guests and hidden users are counted in a bottom line ("and N anonymous",
// "hidden").
// Blocked users used to be removed entirely (nothing to click, no way to unblock); now shown grey
// at the very bottom, clickable to the same profile card (unblock there, see BlockedUsersDialog).
// Render cost: same recipe as MessageRow — row styles precomputed once in styled components, row
// and panel memoized. Requires stable handlers (useCallback in parent) and `who` keeping identity
// while membership is unchanged (sameWho() in ChatView). The row calls onPick with its own id — an
// inline arrow would break memo.

import { memo } from 'react';
import { Avatar, Box, IconButton, Tooltip, Typography } from '@mui/material';
import TruncText from './TruncText';
import { styled } from '@mui/material/styles';
import type { CSSObject, SxProps, Theme } from '@mui/material/styles';
import theme from '../../theme';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import BlockIcon from '@mui/icons-material/Block';
import { ShoutWho, avatarUrlOf } from '../Shoutbox/shoutboxApi';
import { nickColor } from '../Shoutbox/anonIdentity';
import { MOD_NICK_COLOR, useChatAdmins } from './staff';
import { useChatNotes } from '../Shoutbox/chatNotes';

const css = (o: SxProps<Theme>): CSSObject => theme.unstable_sx(o) as CSSObject;

type Props = {
  who: ShoutWho[];
  online: number;
  guests: number;
  hidden: number;
  // Truncated by the list cap. Normally zero (cap is high, for crowds); if it triggers, say so, or
  // users can't find someone who's here.
  cut: number;
  // Who's in the OPEN topic/room. `undefined` = not asked (panel closed / no channel) → no section;
  // [] = asked, nobody.
  here?: ShoutWho[];
  hereMore?: number;
  hereLabel?: string;
  meId?: string;
  // Blocked users: their messages hidden, but they stay listed — moved to the end and greyed.
  blocked: Set<string>;
  onPick: (e: React.MouseEvent<HTMLElement>, id: string) => void;
  signedIn: boolean;
  // "Show me" toggle lives here: "can people see me?" arises exactly while looking at the list.
  visible: boolean;
  onToggleVisible: () => void;
};

const SECTION_SX = {
  px: { xs: 1, md: 1.5 },
  pt: 1.5,
  pb: 0.5,
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase' as const,
  color: 'text.disabled',
};

const RowBtn = styled('button')(css({
  display: 'flex',
  alignItems: 'center',
  gap: { xs: 0.75, md: 1 },
  width: '100%',
  pl: { xs: 0.75, md: 1.5 },
  pr: { xs: 0.5, md: 1 },
  py: 0.6,
  border: 0,
  bgcolor: 'transparent',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 500,
  textAlign: 'left',
  cursor: 'pointer',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
  '&[data-mod="1"]': { fontWeight: 700 },
}));
const RowAvatar = styled(Avatar)(css({ width: 22, height: 22, fontSize: 11, borderRadius: '30%' }));
const YouMark = styled('span')(css({ color: 'text.disabled', fontWeight: 400 }));
// Hundreds of avatars possible in a full room: lazy-load offscreen.
const AVATAR_IMG_PROPS = { loading: 'lazy' } as const;

const MemberRow = memo(function MemberRow(
  { w, me, alias, onPick, blocked, admin }: {
    w: ShoutWho; me: boolean; alias?: string; blocked?: boolean;
    // Site owner's name red, other moderators blue.
    admin?: boolean;
    onPick: (e: React.MouseEvent<HTMLElement>, id: string) => void;
  },
) {
  const name = alias || w.name;
  return (
    <RowBtn
      type="button"
      data-mod={w.mod ? '1' : undefined}
      style={{ color: blocked
        ? theme.palette.text.disabled
        : (w.mod
          ? (admin ? theme.palette.error.main : MOD_NICK_COLOR)
          : nickColor(w.id)) }}
      onClick={(e) => onPick(e, w.id)}
    >
      <RowAvatar
        src={avatarUrlOf(w)}
        imgProps={AVATAR_IMG_PROPS}
        sx={blocked ? { opacity: 0.5 } : undefined}
      >
        {(name || '?')[0]}
      </RowAvatar>
      <Box component="span" sx={{ flex: 1, minWidth: 0, display: 'flex', opacity: blocked ? 0.7 : 1 }}>
        <TruncText watch={name}>
          {name}
          {me && <YouMark> · you</YouMark>}
        </TruncText>
      </Box>
      {blocked && <BlockIcon sx={{ fontSize: 14, color: 'text.disabled', flexShrink: 0 }} />}
    </RowBtn>
  );
});

function MembersPanel({
  who, online, guests, hidden, cut, here, hereMore = 0, hereLabel = 'In this room',
  meId, blocked, onPick, signedIn, visible, onToggleVisible,
}: Props) {
  const { notes } = useChatNotes();
  const admins = useChatAdmins();
  // Blocked users are moved to the tail, grey, still clickable to the card (Unblock lives there).
  const shown = who.filter((w) => !blocked.has(w.id));
  const blockedShown = who.filter((w) => blocked.has(w.id));
  const shownCount = shown.length + blockedShown.length;
  // "And N more" = everyone not listed: guests, hidden, capped. Blocked no longer counted (shown
  // below). Never negative: the counter is time-smoothed and may diverge from the list for a
  // minute.
  const rest = Math.max(0, online - shownCount);
  // The server's breakdown uses a different slice than the smoothed counter, so fit it to `rest`.
  // Old binaries send no breakdown → all zero → plain "and N more". Allocation order: hidden and
  // capped first (real named people, must not be lost to rounding); guests take the remainder.
  const hid = Math.min(hidden, rest);
  const over = Math.min(cut, rest - hid);
  const anon = Math.min(guests, rest - hid - over);
  const parts: string[] = [];
  if (anon > 0) parts.push(`${anon} anonymous`);
  if (hid > 0) parts.push(`${hid} hidden`);
  // Capped users named separately, not "more": the wording must admit our cap, or the reader thinks
  // the person isn't here.
  if (over > 0) parts.push(`${over} not shown`);
  const tail = parts.length > 0 ? parts.join(', ') : `${rest} more`;
  // "Who's in this topic": blocked users not shown at all (the section answers "is it busy here").
  const hereShown = here?.filter((w) => !blocked.has(w.id)) ?? [];
  const hereRest = hereMore + (here ? here.length - hereShown.length : 0);

  return (
    <Box sx={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      bgcolor: 'rgba(18,18,18,0.98)',
    }}>
      {here && (
        <>
          <Box sx={SECTION_SX}>
            {hereLabel} — {hereShown.length + hereRest}
          </Box>
          {hereShown.map((w) => (
            <MemberRow
              key={`here-${w.id}`}
              w={w}
              me={w.id === meId}
              alias={notes[w.id]?.a}
              admin={admins.has(w.id)}
              onPick={onPick}
            />
          ))}
          {/* Empty topic stated explicitly: a silent section reads as broken. */}
          {hereShown.length === 0 && hereRest === 0 && (
            <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, py: 1, color: 'text.disabled' }}>
              Nobody here in the last half hour.
            </Typography>
          )}
          {hereRest > 0 && (
            <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, py: 1, color: 'text.disabled' }}>
              {hereShown.length > 0 ? `and ${hereRest} more` : `${hereRest} here without a name`}
            </Typography>
          )}
        </>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', pr: 0.5 }}>
        <Box sx={{ ...SECTION_SX, flex: 1 }}>Here now — {online}</Box>
        {signedIn && (
          <Tooltip title={visible ? 'You are shown in the list' : 'You are hidden — counted only'}>
            <IconButton size="small" onClick={onToggleVisible} sx={{ mt: 1 }}>
              {visible
                ? <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />
                : <VisibilityOffOutlinedIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {shown.map((w) => (
        <MemberRow
          key={w.id}
          w={w}
          me={w.id === meId}
          alias={notes[w.id]?.a}
          admin={admins.has(w.id)}
          onPick={onPick}
        />
      ))}

      {rest > 0 && (
        <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, py: 1, color: 'text.disabled' }}>
          {shown.length > 0 ? `and ${tail}` : `${tail} — nobody showing a name`}
        </Typography>
      )}

      {blockedShown.map((w) => (
        <MemberRow
          key={w.id}
          w={w}
          me={w.id === meId}
          alias={notes[w.id]?.a}
          admin={admins.has(w.id)}
          onPick={onPick}
          blocked
        />
      ))}

      {!signedIn && (
        <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, py: 1.5, mt: 'auto', color: 'text.disabled' }}>
          Sign in to write to someone directly.
        </Typography>
      )}
    </Box>
  );
}

// Panel re-renders only when ITS data changes (members, counter, blocks, own visibility flag).
export default memo(MembersPanel);
