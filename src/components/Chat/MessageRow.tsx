// One chat v2 feed row, extracted from ChatView and wrapped in React.memo. Rows are expensive
// (avatar, rich text with mentions, tooltip, up to six buttons, MUI style computation). Inline in
// ChatView, any screen state (keystroke, presence ping, hover) re-rendered the WHOLE history — the
// "one second per letter". Handlers must arrive stable (useCallback in parent) or memo is useless.

import { Fragment, memo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Box, IconButton, Stack, Typography } from '@mui/material';
import { styled } from '@mui/material/styles';
import type { CSSObject, SxProps, Theme } from '@mui/material/styles';
import theme from '../../theme';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DeleteForeverOutlinedIcon from '@mui/icons-material/DeleteForeverOutlined';
import VolumeOffOutlinedIcon from '@mui/icons-material/VolumeOffOutlined';
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import ReplyOutlinedIcon from '@mui/icons-material/ReplyOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import { chatTime, clockTime } from '../CyoaPage/Comments/relativeTime';
import { anonIdentity, nickColor } from '../Shoutbox/anonIdentity';
import { MOD_NICK_COLOR } from './staff';
import { renderRichText, emojiOnlyCount } from '../Shoutbox/richText';
import ReactionBar from '../Emoji/ReactionBar';
import EmojiPicker from '../Emoji/EmojiPicker';
import { EMOJI_SIZE, emojiVersion, useEmojiPack } from '../Emoji/registry';
import AddReactionOutlinedIcon from '@mui/icons-material/AddReactionOutlined';
import { ShoutMessage, avatarUrlOf, localImageUrl, messageImageSize, messageImageUrl } from '../Shoutbox/shoutboxApi';
import { useChatPrefs } from './chatPrefs';
import { useChatNotes } from '../Shoutbox/chatNotes';

// Styles: hot parts use styled components, not `sx`. `sx` is per-render work (MUI parses
// spacing/breakpoints/tokens, serializes, emotion cache lookup) — ~15 objects per row × ~50 rows
// per frame. styled does it once at module load; also removes Box/Stack/Typography wrappers. sx
// syntax is run through `theme.unstable_sx` at module creation to keep shorthand. Theme is imported
// (the site has one); if a second (light) theme appears these styles won't follow it and must
// become theme functions again.
// Discrete states (pinned, grouped, buttons shown) are data-attributes + selectors inside ONE
// class, not different components: changing component type would remount the row subtree (e.g. on
// every pin). Rare plaques (day divider, system message, NEW divider) stay on `sx`.
const css = (o: SxProps<Theme>): CSSObject => theme.unstable_sx(o);

const DAY_DIVIDER_SX: SxProps<Theme> = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  my: 1.25,
  px: 0.5,
};
const DAY_RULE_SX: SxProps<Theme> = { flex: 1, height: '1px', bgcolor: 'divider' };
const DAY_LABEL_SX: SxProps<Theme> = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  color: 'text.secondary',
  px: 1,
  py: 0.25,
  borderRadius: 999,
  border: 1,
  borderColor: 'divider',
};

const SYS_ICON_SX: SxProps<Theme> = { fontSize: 14, opacity: 0.7 };
const SYS_BOX_SX: SxProps<Theme> = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 0.75,
  px: { xs: 0.5, md: 1.25 },
  py: 0.5,
  my: 0.25,
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.035)',
};
const SYS_TEXT_SX: SxProps<Theme> = { color: 'text.secondary', lineHeight: 1.5 };
const SYS_LINK_SX: SxProps<Theme> = {
  color: 'primary.light',
  textDecoration: 'none',
  '&:hover': { textDecoration: 'underline' },
};
const SYS_AUTHOR_SX: SxProps<Theme> = { opacity: 0.6 };
const SYS_CLOCK_SX: SxProps<Theme> = { opacity: 0.45, ml: 0.75 };

// Action buttons: hover on mouse (class `hov`), tap on touch (data-on). Can't be permanent: on
// narrow screens they cover half the text.
const Actions = styled('div')(
  css({
    display: 'flex',
    position: 'absolute',
    // Toolbar straddles the row's top border; offset matched to its height — if buttons grow,
    // update it or the bar covers the first line.
    top: -12,
    '@media (pointer: coarse)': { top: -15 },
    right: 6,
    zIndex: 1,
    opacity: 0,
    transition: 'opacity .15s',
    bgcolor: 'background.paper',
    border: 1,
    borderColor: 'divider',
    borderRadius: 2,
    px: 0.25,
    boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
    '&[data-on="1"]': { opacity: 1 },
  }),
);

// Icon size set here, not per button. 14 px icon + 2 px padding = 18 px target: fine for mouse, not
// for fingers (six adjacent; mis-hitting "delete" instead of "reply" is costly). Grown by ~a third.
const ActBtn = styled(IconButton)(
  css({
    p: 0.375,
    '& .MuiSvgIcon-root': { fontSize: 18 },
    // On touch only padding grows: same look, larger hit area and more distance between centers.
    '@media (pointer: coarse)': { p: 0.75 },
    '&[data-tone="danger"]': { color: 'error.main' },
    '&[data-tone="pin"]': { color: 'warning.main' },
  }),
);

// NEW divider label is CENTERED: it splits the feed by time; a label at the edge read as a tag of
// the adjacent message.
const NEW_ROW_SX: SxProps<Theme> = { my: 0.5, px: { xs: 0.5, md: 1.25 } };
const NEW_RULE_SX: SxProps<Theme> = { flex: 1, height: '1px', bgcolor: 'error.main', opacity: 0.5 };
const NEW_LABEL_SX: SxProps<Theme> = {
  flexShrink: 0,
  color: 'error.main',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
};

const Row = styled('div')(
  css({
    position: 'relative',
    // Two layouts on one markup via grid, not two trees:
    // phone: [av][name] / [ text ]    desktop: [av][name] / [av][text]
    // On phones the avatar column ate 42 px on EVERY row (an eighth of the feed, also shrinking
    // images); there the avatar goes into the name line and the body spans full width.
    display: 'grid',
    gridTemplateColumns: { xs: 'auto minmax(0,1fr)', md: '32px minmax(0,1fr)' },
    gridTemplateAreas: {
      xs: '"av head" "body body"',
      md: '"av head" "av body"',
    },
    px: { xs: 0.5, md: 1.25 },
    columnGap: { xs: 0.75, md: 1.25 },
    py: { xs: 0.35, md: 0.85 },
    borderRadius: 2,
    '&:hover .hov': { opacity: 1 },
    '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' },
    '&[data-g="1"]': { py: 0.2 },
    // Top margin > bottom on phones: the avatar protrudes upward. Not for grouped rows (no plaque)
    // or desktop (avatar at the side).
    '&:not([data-g="1"])': { pt: { xs: 2, md: 0.85 } },
    // Pinned-row hover = deeper amber. The generic grey :hover outweighs the base background by
    // specificity, so pin highlight vanished exactly when looked at. Pinned hover rule is heavier
    // (class + attr + :hover); pinned base background is placed BELOW the generic :hover in source
    // (equal weight, order decides).
    '&[data-p="1"]': {
      bgcolor: 'rgba(255,193,7,0.06)',
      // Left stripe so pins read on phones in sunlight.
      boxShadow: 'inset 2px 0 0 #ffc107',
      '&:hover': { bgcolor: 'rgba(255,193,7,0.11)' },
    },
  }),
);

// Grouped-row time lives in two places: desktop in the avatar column; phones in the bottom-right
// corner (the hover toolbar briefly covers it — 32 px width on every row costs more than perfect
// hover).
const Gutter = styled('div')(
  css({
    gridArea: 'av',
    alignSelf: 'start',
    display: { xs: 'none', md: 'block' },
    width: 32,
    flexShrink: 0,
    textAlign: 'right',
    // Time must NOT wrap: "7:05 PM" in a 32 px column broke into two lines and doubled grouped-row
    // height (the gap between one person's messages). It's transparent until hover anyway.
    whiteSpace: 'nowrap',
    lineHeight: '21px',
  }),
);
const GutterClock = styled('span')(
  css({
    ...theme.typography.caption,
    opacity: 0,
    transition: 'opacity .15s',
    fontSize: 9,
    color: 'text.secondary',
  }),
);
const GroupClock = styled('span')(
  css({
    ...theme.typography.caption,
    display: { xs: 'block', md: 'none' },
    position: 'absolute',
    right: 8,
    bottom: 2,
    opacity: 0,
    transition: 'opacity .15s',
    fontSize: 9,
    color: 'text.secondary',
    pointerEvents: 'none',
    '&[data-on="1"]': { opacity: 0.6 },
  }),
);
const Av = styled(Avatar)(
  css({
    gridArea: 'av',
    alignSelf: 'start',
    width: 32,
    height: 32,
    fontSize: 14,
    // Phones: negative top margin only — avatar adds 20 of its 32 px to the name line and protrudes
    // 12 px up into the gap. Bottom aligns with the name line so it doesn't touch the text.
    mt: { xs: '-12px', md: '1px' },
    borderRadius: '30%',
  }),
);
const AVATAR_IMG_PROPS = { loading: 'lazy' } as const;
const Body = styled('div')(css({ gridArea: 'body', minWidth: 0 }));
const Head = styled('div')(
  css({
    gridArea: 'head',
    display: 'flex',
    gap: 0.75,
    flexWrap: 'wrap',
    alignItems: { xs: 'center', md: 'baseline' },
    mb: { xs: '4px', md: '2px' },
  }),
);
// Name color: red = site owner, blue = moderator (neither is in the name palette, so they can't be
// confused). Others by stable key (anon by anon_key, users by id), passed as inline style. Color =
// recognition, not rank.
const Nick = styled('span')(
  css({
    ...theme.typography.caption,
    fontSize: 14,
    fontWeight: 700,
    color: 'text.primary',
    cursor: 'default',
    '&[data-u="1"]': { cursor: 'pointer', '&:hover': { textDecoration: 'underline' } },
    // Who is owner vs moderator comes from the server list (staff.ts); the row doesn't know.
    '&[data-role="admin"]': { color: 'error.main' },
    '&[data-role="mod"]': { color: MOD_NICK_COLOR },
  }),
);
const Clock = styled('span')(
  css({
    ...theme.typography.caption,
    fontSize: 11,
    opacity: 0.75,
    color: 'text.secondary',
  }),
);
const PinMark = styled(PushPinOutlinedIcon)(
  css({
    fontSize: 12,
    color: 'warning.main',
    alignSelf: 'center',
  }),
);
// The quote is a link back to the replied message: a <button>, styles start with a button reset.
const Quote = styled('button')(
  css({
    border: 0,
    borderLeft: '2px solid',
    borderLeftColor: 'primary.main',
    pl: 1,
    pr: 0.75,
    py: 0.25,
    mb: 0.35,
    width: '100%',
    textAlign: 'left',
    borderRadius: '0 6px 6px 0',
    bgcolor: 'rgba(255,255,255,0.035)',
    color: 'text.secondary',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.35,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    cursor: 'pointer',
    '&:hover': { bgcolor: 'rgba(255,255,255,0.09)' },
  }),
);
const Text = styled('div')(
  css({
    ...theme.typography.body2,
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
    fontSize: '0.9rem',
    lineHeight: 1.5,
  }),
);
const Edited = styled('span')(css({ ml: 0.5, fontSize: 10, color: 'text.secondary' }));
const ImgLink = styled('a')(
  css({
    display: 'inline-block',
    mt: 0.5,
    maxWidth: { xs: 220, sm: 260 },
    cursor: 'zoom-in',
  }),
);
const Img = styled('img')(
  css({
    maxWidth: { xs: 220, sm: 260 },
    maxHeight: 260,
    borderRadius: 2,
    display: 'block',
    border: 1,
    borderColor: 'divider',
  }),
);
// Size is set by the outer frame (imgBox), not the image. object-fit is insurance in case the size
// in the filename lies (hand-named "800x600.jpg").
const ImgFill = styled('img')(
  css({
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    boxSizing: 'border-box',
    borderRadius: 2,
    display: 'block',
    border: 1,
    borderColor: 'divider',
  }),
);
// Hidden-image placeholder occupies exactly the image's space: revealing must not shift the feed
// more than normal loading.
const Veil = styled('button')(
  css({
    width: '100%',
    height: '100%',
    minWidth: 120,
    minHeight: 44,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.5,
    borderRadius: 2,
    border: 1,
    borderStyle: 'dashed',
    borderColor: 'divider',
    bgcolor: 'rgba(255,255,255,0.03)',
    color: 'text.secondary',
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    p: 0.5,
    '&:hover': { bgcolor: 'rgba(255,255,255,0.07)', color: 'text.primary' },
  }),
);

// Manually revealed images in a module-level set, not row state: rows remount on memory-window
// reshuffles and a revealed image would snap back. Lives until tab reload.
const revealed = new Set<string>();

// Rich-text parse cache: parsing (mentions, links) is the most expensive part after styles, and the
// same text renders many times (remounts on window reshuffle, room return from cache, history
// loads). Nodes are immutable and safely shared. Key = id + text (edits change text under the same
// id). "Me" highlight and @name click handler are screen-wide; on their change (login, logout, room
// switch) the cache is dropped.
const RICH_MAX = 800;
const richCache = new Map<string, React.ReactNode>();
let richOwner: unknown;
let richMe: string | undefined;

function richText(m: ShoutMessage, onMention: (u: string) => void, me?: string) {
  if (richOwner !== onMention || richMe !== me) {
    richCache.clear();
    richOwner = onMention;
    richMe = me;
  }
  // The emoji pack arrives after first render and shortcodes were parsed as text; the pack version
  // in the key discards those parses only.
  const jumbo = emojiOnlyCount(m.text);
  const key = `${m.id} ${m.text} ${emojiVersion()} ${jumbo}`;
  const hit = richCache.get(key);
  if (hit !== undefined) return hit;
  const node = renderRichText(m.text, {
    onMention,
    me,
    emojiSize: jumbo ? EMOJI_SIZE.jumbo : EMOJI_SIZE.inline,
  });
  // The feed window is 500 rows; only very long sessions reach the cap — cheaper to start over than
  // track entry age.
  if (richCache.size >= RICH_MAX) richCache.clear();
  richCache.set(key, node);
  return node;
}

// Reaction button with picker as its own component: the picker holds state, and MessageRow has no
// hooks at all (early return for system messages would require hooks above it). Also the pack
// subscription lives here.
function ReactBtn({ onPick }: { onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const pack = useEmojiPack();

  // Pack not loaded — no button (an empty picker is worse than none).
  if (!pack.ready || pack.all.length === 0) return null;

  return (
    <>
      <ActBtn
        size="small"
        ref={ref}
        title="Add reaction"
        // A tap on the row on phones shows buttons; opening the picker must not also count as "row
        // touched".
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <AddReactionOutlinedIcon />
      </ActBtn>
      <EmojiPicker
        open={open}
        anchorEl={ref.current}
        onClose={() => setOpen(false)}
        emoji={pack.all}
        quick={pack.quick}
        onPick={(e) => onPick(e.name)}
      />
    </>
  );
}

// Day divider lets every row show bare time ("8:24 PM"); a full date on each row reads as a log.
function DayDivider({ label }: { label: string }) {
  return (
    <Box sx={DAY_DIVIDER_SX}>
      <Box sx={DAY_RULE_SX} />
      <Typography variant="caption" sx={DAY_LABEL_SX}>
        {label}
      </Typography>
      <Box sx={DAY_RULE_SX} />
    </Box>
  );
}

// System messages (new games, announcements) are a separate plaque, NOT an authored row: no user or
// anon_key, so the generic branch rendered them as nameless "Anonymous". v1 had the styling; the v2
// rewrite forgot it — replicated one-to-one.
function SystemLine({ m }: { m: ShoutMessage }) {
  const ev = m.event;
  let icon = <CampaignOutlinedIcon sx={SYS_ICON_SX} />;
  let body: React.ReactNode = m.text;
  if (ev?.type === 'new_game' && ev.games?.length) {
    icon = <CasinoOutlinedIcon sx={SYS_ICON_SX} />;
    body = (
      <>
        {ev.games.length === 1 ? 'New game: ' : `${ev.games.length} new games: `}
        {ev.games.map((g, i) => (
          <Fragment key={g.id}>
            {i > 0 && ', '}
            <Box component={Link} to={`/game/${g.id}`} sx={SYS_LINK_SX}>
              {g.title}
            </Box>
            {ev.games.length === 1 && g.author !== 'unknown' && (
              <Box component="span" sx={SYS_AUTHOR_SX}>
                {' '}
                by {g.author}
              </Box>
            )}
          </Fragment>
        ))}
      </>
    );
  }
  return (
    <Box data-mid={m.id} sx={SYS_BOX_SX}>
      {icon}
      <Typography variant="caption" sx={SYS_TEXT_SX}>
        {body}
        {/*
          Bare time like normal rows; full date via native `title`: MUI Tooltip is a full component
          (portal, hooks, listeners) on EVERY row for the same result.
        */}
        <Box component="span" title={chatTime(m.created)} sx={SYS_CLOCK_SX}>
          {clockTime(m.created)}
        </Box>
      </Typography>
    </Box>
  );
}

export type MessageRowProps = {
  m: ShoutMessage;
  daySepLabel?: string;
  unread: boolean;
  // Replying to someone the reader blocked: the feed hid the message but its text would remain
  // visible in the quote — block bypassed by one "reply" click.
  quoteHidden?: boolean;
  grouped: boolean;
  touched: boolean;
  isModerator: boolean;
  // Staff set comes from the feed ready (useChatAdmins) so rows don't each ask.
  admins: ReadonlySet<string>;
  canEdit: boolean;
  canDelete: boolean;
  meUsername?: string;
  // Reader id for highlighting own reactions. Empty = guest/anon: reactions view-only.
  meId?: string;
  // Emoji pack version: unused in the body (richText() reads it), but without it memo would skip
  // the row when the pack arrived after the feed rendered, leaving shortcodes as text. Also bumps
  // when the pack is edited in the panel (lives in DB, changes on live chat).
  emojiVer: number;
  onTouch: (m: ShoutMessage) => void;
  onReply: (m: ShoutMessage) => void;
  onEdit: (m: ShoutMessage) => void;
  onDeleteOwn: (m: ShoutMessage) => void;
  onTogglePin: (m: ShoutMessage) => void;
  onModDelete: (m: ShoutMessage) => void;
  onModMute: (m: ShoutMessage) => void;
  // Unmute is a separate action: mute state lives in server memory and isn't exposed, so it can't
  // be a toggle.
  onModUnmute: (m: ShoutMessage) => void;
  onOpenProfile: (e: React.MouseEvent<HTMLElement>, m: ShoutMessage) => void;
  onMention: (username: string) => void;
  onJumpTo: (id: string) => void;
  // Image loaded and pushed the feed; the parent gets the image element to know whether it grew
  // above or below the viewport.
  onImgLoad: (img: HTMLImageElement) => void;
  // Link to the file under the preview stays: middle-click / open in new tab work as before.
  onOpenImage: (m: ShoutMessage) => void;
  onReact?: (m: ShoutMessage, emoji: string) => void;
  // In SFW mode adult-topic images are blurred until click.
  blurImages?: boolean;
};

function MessageRow({
  m,
  daySepLabel,
  unread,
  quoteHidden,
  grouped,
  touched,
  isModerator,
  admins,
  canEdit,
  canDelete,
  meUsername,
  meId,
  onTouch,
  onReply,
  onEdit,
  onDeleteOwn,
  onTogglePin,
  onModDelete,
  onModMute,
  onModUnmute,
  onOpenProfile,
  onMention,
  onJumpTo,
  onImgLoad,
  onOpenImage,
  onReact,
  blurImages = false,
}: MessageRowProps) {
  // Hooks come first: there's an early return for the system plaque below, and hook order must be
  // identical for every message kind.
  const { hideImages } = useChatPrefs();
  // Reader-assigned names map is one per feed — taken from the store, not a prop. Changes monthly;
  // no extra renders.
  const { notes } = useChatNotes();
  const [shown, setShown] = useState(() => revealed.has(m.id));

  // Day change computed first so the divider also precedes system plaques.
  const daySep = daySepLabel ? <DayDivider label={daySepLabel} /> : null;
  if (m.kind === 'system') {
    return (
      <Fragment>
        {daySep}
        <SystemLine m={m} />
      </Fragment>
    );
  }
  const u = m.expand?.user;
  // Draw an anonymous persona ONLY for real anons (anon_key present). If the message has a user but
  // expand didn't arrive (users read rules, trimmed response), inventing "Anon Bat" would put a
  // real person under a fake alias while their next message shows the real name.
  const anonId = !u && m.anon_key ? anonIdentity(m.anon_key, m.anon_mask) : null;
  // Some accounts have empty `name` (OAuth, old records) → fall back to username; otherwise they
  // appeared as "…" (seen as "nick doesn't fit"). Reader-assigned name beats the real one. Not for
  // anons: each message has its own persona.
  const displayName = u ? notes[u.id]?.a || u.name || u.username || 'User' : (anonId?.name ?? 'Anonymous');
  // Own just-sent image renders from tab memory; others from server thumbnails.
  const img = localImageUrl(m.id) || messageImageUrl(m, '360x0');
  // Reserve image space BEFORE load, else the message appears empty and grows a second later,
  // pushing the feed. Width = exactly the final width (`260 * aspect` = height under the cap; `w` =
  // don't upscale; max width left to the frame's maxWidth, screen-dependent). Height via
  // aspect-ratio. Old messages have no size in the filename — as before. Own just-sent image
  // ignores the hide setting (hiding what they just sent would be absurd).
  const local = Boolean(localImageUrl(m.id));
  const blurred = blurImages && !hideImages && !shown && !local;
  const veiled = hideImages && !shown && !local;

  const size = messageImageSize(m);
  const imgBox = size
    ? {
        width: `min(${size.w}px, ${Math.round((260 * size.w) / size.h)}px)`,
        aspectRatio: `${size.w} / ${size.h}`,
      }
    : undefined;
  const nickRole = u && u.isModerator
    ? (admins.has(u.id) ? 'admin' : 'mod')
    : undefined;
  const nickStyle = u
    ? nickRole
      ? undefined
      : { color: nickColor(u.id) }
    : anonId
      ? { color: anonId.color }
      : undefined;

  const hasReactions = Object.keys(m.reactions ?? {}).length > 0;

  // Action buttons float top-right, not inline with the name: grouped messages have no name to
  // attach to.
  const actions = (
    <Actions className="hov" data-on={touched ? '1' : undefined}>
      {onReact && <ReactBtn onPick={(name) => onReact(m, name)} />}
      <ActBtn size="small" title="Reply" onClick={() => onReply(m)}>
        <ReplyOutlinedIcon />
      </ActBtn>
      {canEdit && (
        <ActBtn size="small" title="Edit my message" onClick={() => onEdit(m)}>
          <EditOutlinedIcon />
        </ActBtn>
      )}
      {canDelete && (
        <ActBtn size="small" title="Delete my message" onClick={() => onDeleteOwn(m)}>
          <DeleteOutlineIcon />
        </ActBtn>
      )}
      {isModerator && (
        <>
          <ActBtn
            size="small"
            title={m.pinned ? 'Unpin' : 'Pin in this room'}
            data-tone={m.pinned ? 'pin' : undefined}
            onClick={() => onTogglePin(m)}
          >
            <PushPinOutlinedIcon />
          </ActBtn>
          <ActBtn
            size="small"
            title="Delete for everyone (moderator)"
            data-tone="danger"
            onClick={() => onModDelete(m)}
          >
            <DeleteForeverOutlinedIcon />
          </ActBtn>
          <ActBtn
            size="small"
            title="Mute the author for 24h (moderator)"
            data-tone="danger"
            onClick={() => onModMute(m)}
          >
            <VolumeOffOutlinedIcon />
          </ActBtn>
          <ActBtn
            size="small"
            title="Lift the mute from the author (moderator)"
            onClick={() => onModUnmute(m)}
          >
            <VolumeUpOutlinedIcon />
          </ActBtn>
        </>
      )}
    </Actions>
  );

  return (
    <Fragment>
      {daySep}
      {unread && (
        <Stack direction="row" alignItems="center" spacing={1} sx={NEW_ROW_SX}>
          <Box sx={NEW_RULE_SX} />
          <Typography variant="caption" sx={NEW_LABEL_SX}>
            NEW
          </Typography>
          <Box sx={NEW_RULE_SX} />
        </Stack>
      )}
      <Row
        data-mid={m.id}
        // The class is a styling hook for ChatView, not a prop: a prop would re-render all 500 rows
        // at once, dropping frames while the panel follows the finger.
        className="shout-row"
        onClick={() => onTouch(m)}
        data-g={grouped ? '1' : undefined}
        data-p={m.pinned ? '1' : undefined}
      >
        {grouped ? (
          <>
            <Gutter>
              <GutterClock className="hov">{clockTime(m.created)}</GutterClock>
            </Gutter>
            <GroupClock className="hov" data-on={touched ? '1' : undefined}>
              {clockTime(m.created)}
            </GroupClock>
          </>
        ) : (
          <>
            {/*
              Avatar is a DIRECT child of the row (not the name plaque): only the row grid can
              place it beside the text on desktop and in the name line on phones. Lazy loading:
              most of the 500-row window is above the viewport at load.
            */}
            <Av src={avatarUrlOf(u)} variant="rounded" imgProps={AVATAR_IMG_PROPS}>
              {displayName[0]}
            </Av>
            <Head>
              <Nick
                onClick={(e) => onOpenProfile(e, m)}
                data-u={u ? '1' : undefined}
                data-role={nickRole}
                style={nickStyle}
              >
                {displayName}
              </Nick>
              <Clock title={chatTime(m.created)}>{clockTime(m.created)}</Clock>
              {m.pinned && <PinMark titleAccess="Pinned" />}
            </Head>
          </>
        )}
        <Body>
          {m.reply && (
            <Quote
              type="button"
              title="Go to the original message"
              // Quote click must not also "touch" the row (on phones that shows action buttons) —
              // one tap, one action.
              onClick={(e) => {
                e.stopPropagation();
                onJumpTo(m.reply!.id);
              }}
            >
              {quoteHidden ? (
                <i>blocked message</i>
              ) : (
                <>
                  {/*
                    Empty name in the snapshot = quoting an anon: derive the signature from the
                    frozen anon_key and mask instead of writing "Anonymous".
                  */}
                  <b>{m.reply.name
                    || (m.reply.anon_key ? anonIdentity(m.reply.anon_key, m.reply.anon_mask).name : 'Anonymous')}</b>: {m.reply.text}
                </>
              )}
            </Quote>
          )}
          {m.text && (
            <Text>
              {richText(m, onMention, meUsername)}
              {m.edited && <Edited>(edited)</Edited>}
            </Text>
          )}
          {img && veiled && (
            // Same frame and size as the image: revealing the placeholder mustn't jump the feed.
            // Old messages without sizes: modest placeholder, same jump as the image itself would
            // cause.
            <Box sx={{ mt: 0.5, maxWidth: { xs: 220, sm: 260 } }} style={imgBox}>
              <Veil
                type="button"
                onClick={() => {
                  revealed.add(m.id);
                  setShown(true);
                }}
                title="Images are hidden — click to show this one"
              >
                <ImageOutlinedIcon sx={{ fontSize: 16 }} />
                Show image
              </Veil>
            </Box>
          )}
          {img && !veiled && (
            <ImgLink
              href={messageImageUrl(m)}
              target="_blank"
              rel="noreferrer"
              style={imgBox}
              onClick={(e) => {
                if (blurred) {
                  e.preventDefault();
                  e.stopPropagation();
                  revealed.add(m.id);
                  setShown(true);
                  return;
                }
                // Ctrl/Cmd/Shift/middle click = deliberate new tab, don't interfere. Plain click
                // opens the viewer here: leaving chat costs the feed position.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                onOpenImage(m);
              }}
            >
              {imgBox ? (
                // Space already reserved — the feed won't move, no scroll correction needed.
                <ImgFill
                  src={img}
                  alt=""
                  loading="lazy"
                  title={blurred ? 'NSFW image — click to reveal' : undefined}
                  style={blurred ? { filter: 'blur(7px)', transform: 'scale(1.02)' } : undefined}
                />
              ) : (
                <Img
                  src={img}
                  alt=""
                  loading="lazy"
                  title={blurred ? 'NSFW image — click to reveal' : undefined}
                  style={blurred ? { filter: 'blur(7px)', transform: 'scale(1.02)' } : undefined}
                  // Old message without size in the filename: height known only at load, the feed
                  // grows. Bottom-pinned readers lost the last message under the composer, history
                  // readers saw text jump. Pass the image to the parent to decide what to correct
                  // (ChatView.onImgLoad).
                  onLoad={(e) => onImgLoad(e.currentTarget)}
                />
              )}
            </ImgLink>
          )}
          {/*
            Reactions sit under all message content incl. the image (they belong to the whole
            message). Empty map renders nothing; "+" appears only once reactions exist (else two
            identical pluses next to the corner button).
          */}
          <ReactionBar
            reactions={m.reactions}
            meId={meId}
            showAdd={Boolean(onReact) && hasReactions}
            onToggle={(name) => onReact?.(m, name)}
          />
        </Body>
        {actions}
      </Row>
    </Fragment>
  );
}

export default memo(MessageRow);
