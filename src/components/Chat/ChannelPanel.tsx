// Room list sliding in from the left (on phones replaces the pill strip). The slide, gesture and
// chat squeeze live in ChatView.tsx; this is content only.

import { useMemo } from 'react';
import { Avatar, Box, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import AddIcon from '@mui/icons-material/Add';
import {
  ShoutChannel, avatarUrlOf, channelLastAt, channelTitle, dmPeer, memberCard,
} from '../Shoutbox/shoutboxApi';
import { useChatNotes } from '../Shoutbox/chatNotes';
import { TAG_INFO, stripeTags } from './communityTags';
import type { CommunityRating } from './communityApi';
import TruncText from './TruncText';

type Props = {
  channels: ShoutChannel[];
  active?: string;
  meId?: string;
  mentions: string[];
  hasNew: (id: string) => boolean;
  hidden: (id: string) => boolean;
  onHide: (id: string) => void;
  onPins: (ids: string[]) => void;
  onPick: (slug: string) => void;
  signedIn: boolean;

  // User topics: all optional — the plain chat passes only channels without `community`, so the
  // section doesn't exist there; topic routes (/chat/threads, /chat/t/<slug>) pass the rest.
  communityOpen?: boolean;
  onToggleCommunity?: () => void;
  onExpandCommunity?: () => void;
  onCreateCommunity?: () => void;
  communityListActive?: boolean;
  // Site-header rating toggle (sfw/all/nsfw). Filters only TOPICS — never the author's rooms, or
  // #General would vanish in nsfw mode.
  rating?: CommunityRating;
};

// Tag color stripes left of topic names (identifiable even when the name is truncated). Not the
// only carrier: the row title has the words (color alone fails for colorblind/new users).
function TagStripes({ tags }: { tags?: string[] }) {
  const list = stripeTags(tags);
  return (
    <Box component="span" sx={{ display: 'flex', gap: '2px', flexShrink: 0 }}>
      {list.map((t) => (
        <Box
          key={t}
          component="span"
          sx={{
            width: 3,
            height: 13,
            borderRadius: '2px',
            bgcolor: TAG_INFO[t].color,
          }}
        />
      ))}
    </Box>
  );
}

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

// Row button is a SIBLING, not inside the row: button-in-button is invalid markup and the click
// went to the row anyway. Always visible on touch (no hover).
function RowBtn({ title, onClick, disabled, children }: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box
      component="button"
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        p: 0,
        border: 0,
        borderRadius: '6px',
        bgcolor: 'transparent',
        color: 'text.secondary',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.15 : { xs: 0.5, md: 0.28 },
        '&:hover': disabled ? {} : { bgcolor: 'rgba(255,255,255,0.09)', color: 'text.primary' },
      }}
    >
      {children}
    </Box>
  );
}

// The whole header toggles, not just the 12×12 arrow (untappable on phones).
function SectionHead({ label, open, active, onToggle, children }: {
  label: string;
  open: boolean;
  active?: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', pr: 0.75,
      borderLeft: 2,
      borderLeftColor: active ? 'primary.main' : 'transparent',
      bgcolor: active ? 'rgba(252,52,71,0.14)' : 'transparent',
    }}>
      <Box
        component="button"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        sx={{
          ...SECTION_SX,
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          border: 0,
          bgcolor: 'transparent',
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          '&:hover': { color: 'text.secondary' },
        }}
      >
        {open
          ? <ExpandMoreIcon sx={{ fontSize: 15, ml: -0.5 }} />
          : <ChevronRightIcon sx={{ fontSize: 15, ml: -0.5 }} />}
        {label}
      </Box>
      {children}
    </Box>
  );
}

export default function ChannelPanel({
  channels, active, meId, mentions, hasNew, hidden, onHide, onPins, onPick, signedIn,
  communityOpen = true, onToggleCommunity, onExpandCommunity, onCreateCommunity, communityListActive,
}: Props) {
  const { pins } = useChatNotes();

  // Public rooms in author order (`sort`), DMs/private by freshness — on purpose: public rooms are
  // a fixed map (muscle memory), DMs live by conversation. Pinned ones keep their manual order
  // regardless of freshness.
  const { rooms, community, dms, pinned } = useMemo(() => {
    const rank = new Map(pins.map((id, i) => [id, i]));
    const pub: ShoutChannel[] = [];
    const user: ShoutChannel[] = [];
    const priv: ShoutChannel[] = [];
    channels.forEach((c) => {
      // Hide a closed conversation unless it's the one open now (else the list loses the room
      // you're in). Never hide pinned.
      if (c.is_dm && c.slug !== active && !rank.has(c.id) && hidden(c.id)) return;
      if (c.community) {
        // The rating toggle now governs safe media display, not topic availability, so topics of
        // both ratings stay in all three positions.
        user.push(c);
        return;
      }
      (c.is_private ? priv : pub).push(c);
    });
    const top = priv.filter((c) => rank.has(c.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    const rest = priv.filter((c) => !rank.has(c.id))
      .sort((a, b) => channelLastAt(b.id) - channelLastAt(a.id));
    return { rooms: pub, community: user, dms: rest, pinned: top };
  }, [channels, active, hidden, pins]);

  // Send the whole order upward, built from the VISIBLE list: this also purges pins of
  // conversations that no longer exist, else they'd accumulate in the DB.
  const pinIds = () => pinned.map((c) => c.id);
  const togglePin = (id: string) => {
    const ids = pinIds();
    onPins(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  };
  const movePin = (idx: number, dir: -1 | 1) => {
    const ids = pinIds();
    const to = idx + dir;
    if (to < 0 || to >= ids.length) return;
    [ids[idx], ids[to]] = [ids[to], ids[idx]];
    onPins(ids);
  };

  const row = (c: ShoutChannel, pinIdx = -1) => {
    const isActive = c.slug === active;
    const mentioned = !isActive && mentions.includes(c.id);
    const fresh = !isActive && !mentioned && hasNew(c.id);
    const card = c.is_dm ? memberCard(dmPeer(c, meId)) : undefined;
    // Reserve exactly the right-side buttons' width so the name truncates BEFORE them. Pinned rows
    // get no close ✕ (can't close while pinned).
    const btns = !c.is_private ? 0 : pinIdx >= 0 ? 3 : 1 + (c.is_dm ? 1 : 0);

    const inner = (
      <Box
        component="button"
        type="button"
        onClick={() => onPick(c.slug)}
        title={c.community ? [channelTitle(c, meId), ...stripeTags(c.tags).map((t) => TAG_INFO[t].label)].join(' · ') : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: { xs: 0.5, md: 1 },
          width: '100%',
          pl: { xs: 0.75, md: 1.5 },
          pr: {
            xs: `${4 + 22 * btns + (btns ? 2 : 4)}px`,
            md: `${8 + 22 * btns + (btns ? 4 : 8)}px`,
          },
          py: 0.85,
          border: 0,
          borderLeft: 2,
          // The left stripe means only "this room is open". Mentions use the "@" icon — painting
          // the edge too would show one event twice, next to red tag stripes.
          borderLeftColor: isActive ? 'primary.main' : 'transparent',
          bgcolor: isActive ? 'rgba(252,52,71,0.14)' : 'transparent',
          color: isActive || fresh || mentioned ? 'text.primary' : 'text.secondary',
          fontFamily: 'inherit',
          fontSize: 14,
          fontWeight: isActive || fresh || mentioned ? 600 : 400,
          textAlign: 'left',
          cursor: 'pointer',
          '&:hover': { bgcolor: isActive ? 'rgba(252,52,71,0.18)' : 'rgba(255,255,255,0.05)' },
        }}
      >
        {card ? (
          // Rounded square, not circle: matches avatars in the chat itself.
          <Avatar variant="rounded" src={avatarUrlOf(card)} sx={{ width: 22, height: 22, fontSize: 11, borderRadius: '30%', flexShrink: 0 }}>
            {(card.name || '?')[0]}
          </Avatar>
        ) : c.community ? (
          <Box component="span" sx={{ width: { xs: 12, md: 18 }, flexShrink: 0, display: 'flex' }}>
            <TagStripes tags={c.tags} />
          </Box>
        ) : (
          <Box component="span" sx={{ width: { xs: 12, md: 18 }, flexShrink: 0, textAlign: 'center', fontSize: 13, opacity: 0.55 }}>
            {c.is_private ? '🔒' : '#'}
          </Box>
        )}

        <TruncText watch={channelTitle(c, meId)}>{channelTitle(c, meId)}</TruncText>

        {(mentioned || fresh) && (
          <Box sx={{
            flexShrink: 0,
            width: mentioned ? 'auto' : 7,
            height: mentioned ? 'auto' : 7,
            px: mentioned ? 0.5 : 0,
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '15px',
            bgcolor: mentioned ? 'error.main' : 'primary.main',
            color: mentioned ? '#fff' : 'transparent',
          }}>
            {mentioned ? '@' : ''}
          </Box>
        )}
      </Box>
    );

    if (btns === 0) return <Box key={c.id}>{inner}</Box>;

    const title = channelTitle(c, meId);
    return (
      <Box key={c.id} sx={{
        position: 'relative',
        '&:hover .row-btns button:not(:disabled)': { opacity: 0.9 },
      }}>
        {inner}
        <Box className="row-btns" sx={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
        }}>
          {/*
            Pinned order via arrows, not drag: chat opens by swipe and scrolls by finger; drag
            would fight both.
          */}
          {pinIdx >= 0 && (
            <>
              <RowBtn
                title={`Move ${title} up`}
                disabled={pinIdx === 0}
                onClick={() => movePin(pinIdx, -1)}
              >
                <KeyboardArrowUpIcon sx={{ fontSize: 16 }} />
              </RowBtn>
              <RowBtn
                title={`Move ${title} down`}
                disabled={pinIdx === pinned.length - 1}
                onClick={() => movePin(pinIdx, 1)}
              >
                <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
              </RowBtn>
            </>
          )}
          <RowBtn
            title={pinIdx >= 0 ? `Unpin ${title}` : `Pin ${title} to top`}
            onClick={() => togglePin(c.id)}
          >
            {pinIdx >= 0
              ? <PushPinIcon sx={{ fontSize: 14 }} />
              : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
          </RowBtn>
          {c.is_dm && pinIdx < 0 && (
            <RowBtn title={`Close conversation ${title}`} onClick={() => onHide(c.id)}>
              <CloseIcon sx={{ fontSize: 15 }} />
            </RowBtn>
          )}
        </Box>
      </Box>
    );
  };

  return (
    <Box sx={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      bgcolor: 'rgba(18,18,18,0.98)',
      borderRight: 1,
      borderColor: 'divider',
    }}>
      {/* Pinned above everything, including public rooms: the user put them there. */}
      {pinned.length > 0 && <Box sx={SECTION_SX}>Pinned</Box>}
      {pinned.map((c, i) => row(c, i))}

      <Box sx={SECTION_SX}>Rooms</Box>
      {rooms.map((c) => row(c))}

      {/*
        Topics between author rooms and DMs. Shown only if the screen can expand it (plain chat
        lacks these props).
      */}
      {onExpandCommunity && (
        <>
          <SectionHead
            label="Threads"
            open={communityOpen}
            active={communityListActive}
            onToggle={() => onToggleCommunity?.()}
          >
            {onCreateCommunity && (
              <RowBtn title="New thread" onClick={onCreateCommunity}>
                <AddIcon sx={{ fontSize: 16 }} />
              </RowBtn>
            )}
            <RowBtn title="Show all threads" onClick={onExpandCommunity}>
              <OpenInFullIcon sx={{ fontSize: 13 }} />
            </RowBtn>
          </SectionHead>
          {/* A collapsed section still shows the topic you're in, else it can't be closed. */}
          {(communityOpen ? community : community.filter((c) => c.slug === active)).map((c) => row(c))}
          {communityOpen && community.length === 0 && (
            <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, pb: 1, color: 'text.disabled' }}>
              No threads yet.
            </Typography>
          )}
        </>
      )}

      {dms.length > 0 && <Box sx={SECTION_SX}>Direct</Box>}
      {dms.map((c) => row(c))}

      {!signedIn && (
        <Typography variant="caption" sx={{ px: { xs: 1, md: 1.5 }, py: 1.5, mt: 'auto', color: 'text.disabled' }}>
          Sign in to send a direct message.
        </Typography>
      )}
    </Box>
  );
}
