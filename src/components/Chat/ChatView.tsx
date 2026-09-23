// Chat v2 screen (spec: wiki/components/shoutbox-v2-spec.md). One component in two shells: /chat
// page (rooms left, members right) and the narrow header drawer (ChatDrawer). Layout is chosen by
// its OWN width (narrow/wide below), not the shell. Replaced v1 in the header 2026-08-06
// (archive/site-frontend-shoutbox-v1/). Features: rooms, anon toggle for logged-in (§5), guest
// delete password (§6), images ≤8 MB (§9), opt-out "who's here" (§8), replies, @mention
// autocomplete, moderator buttons. UI in English (site is English).

import {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import {
  Alert, Avatar, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, Divider, IconButton, ListItemIcon, ListItemText, Menu, MenuItem,
  Popover, Snackbar, Stack, Tooltip, Typography,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import BlockIcon from '@mui/icons-material/Block';
// Sound uses a speaker icon, not a bell: the bell next to it is push settings; two identical icons
// read as a duplicated setting.
import VolumeUpOutlinedIcon from '@mui/icons-material/VolumeUpOutlined';
import VolumeOffOutlinedIcon from '@mui/icons-material/VolumeOffOutlined';
import VerticalAlignBottomOutlinedIcon from '@mui/icons-material/VerticalAlignBottomOutlined';
import VerticalAlignTopOutlinedIcon from '@mui/icons-material/VerticalAlignTopOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import GifBoxOutlinedIcon from '@mui/icons-material/GifBoxOutlined';
import MotionPhotosOffOutlinedIcon from '@mui/icons-material/MotionPhotosOffOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import OpenInFullOutlinedIcon from '@mui/icons-material/OpenInFullOutlined';
import CloseFullscreenOutlinedIcon from '@mui/icons-material/CloseFullscreenOutlined';
import SwipeLeftOutlinedIcon from '@mui/icons-material/SwipeLeftOutlined';
import DoNotTouchOutlinedIcon from '@mui/icons-material/DoNotTouchOutlined';
import SportsEsportsOutlinedIcon from '@mui/icons-material/SportsEsportsOutlined';
import PushBell from '../../push/PushBell';
import { dismissChatNotifications, pushEndpoint, roomPushPrefsCached } from '../../push/pushClient';
import { setChatOpen, setChatReading } from '../../push/chatPresence';
import { AuthContext, pb } from '../../pocketbase/pocketbase';
import {
  dayLabel, pbDateMs, sameDay,
} from '../CyoaPage/Comments/relativeTime';
import { getAttention, subscribeAttention, noteAttention, readAttention, setAttentionChatOpen, listenAttentionNotifications } from '../Notifications/chatAttention';
import { anonIdentity, nickColor } from '../Shoutbox/anonIdentity';
import { useAnonMask } from '../Shoutbox/anonMask';
import AnonMaskIcon from './AnonMaskIcon';
import AnonMaskDialog from './AnonMaskDialog';
import { staffNickColor, useChatAdmins } from './staff';
import {
  SHOUT_PAGE, ShoutChannel, ShoutMessage, ShoutProfile, ShoutRest, ShoutWho, avatarUrlOf,
  channelTitle as channelLabel,
  deleteMessage, deleteOwnMessage, editOwnMessage, fetchChannels, fetchMessages, fetchProfile,
  fetchMessage, fetchNewer, fetchPinned, fetchWho, messageInChannel, muteMessageSource, unmuteMessageSource, openDM, pinMessage,
  pingPresence, postMessageV2, reactToMessage, subscribeMessages,
  blockUser, fetchBlocks, unblockUser, readMarks, saveChatPins, isCommunityChannel,
} from '../Shoutbox/shoutboxApi';
import { useChatNotes } from '../Shoutbox/chatNotes';
import { emojiVersion, useEmojiPack } from '../Emoji/registry';
import MessageRow from './MessageRow';
import PinnedBar from './PinnedBar';
import ThreadHeader from './ThreadHeader';
import ImageLightbox from './ImageLightbox';
import Composer, { ComposerHandle } from './Composer';
import RoomDialog from './RoomDialog';
import RoomsAdminDialog from './RoomsAdminDialog';
import BlockedUsersDialog from './BlockedUsersDialog';
import NoteEditor from './NoteEditor';
import { setChatPref, useChatPrefs, type SwipeOpenMode } from './chatPrefs';
import ChannelPanel from './ChannelPanel';
import MembersPanel from './MembersPanel';
import CommunityList from './CommunityList';
import ThreadComposer from './ThreadComposer';
import OpEditDialog from './OpEditDialog';
import ThreadModerateDialog from './ThreadModerateDialog';
import {
  CHAT_THREADS_PATH, fetchCommunityRoom, fetchCommunitySide, setCommunityAnonKey,
  subscribeCommunityRooms,
  type CommunityRoom, type CommunityRating, type CommunityRoomEvent,
} from './communityApi';
import { claimShared, PING_KEY } from '../Shoutbox/tabLeader';

// Throttle for refetching the room list on live signals: from a new room the signal fires on EVERY
// message.
const CHAN_SYNC_GAP_MS = 15_000;
// Safety refetch of the room list: catches what emits no signal (an empty room you were just
// invited to).
const CHAN_POLL_MS = 5 * 60_000;

const SWIPE_OPEN_MODE_CYCLE: Record<SwipeOpenMode, SwipeOpenMode> = {
  everywhere: 'games_off',
  games_off: 'off',
  off: 'everywhere',
};

// Max feed rows in memory; history pages load on both sides like Discord (scroll up → bottom drops
// out, and vice versa). Thousands of live DOM nodes = seconds per frame on cheap phones.
const WINDOW_MAX = 500;

// Rooms remembering their last screen (feedCacheRef): people cycle through ~6 rooms.
const FEED_CACHE_ROOMS = 6;

// Consecutive messages by one author merge into a block (avatar/nick once) — the key messenger
// look. 5-minute gap threshold.
const GROUP_GAP_SEC = 5 * 60;

// Profile card on nick click; flag because profiles are nearly empty. false removes the card and
// its fetch.
const PROFILE_POPOVER = true;

type PanelSide = 'rooms' | 'members' | null;

const COLUMN_W = 264;

// Threshold where the expanded topic header swaps to collapsed ≈ collapsed height, so the swap
// happens where both occupy the same space (otherwise it's a jump).
const OP_TAIL_MIN = 104;
// Offset after self-expand so slightly more than the threshold is visible — otherwise it collapses
// again on the same scroll.
const OP_UNFOLD_NUDGE = 28;

const SOUND_KEY = 'chatlab_sound';
const DELPASS_KEY = 'chatlab_delpass';

const SEEN_KEY = 'chatlab_channel_seen';
const HIDDEN_KEY = 'chatlab_dm_hidden';

// Hoisted styles: typing re-renders the screen; don't rebuild style objects per room each keypress.
const CHANBAR_SX = {
  display: 'flex',
  alignItems: 'center',
  gap: 0.75,
  flex: 1,
  minWidth: 0,
  overflowX: 'auto',
  py: 0.75,
  scrollbarWidth: 'none',
  '&::-webkit-scrollbar': { display: 'none' },
} as const;

const PILL_HASH_SX = { opacity: 0.45 } as const;

const PILL_ACTION_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 26,
  height: 26,
  borderRadius: 999,
  border: 0,
  bgcolor: 'transparent',
  color: 'text.secondary',
  fontFamily: 'inherit',
  fontSize: 16,
  lineHeight: 1,
  cursor: 'pointer',
  '&:hover': { bgcolor: 'rgba(255,255,255,0.06)', color: 'text.primary' },
} as const;

const BAR_TITLE_SX = {
  fontSize: 13,
  fontWeight: 700,
  px: 0.5,
  whiteSpace: 'nowrap',
} as const;

// Per-room "read up to" (unix sec). Primary store is localStorage (changes on every room switch —
// too costly for the DB), piggybacked once a minute on the ping and merged back if another device
// read further: cross-device sync with zero extra requests. Key has an ACCOUNT suffix: one browser,
// several people (shared laptop, account switch); without it marks merged and got uploaded under
// the second account (rooms marked read for someone who never opened them). authStore read directly
// (not a prop): called from effects and handlers with no ordering guarantee about account change.
// Guests use the bare key.
function scopedKey(base: string): string {
  const uid = pb.authStore.record?.id;
  return uid ? `${base}:${uid}` : base;
}

// One-time migration from the old shared key to the per-account key (then the old key is deleted).
// On a shared laptop the first to log in inherits it — mixing ends forever instead of never.
// Without it every room would light up at once.
function adoptLegacy(base: string) {
  const key = scopedKey(base);
  if (key === base) return;
  try {
    const legacy = localStorage.getItem(base);
    if (legacy === null) return;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    localStorage.removeItem(base);
  } catch { }
}

function loadChannelSeen(): Record<string, number> {
  try {
    adoptLegacy(SEEN_KEY);
    return JSON.parse(localStorage.getItem(scopedKey(SEEN_KEY)) || '{}');
  } catch {
    return {};
  }
}

function saveChannelSeen(all: Record<string, number>) {
  try {
    localStorage.setItem(scopedKey(SEEN_KEY), JSON.stringify(all));
  } catch { }
}

function markChannelsSeen(ids: string[], created?: string) {
  const all = loadChannelSeen();
  if (!created) return;
  const now = pbDateMs(created) / 1000;
  for (const id of ids) all[id] = Math.max(all[id] ?? 0, now);
  saveChannelSeen(all);
}

// Merge takes the LARGER mark: sync can only move "read" forward, never light "new" on something
// read. null = nothing to merge.
function mergeChannelSeen(marks?: Record<string, number>): Record<string, number> | null {
  if (!marks || !Object.keys(marks).length) return null;
  const all = loadChannelSeen();
  let changed = false;
  for (const [id, at] of Object.entries(marks)) {
    if (typeof at === 'number' && at > (all[id] ?? 0)) {
      all[id] = at;
      changed = true;
    }
  }
  if (!changed) return null;
  saveChannelSeen(all);
  return all;
}

// "I closed this conversation": channel → close time. Removes it from MY list only; returns when
// someone writes again (compared against last message time). Device-local like read marks (server
// version = per-user×channel rows). Tradeoff: closed on phone stays listed on laptop.
function loadHiddenDms(): Record<string, number> {
  try {
    adoptLegacy(HIDDEN_KEY);
    return JSON.parse(localStorage.getItem(scopedKey(HIDDEN_KEY)) || '{}');
  } catch {
    return {};
  }
}

function saveHiddenDms(map: Record<string, number>) {
  try {
    localStorage.setItem(scopedKey(HIDDEN_KEY), JSON.stringify(map));
  } catch { }
}

// The merged "all rooms" feed was removed (2026-09-17, wiki/log.md); just a one-time sweep of the
// old mode key.
try {
  localStorage.removeItem('chatlab_channel_mode');
} catch { }

// Remember the last room; if removed/closed, fall back to default silently.
const CHAN_KEY = 'chatlab_channel';

// Delete passwords we hold: message id → password, in localStorage so a guest's delete works
// without typing. Parsed cache kept for the tab's life: feed build read+parsed localStorage on
// EVERY rebuild (every keypress, every message) — synchronous, landing in typing frames.
let delPassCache: Record<string, string> | null = null;

function loadDelPasses(): Record<string, string> {
  if (delPassCache) return delPassCache;
  try {
    delPassCache = JSON.parse(localStorage.getItem(DELPASS_KEY) || '{}');
  } catch {
    delPassCache = {};
  }
  return delPassCache ?? {};
}

// A neighbor tab wrote → our parse is stale. Module-level listener because the cache is
// module-level.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === DELPASS_KEY || e.key === null) delPassCache = null;
  });
}

function rememberDelPass(id: string, pass: string) {
  const all = loadDelPasses();
  all[id] = pass;
  // Keep the last 50 (retention is off; messages live forever) — enough to delete what you just
  // said.
  const keys = Object.keys(all);
  if (keys.length > 50) delete all[keys[0]];
  localStorage.setItem(DELPASS_KEY, JSON.stringify(all));
}

// Message gone → drop its password (dead secrets crowd out live ones in the 50).
function forgetDelPass(id: string) {
  const all = loadDelPasses();
  if (!(id in all)) return;
  delete all[id];
  localStorage.setItem(DELPASS_KEY, JSON.stringify(all));
}

// Random ownership secret for an anon message; independent of shared IP/anon_key.
function makeDelPass(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

// Value-compare server responses: ping and roster come on timers with NEW objects each time; stored
// as-is they re-rendered the whole screen every minute with nothing changed. Merge "last written"
// by max and return the SAME reference if unchanged.
function mergeNumMap(
  cur: Record<string, number>,
  next?: Record<string, number>,
): Record<string, number> {
  if (!next) return cur;
  let grew = false;
  const out: Record<string, number> = { ...cur };
  for (const [k, v] of Object.entries(next)) {
    if (v > (out[k] ?? 0)) { out[k] = v; grew = true; }
  }
  return grew ? out : cur;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

// Same list → keep the OLD array (else all names re-render every minute, see memo in MembersPanel).
// Avatar compared too, or a changed avatar stays stale.
function sameWho(a: ShoutWho[], b: ShoutWho[]): boolean {
  return a.length === b.length
    && a.every((x, i) => x.id === b[i].id && x.name === b[i].name
      && x.mod === b[i].mod && x.avatar === b[i].avatar);
}

function authorKey(m: ShoutMessage): string {
  if (m.user) return `u:${m.user}`;
  if (m.anon_key) return `a:${m.anon_key}`;
  return '';
}

// Merge only plain messages by one author in one room within GROUP_GAP_SEC. A reply always breaks
// the block (own header with quote).
function sameRun(prev: ShoutMessage | undefined, m: ShoutMessage): boolean {
  if (!prev || m.reply) return false;
  if (prev.kind !== 'user' || m.kind !== 'user') return false;
  if ((prev.channel || '') !== (m.channel || '')) return false;
  const key = authorKey(m);
  if (!key || authorKey(prev) !== key) return false;
  const dt = (pbDateMs(m.created) - pbDateMs(prev.created)) / 1000;
  if (dt < 0 || dt >= GROUP_GAP_SEC) return false;
  // Never merge across midnight: a date divider sits between; the first line of the day would have
  // no author.
  return sameDay(prev.created, m.created);
}

// Mention ping synthesized with an oscillator, not a sound file (no request/asset/cache concerns).
// One AudioContext reused — browsers limit them per tab.
let pingAudio: AudioContext | null = null;
function playPingSound() {
  try {
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!pingAudio) pingAudio = new Ctor();
    // Autoplay: context is suspended without a user gesture; resume() may fail — never crash.
    if (pingAudio.state === 'suspended') void pingAudio.resume();
    const ctx = pingAudio;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // Envelope required: bare oscillator start/stop clicks louder than the note.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(1320, now + 0.09);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
  }
}

// Tab title counter: strip our previous prefix first, or "(1) (2) (3) cyoa.cafe" accumulates.
const TITLE_BADGE_RE = /^\(\d+\)\s*/;
function setTitleBadge(n: number) {
  const base = document.title.replace(TITLE_BADGE_RE, '');
  document.title = n > 0 ? `(${n}) ${base}` : base;
}

// Jump target from a "replied in chat" notification. token increments on every click (even the same
// message) so the effect can tell a new click from a stale prop.
export type ChatJumpTarget = { messageId: string; channelId?: string; token: number };

type Props = {
  jumpTarget?: ChatJumpTarget | null;
  // Enables user topics; set by topic routes (/chat/threads, /chat/t/<slug>).
  community?: boolean;
  // Start on the topic index (/chat/threads). INITIAL state only; afterwards the user drives and
  // the URL follows.
  startThreads?: boolean;
  rating?: CommunityRating;
  // Room/topic slug from the URL (/chat/r/<slug>, /chat/t/<slug>); overrides the remembered room. A
  // topic may not be in the column — fetched by slug.
  routeSlug?: string;
  // Report what opened so the page rewrites the URL. The drawer doesn't pass it (no URL of its
  // own).
  onRouteChange?: (path: string, opts?: { push?: boolean; back?: boolean }) => void;
};

// A topic as a channel: same machinery as rooms (feed, composer, realtime, read marks) — no
// separate copy.
function communityAsChannel(r: CommunityRoom): ShoutChannel {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    owner: r.owner,
    mine: r.mine,
    is_private: false,
    is_dm: false,
    community: true,
    tags: r.tags,
  };
}

export default function ChatView({
  jumpTarget, community = false, startThreads = false, rating = 'all',
  routeSlug, onRouteChange,
}: Props) {
  const { signedIn, user, isModerator, hasModPerm } = useContext(AuthContext);
  // Server guards chat mutations with a separate capability; don't show them to moderators of
  // another area (they'd get 403).
  const canModerateChat = isModerator && hasModPerm('chat');

  const [channels, setChannels] = useState<ShoutChannel[]>([]);
  const [active, setActive] = useState<string>('');
  const [messages, setMessages] = useState<ShoutMessage[]>([]);
  // Pins of visible rooms fetched separately: a pin is usually older than the in-memory window;
  // picking from `messages` would lose the strip exactly in old conversations.
  const [pins, setPins] = useState<ShoutMessage[]>([]);
  // Topic header uses the ROOM's own fields (op_text/op_image), not the first feed message
  // (deletable, pinnable, outrun by replies).
  const [threadTopic, setThreadTopic] = useState<CommunityRoom | null>(null);
  // Header collapse state owned by the screen: the header is the FIRST feed element and its swap
  // requires a scroll correction at relayout.
  const [opCollapsed, setOpCollapsed] = useState(false);
  const opCollapsedRef = useRef(false);
  opCollapsedRef.current = opCollapsed;
  const opRef = useRef<HTMLDivElement>(null);
  // Height measured BEFORE collapse; subtract the difference from scroll or the feed jumps by the
  // post height.
  const opHRef = useRef(0);
  // Scroll action after header relayout: keep (auto collapse/expand while scrolling — user must not
  // notice); jump (collapsed by tap: "to the comments"); top (expanded by tap: they want the post).
  const opModeRef = useRef<'keep' | 'jump' | 'top'>('keep');
  // Don't touch the header until this moment — right after self-expand, the next scroll event would
  // collapse it again (endless see-saw).
  const opCalmRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  // Feed detached from the live tail (bottom dropped out of the window): don't append realtime, or
  // there's a silent gap between history and the new message.
  const [hasNewer, setHasNewer] = useState(false);

  const [error, setError] = useState('');
  // Emoji pack subscription lives on the feed, not rows: rows are memoized, so shortcodes would
  // stay text until an unrelated re-render (emojiVer in MessageRow).
  const emojiPack = useEmojiPack();
  // Reply/edit are set FROM the feed so they live here; typed text/image/sending live in Composer —
  // a keypress must not re-render the feed screen.
  const [replyTo, setReplyTo] = useState<ShoutMessage | null>(null);

  const [chanLast, setChanLast] = useState<Record<string, number>>({});
  const [legacyMentions, setChanMentions] = useState<string[]>([]);
  const attention = useSyncExternalStore(subscribeAttention, getAttention);
  const chanMentions = useMemo(() => signedIn
    ? Object.entries(attention.channels).filter(([id, c]) => c.latest > (attention.reads[id] ?? 0)).map(([id]) => id)
    : legacyMentions, [attention, signedIn, legacyMentions]);
  // Topics that lit up WHILE I'm here (live message or created while chat open). A never-opened
  // topic has no read mark, so "last message newer than mark" lit it ALWAYS — dots everywhere. Rule
  // for column and index: opened topic → read mark decides; never opened → only what happened in my
  // presence.
  const [liveLit, setLiveLit] = useState<Record<string, true>>({});
  // Which ids are topics (grows only): tells whether a missing read mark can be trusted.
  const communityIdsRef = useRef<Set<string>>(new Set());
  const noteCommunityIds = useCallback((ids: string[]) => {
    for (const id of ids) if (id) communityIdsRef.current.add(id);
  }, []);
  // Topic new-counts are computed by the SERVER (thousands of topics don't fit the shared pulse);
  // delivered by the minute ping, no extra request.
  const [chanNew, setChanNew] = useState<Record<string, number>>({});
  const [channelSeen, setChannelSeen] = useState<Record<string, number>>(loadChannelSeen);
  const [hiddenDms, setHiddenDms] = useState<Record<string, number>>(loadHiddenDms);
  const openChannelsRef = useRef<string[]>([]);
  // Read-mark snapshot AT PAGE OPEN, used for the "new" divider; live channelSeen updates as you
  // read and the divider would crawl away under the cursor. Taken at first render, before the
  // mark-read effect.
  const seenAtOpenRef = useRef<Record<string, number>>(loadChannelSeen());
  const [editing, setEditing] = useState<ShoutMessage | null>(null);
  const [touched, setTouched] = useState<string | null>(null);
  const [profileAnchor, setProfileAnchor] = useState<HTMLElement | null>(null);
  const [profile, setProfile] = useState<ShoutProfile | null>(null);
  const profileCache = useRef<Record<string, ShoutProfile>>({});
  // Whose card we're awaiting; drop answers about someone else (openProfile).
  const profileWantRef = useRef<string>('');

  const [roomDialog, setRoomDialog] = useState<{ room?: ShoutChannel } | null>(null);
  const [prefsAnchor, setPrefsAnchor] = useState<HTMLElement | null>(null);
  const [roomsAdmin, setRoomsAdmin] = useState(false);
  // Center mode: 'list' (topic index), 'compose' (new topic), null (conversation). One state, not
  // two flags: modes are exclusive. When "new topic" was an overlay, the last room's header and pin
  // showed over the topic list — the mode makes that class of bugs impossible.
  const [midView, setMidView] = useState<'list' | 'compose' | null>(
    startThreads ? 'list' : null,
  );
  const communityView = midView === 'list';
  const composeView = midView === 'compose';
  const setCommunityView = useCallback((on: boolean) => {
    setMidView(on ? 'list' : null);
  }, []);
  // Back step from center modes lives here: the arrow is in the shared top bar.
  const leaveMidView = useCallback(() => {
    setMidView((v) => (v === 'compose' && community ? 'list' : null));
  }, [community]);
  const [opDialog, setOpDialog] = useState(false);
  const [modDialog, setModDialog] = useState(false);
  const [communityReload, setCommunityReload] = useState(0);
  // Separate refresh key for the topic COLUMN: the index can't be refreshed on a timer (user is
  // scrolling/sorting it); the short column can and should.
  const [communitySideReload, setCommunitySideReload] = useState(0);
  // Edge-cache buster for the side column: the topic id from the live event. Ref, not state
  // (refetch already triggered by a counter).
  const sideBustRef = useRef('');
  const [blockedListOpen, setBlockedListOpen] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const anonMaskName = useAnonMask();
  const viewPrefs = useChatPrefs();
  const [nsfwGateRoom, setNsfwGateRoom] = useState<CommunityRoom | null>(null);
  const nsfwApprovedRef = useRef(new Set<string>());
  const chatNotes = useChatNotes();
  const admins = useChatAdmins();

  const [zoomed, setZoomed] = useState<ShoutMessage | null>(null);
  // Stable reference: handlers go into memo rows; a new function each render re-renders the whole
  // feed (see MessageRow.tsx header).
  const openImage = useCallback((m: ShoutMessage) => setZoomed(m), []);
  const closeImage = useCallback(() => setZoomed(null), []);

  // Side panels PUSH the chat aside rather than cover it (the conversation stays visible while
  // choosing a room).
  const outerRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const membersRef = useRef<HTMLDivElement | null>(null);
  const colRef = useRef<HTMLDivElement | null>(null);
  // Only one panel at a time: they share one gesture axis (right → rooms, left → members).
  const [side, setSide] = useState<PanelSide>(null);
  // Same, readable immediately: the gesture reads it on every touch; state lands a frame later.
  const sideRef = useRef<PanelSide>(null);
  const panelWRef = useRef(0);
  const panelOpen = side === 'rooms';

  // Layout by OWN width, not window: the same chat is a full page and a narrow drawer on a wide
  // monitor (a media query would say "wide"). Initial value = window width (erring narrow on wide
  // screens is more visible).
  const [availW, setAvailW] = useState(() => (
    typeof window === 'undefined' ? 1200 : window.innerWidth
  ));
  useLayoutEffect(() => {
    const el = outerRef.current;
    if (!el) return undefined;
    setAvailW(el.clientWidth);
    // Observe the OUTER wrapper: the shell's own width is capped by a layout-dependent maxWidth —
    // measuring it would measure our own decision and never switch back.
    const ro = new ResizeObserver(() => setAvailW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = availW < 720;
  const wide = availW >= 1160;

  const [anonKey, setAnonKey] = useState('');
  const [online, setOnline] = useState(0);
  const [who, setWho] = useState<ShoutWho[]>([]);
  const [rest, setRest] = useState<ShoutRest>({ guests: 0, hidden: 0, cut: 0 });
  // Members of the OPEN room. undefined = unknown (section hidden), so an empty list never falsely
  // says "nobody here".
  const [here, setHere] = useState<ShoutWho[] | undefined>(undefined);
  const [hereMore, setHereMore] = useState(0);
  // Show me in "who's here": author decision 2026-08-04 — logged-in users YES by default (the list
  // exists to click someone and DM them). Guests never shown (random name, no consent). Stored on
  // the account (`chat_hidden`), not the browser: hide from the whole site on all devices.
  const visible = signedIn && !user?.chat_hidden;
  // "Who's here" is a dropdown, not an inline panel: on phones the panel ate a third of the feed.
  const [whoAnchor, setWhoAnchor] = useState<HTMLElement | null>(null);
  const showWho = Boolean(whoAnchor);
  // Members show in three places (wide column, dropdown, swipe panel); previously loaded only for
  // the dropdown — column and panel were empty.
  const rosterOn = wide || showWho || side === 'members';
  // Same flag in a ref for the ping (own minute loop; adding rosterOn to deps would hit the server
  // on every panel toggle).
  const rosterRef = useRef(false);
  rosterRef.current = rosterOn;
  const [atBottom, setAtBottom] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const feedContentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const activePillRef = useRef<HTMLElement | null>(null);
  // Guard against parallel history loads: one swipe at the top = dozens of scroll events with the
  // same cursor until the first reply; without it the same page was spliced in several times
  // (repeating multi-day chunks).
  const loadingOlderRef = useRef(false);
  // Anchor a SPECIFIC row (data-mid), not height delta: the window changes both ends at once
  // (history above, tail dropped below), so "grew by N px" lies.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  // Separate guard for loading down: inertial scroll can hit both edges.
  const loadingNewerRef = useRef(false);
  // Realtime subscription outlives renders — needs "detached" in a ref (closure state would be
  // frozen).
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
  const anchorOn = useCallback((id: string) => {
    const el = listRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el || !node) return;
    anchorRef.current = {
      id,
      top: node.getBoundingClientRect().top - el.getBoundingClientRect().top,
    };
  }, []);

  // Feed generation, bumped on every reload (room/mode change); responses from the previous room
  // are discarded.
  const feedGenRef = useRef(0);

  // Per-room tail cache: show the remembered last page instantly, silently replace with the server
  // answer (stale-while-revalidate); otherwise a switch shows a spinner or — worse — the PREVIOUS
  // room's feed under the new title. Store only the tail: rooms always open at the bottom.
  const feedCacheRef = useRef(new Map<string, ShoutMessage[]>());
  const feedKeyRef = useRef('');
  // Feed in a ref so reload can stash it on leave without depending on messages (else reload
  // recreates per message and the effect reloads the feed).
  const messagesRef = useRef<ShoutMessage[]>(messages);
  messagesRef.current = messages;

  // Reading position survives only until page reload. Store a row + its viewport offset, not
  // scrollTop (images/header change heights above). `atBottom`: returning from the live tail goes
  // to the first new message, not the old pixel.
  type ReadingPosition = { id: string; top: number; atBottom: boolean };
  type EntryPlan = {
    channelId: string;
    kind: 'restore' | 'thread-start' | 'unread' | 'latest';
    targetId?: string;
    top?: number;
    applied: boolean;
    cancelled: boolean;
  };
  const readingPositionsRef = useRef(new Map<string, ReadingPosition>());
  const entryPlanRef = useRef<EntryPlan | null>(null);
  const forceLatestRef = useRef(false);
  // An explicit deep link creates a hole in the sequential read boundary: one shown message doesn't
  // mean everything before it was seen.
  const readGapChannelRef = useRef('');
  const explicitNavigationRef = useRef(false);

  const captureReadingPosition = useCallback((channelId?: string) => {
    const el = listRef.current;
    if (!el || !channelId || messagesRef.current.length === 0) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-mid]'));
    const edge = el.getBoundingClientRect().top;
    const row = rows.find((node) => node.getBoundingClientRect().bottom > edge) ?? rows.at(-1);
    if (!row) return;
    readingPositionsRef.current.set(channelId, {
      id: row.dataset.mid ?? '',
      top: row.getBoundingClientRect().top - edge,
      atBottom: atBottomRef.current && !hasNewerRef.current,
    });
  }, []);

  const activeChannel = useMemo(
    () => channels.find((c) => c.slug === active),
    [channels, active],
  );

  // Default channel = first in list (server-sorted). Only it shows old channel-less messages
  // (written before rooms existed).
  const isDefaultChannel = Boolean(activeChannel && channels[0]?.id === activeChannel.id);

  const channelNewCount = useCallback(
    (id: string) => chanNew[id] ?? 0,
    [chanNew],
  );

  const channelHasNew = useCallback(
    (id: string) => {
      const personal = attention.channels[id];
      if (personal?.dm) return personal.latest > (attention.reads[id] ?? 0);
      const seen = Math.max(channelSeen[id] ?? 0, (attention.reads[id] ?? 0) / 1000) || undefined;
      // Never opened → only live-lit counts (liveLit). Rooms are exempt: a dozen, same for
      // everyone; "never opened" is a fine reason for a dot.
      if (seen === undefined && communityIdsRef.current.has(id)) return liveLit[id] === true;
      return (chanLast[id] ?? 0) > (seen ?? 0);
    },
    [chanLast, channelSeen, liveLit, attention],
  );

  // "Closed and nothing written since"; compared with last message time, not read state — else it
  // vanishes the moment you finish reading.
  const dmHidden = useCallback(
    (id: string) => {
      const at = hiddenDms[id];
      return at !== undefined && (chanLast[id] ?? 0) <= at;
    },
    [hiddenDms, chanLast],
  );

  // Server-side block list (shoutbox_blocks.go): server closes DMs and skips pushes; the client
  // hides lines (the feed is shared).
  const [blocked, setBlocked] = useState<string[]>([]);
  const blockedSet = useMemo(() => new Set(blocked), [blocked]);
  // Same set in a ref: the new-message signal is computed inside a long-lived subscription.
  const blockedRef = useRef(blockedSet);
  blockedRef.current = blockedSet;

  useEffect(() => {
    if (!signedIn) { setBlocked([]); return; }
    let dead = false;
    fetchBlocks().then((ids) => { if (!dead) setBlocked(ids); });
    return () => { dead = true; };
  }, [signedIn]);

  // Optimistic block/unblock (lines must vanish instantly); revert and report on failure.
  const toggleBlock = useCallback(async (userId: string) => {
    const on = !blockedRef.current.has(userId);
    setBlocked((cur) => (on ? [...cur, userId] : cur.filter((x) => x !== userId)));
    try {
      if (on) await blockUser(userId); else await unblockUser(userId);
      // Blocks close DMs both ways, so the room list changes (the DM stops being returned).
      await refreshChannelsRef.current?.();
    } catch (e) {
      setBlocked((cur) => (on ? cur.filter((x) => x !== userId) : [...cur, userId]));
      setError((e as { message?: string })?.message || 'Could not update your block list.');
    }
  }, []);

  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== '0');
  const soundRef = useRef(sound);
  soundRef.current = sound;

  // Tab-title counter only for personal pings (mention, DM, reply to you). Author decision: "in the
  // title only if the user was mentioned".
  const pingsRef = useRef(0);

  const clearPings = useCallback(() => {
    if (pingsRef.current === 0) return;
    pingsRef.current = 0;
    setTitleBadge(0);
  }, []);

  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  // Muted rooms from the local notify-prefs snapshot (updated by the bell menu), read once per
  // mount; the server remains authoritative.
  const roomMutedRef = useRef<Record<string, string>>(roomPushPrefsCached());

  // Personal ping = @nick, DM, or reply to you. Anything else neither changes the title nor sounds
  // — else the signal means nothing by the first evening.
  const isPersonalPing = useCallback((m: ShoutMessage): boolean => {
    if (m.kind === 'system') return false;
    const meId = user?.id || '';
    if (meId ? m.user === meId : Boolean(anonKey) && m.anon_key === anonKey) return false;
    if (m.user && blockedRef.current.has(m.user)) return false;
    // Muted room → no sound/title counter even for mentions (server does the same for pushes).
    if (m.channel && roomMutedRef.current[m.channel] === 'mute') return false;
    if (m.channel && channelsRef.current.find((c) => c.id === m.channel)?.is_dm) return true;
    const uname = user?.username;
    // Same nick pattern as mention highlighting (richText.tsx): ring exactly on what the user sees
    // highlighted.
    if (uname) {
      const re = /@([A-Za-z0-9_]{2,30})/g;
      for (let hit = re.exec(m.text); hit; hit = re.exec(m.text)) {
        if (hit[1].toLowerCase() === uname.toLowerCase()) return true;
      }
    }
    if (m.reply) {
      // First the quote snapshot (carries parent author, arrives with the message). Searching only
      // the 500-row window missed replies to older messages — the worst miss, since people reply to
      // old things.
      if (meId && m.reply.user) return m.reply.user === meId;
      if (!meId && anonKey && m.reply.anon_key) return m.reply.anon_key === anonKey;
      // Messages from before `reply.user` lack the author in the snapshot — fall back to the
      // window.
      const parent = messagesRef.current.find((x) => x.id === m.reply?.id);
      if (parent) {
        return meId
          ? parent.user === meId
          : Boolean(anonKey) && parent.anon_key === anonKey;
      }
    }
    return false;
  }, [user?.id, user?.username, anonKey]);

  const pingRef = useRef(isPersonalPing);
  pingRef.current = isPersonalPing;

  // Live message fan-out, currently only to the topic index. One collection subscription per tab
  // brings ALL site messages (subscribeMessages), so the index bumps its counter without asking the
  // server. One listener (one topic screen per tab).
  const liveRef = useRef<((m: ShoutMessage) => void) | null>(null);
  const onLiveMessage = useCallback((fn: (m: ShoutMessage) => void) => {
    liveRef.current = fn;
    return () => { if (liveRef.current === fn) liveRef.current = null; };
  }, []);

  // Current user in a ref for the subscription (created once; `user` would freeze at mount).
  const meIdRef = useRef(user?.id || '');
  meIdRef.current = user?.id || '';

  // Count only when the tab isn't being looked at; sound also in an open tab (people work in
  // another window).
  const notePing = useCallback((m: ShoutMessage) => {
    if (!pingRef.current(m)) return;
    if (soundRef.current) playPingSound();
    if (document.hasFocus()) return;
    pingsRef.current += 1;
    setTitleBadge(pingsRef.current);
  }, []);

  const noteRef = useRef(notePing);
  noteRef.current = notePing;

  // Reset on focus, not visibility: a visible tab in an inactive window is exactly where pings get
  // missed.
  useEffect(() => {
    window.addEventListener('focus', clearPings);
    document.addEventListener('visibilitychange', clearPings);
    return () => {
      window.removeEventListener('focus', clearPings);
      document.removeEventListener('visibilitychange', clearPings);
      setTitleBadge(0);
    };
  }, [clearPings]);

  const hideDm = useCallback((id: string) => {
    const now = Math.floor(Date.now() / 1000);
    setHiddenDms((cur) => {
      const next = { ...cur, [id]: now };
      saveHiddenDms(next);
      return next;
    });
  }, []);

  // First unread = divider position, computed from the open-time snapshot so it stays put. No
  // divider for first-time rooms (no mark — everything is "new").
  const firstUnreadId = useMemo(() => {
    const home = channels[0]?.id;
    for (const m of messages) {
      const chId = m.channel || home;
      if (!chId) continue;
      const seen = seenAtOpenRef.current[chId];
      if (!seen) continue;
      if (pbDateMs(m.created) / 1000 > seen) return m.id;
    }
    return null;
  }, [messages, channels]);

  // Topics come in a separate request and are appended to the END of channels: `channels[0]` is the
  // default room. Also kept in a ref: the channel list is refetched wholesale (room created, DM
  // left) and topics would vanish from the column each time.
  const communityRef = useRef<ShoutChannel[]>([]);
  // Active room in a ref: topic merging mustn't rerun on each room change but must know it.
  const activeRef = useRef(active);
  activeRef.current = active;
  const withCommunity = useCallback((cs: ShoutChannel[]) => {
    const extra = communityRef.current.filter((r) => !cs.some((c) => c.id === r.id));
    return extra.length === 0 ? cs : [...cs, ...extra];
  }, []);

  useEffect(() => {
    if (!community) return;
    let alive = true;
    const bust = sideBustRef.current;
    // One-shot key: routine refetches must hit the shared, cacheable URL.
    sideBustRef.current = '';
    void fetchCommunitySide(bust).then((rooms) => {
      if (!alive) return;
      communityRef.current = rooms.map(communityAsChannel);
    noteCommunityIds(communityRef.current.map((c) => c.id));
      // Topics in SERVER order (fresh first), rebuilding the segment: the open topic used to keep
      // its old position with the fresh list appended — the one you're in floated above all, and
      // with live refetches the order jumped visibly. If the open topic isn't in the short list,
      // append it AT THE END (don't pull the room from under the user).
      setChannels((cur) => {
        const fresh = communityRef.current;
        const open = cur.find((c) => (
          c.community && c.slug === activeRef.current && !fresh.some((r) => r.id === c.id)
        ));
        const base = cur.filter((c) => !c.community);
        return open ? [...base, ...fresh, open] : [...base, ...fresh];
      });
    });
    return () => { alive = false; };
  }, [community, communityReload, communitySideReload, withCommunity, noteCommunityIds]);

  useEffect(() => {
    fetchChannels().then((cs) => {
      setChannels(withCommunity(cs));
      // Read marks from other devices arrive in the same response; merge BEFORE the first list
      // render, else rooms flash "new".
      const merged = mergeChannelSeen(readMarks());
      if (merged) {
        setChannelSeen(merged);
        // The open-time snapshot must be updated too, or the divider shows phone-read messages as
        // new.
        seenAtOpenRef.current = { ...merged };
      }
      // Use the remembered room only if it's still listed (a missing channel filter = empty feed).
      const saved = localStorage.getItem(CHAN_KEY);
      // Search the list WITH topics: a remembered topic would otherwise kick the user out on every
      // visit.
      const all = withCommunity(cs);
      const remembered = all.some((c) => c.slug === saved) ? saved! : cs[0]?.slug;
      setActive((cur) => (cur || (cs[0] ? remembered : '')));
    });
  }, [signedIn, withCommunity]);

  // The channel list used to be fetched once per mount — new DMs/invites/rooms appeared only after
  // F5. It now catches up on live signals (list only; feed and open room untouched). /channels
  // doesn't return topics (`owner = ''`), so the open topic is carried over manually.
  const mergeChannels = useCallback((cs: ShoutChannel[], prev: ShoutChannel[]) => {
    const keep = prev.filter((c) => c.community && !cs.some((x) => x.id === c.id));
    return keep.length === 0 ? cs : [...cs, ...keep];
  }, []);

  const syncChannels = useCallback(async (): Promise<ShoutChannel[]> => {
    const fresh = withCommunity(await fetchChannels(true));
    // Merge via ref, not inside a setState updater: React calls updaters during render, but the
    // result is needed now ("was I kicked", "is this id a foreign topic").
    const merged = mergeChannels(fresh, channelsRef.current);
    setChannels(merged);
    // Kicked from the room → go to the default room (a missing channel has an empty feed anyway).
    const cur = activeRef.current;
    if (cur && !merged.some((c) => c.slug === cur)) {
      const home = merged[0]?.slug ?? '';
      setActive(home);
      localStorage.setItem(CHAN_KEY, home);
    }
    return merged;
  }, [withCommunity, mergeChannels]);

  // "Message from an unknown channel" arrives via realtime (instant) and via the ping's highlight
  // map (minute fallback). One /channels fetch covers all accumulated ids. Ids still missing are
  // topics, not my rooms: remember them (don't refetch) and refresh the topic list instead.
  const chanSyncAtRef = useRef(0);
  const chanSyncTimerRef = useRef(0);
  const chanSyncWantRef = useRef<Set<string>>(new Set());
  const chanSyncSkipRef = useRef<Set<string>>(new Set());
  const unknownMessagesRef = useRef(new Map<string, ShoutMessage>());

  const runChannelSync = useCallback(async () => {
    chanSyncAtRef.current = Date.now();
    const want = chanSyncWantRef.current;
    chanSyncWantRef.current = new Set();
    const cs = await syncChannels();
    for (const c of cs) {
      const msg = unknownMessagesRef.current.get(c.id);
      if (msg && c.is_dm && msg.user !== meIdRef.current && !blockedRef.current.has(msg.user || '')) noteAttention(c.id, msg.created, true);
      unknownMessagesRef.current.delete(c.id);
    }
    while (unknownMessagesRef.current.size > 100) unknownMessagesRef.current.delete(unknownMessagesRef.current.keys().next().value!);
    let themes = false;
    want.forEach((id) => {
      if (cs.some((c) => c.id === id)) return;
      chanSyncSkipRef.current.add(id);
      themes = true;
    });
    if (themes) {
      setCommunitySideReload((n) => n + 1);
      setCommunityReload((n) => n + 1);
    }
  }, [syncChannels]);

  const runChannelSyncRef = useRef(runChannelSync);
  runChannelSyncRef.current = runChannelSync;

  const noteUnknownChannel = useCallback((chId?: string) => {
    if (!chId) return;
    if (chanSyncSkipRef.current.has(chId)) return;
    // List not loaded yet — everything would look "unknown"; the initial load effect handles it.
    if (channelsRef.current.length === 0) return;
    if (isCommunityChannel(chId)) return;
    if (channelsRef.current.some((c) => c.id === chId)) return;
    chanSyncWantRef.current.add(chId);
    const wait = CHAN_SYNC_GAP_MS - (Date.now() - chanSyncAtRef.current);
    if (wait <= 0) {
      void runChannelSyncRef.current();
      return;
    }
    if (chanSyncTimerRef.current) return;
    chanSyncTimerRef.current = window.setTimeout(() => {
      chanSyncTimerRef.current = 0;
      void runChannelSyncRef.current();
    }, wait);
  }, []);
  const noteUnknownChannelRef = useRef(noteUnknownChannel);
  noteUnknownChannelRef.current = noteUnknownChannel;

  useEffect(() => () => {
    if (chanSyncTimerRef.current) window.clearTimeout(chanSyncTimerRef.current);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    // New feed generation: previous room's loads are foreign now; also reset the pagination guard,
    // or a flag stuck across a room switch disables history loading forever.
    feedGenRef.current += 1;
    const gen = feedGenRef.current;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    anchorRef.current = null;
    setHasMore(true);
    setHasNewer(false);
    hasNewerRef.current = false;
    const chId = activeChannel?.id;
    const seen = chId ? loadChannelSeen()[chId] : undefined;
    if (chId) seenAtOpenRef.current = { ...seenAtOpenRef.current, [chId]: seen ?? 0 };
    const saved = chId ? readingPositionsRef.current.get(chId) : undefined;
    const isTopic = Boolean(activeChannel?.community);
    const forceLatest = forceLatestRef.current;
    forceLatestRef.current = false;
    const plan: EntryPlan = forceLatest
      ? { channelId: chId ?? '', kind: 'latest', applied: false, cancelled: false }
      : saved && !saved.atBottom
      ? { channelId: chId ?? '', kind: 'restore', targetId: saved.id, top: saved.top, applied: false, cancelled: false }
      : isTopic && !seen
        ? { channelId: chId ?? '', kind: 'thread-start', applied: false, cancelled: false }
        : seen
          ? { channelId: chId ?? '', kind: 'unread', applied: false, cancelled: false }
          : { channelId: chId ?? '', kind: 'latest', applied: false, cancelled: false };
    entryPlanRef.current = plan;
    atBottomRef.current = plan.kind === 'latest';
    setAtBottom(plan.kind === 'latest');
    if (isTopic) setOpCollapsed(plan.kind !== 'thread-start');

    // Stash the tail on leave, show it on enter; nothing remembered → clear explicitly (foreign
    // messages under a new title read as broken; a spinner doesn't). Empty key = don't cache (first
    // startup reload before the room is known).
    const key = chId ? `rooms:${chId}` : '';
    const prevKey = feedKeyRef.current;
    const cache = feedCacheRef.current;
    if (prevKey && prevKey !== key && messagesRef.current.length > 0) {
      // delete+set moves the entry to the end: Map keeps insertion order, so we evict the least
      // recently opened room.
      cache.delete(prevKey);
      cache.set(prevKey, messagesRef.current.slice(-SHOUT_PAGE));
      while (cache.size > FEED_CACHE_ROOMS) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    feedKeyRef.current = key;
    if (prevKey !== key) setMessages((key && cache.get(key)) || []);

    const initialIds = new Set(messagesRef.current.map((m) => m.id));
    try {
      let items: ShoutMessage[];
      let loadedHasNewer = false;
      let loadedHasMore = false;
      const loadUnreadWindow = async () => {
        if (!seen) return null;
        const newer = await fetchNewer(new Date(seen * 1000).toISOString(), chId, isDefaultChannel);
        if (newer.length === 0) return null;
        plan.targetId = newer[0].id;
        const older = await fetchMessages(newer[0].created, chId, isDefaultChannel);
        return {
          items: [...older.slice(-12), ...newer],
          hasMore: older.length >= SHOUT_PAGE,
          hasNewer: newer.length >= SHOUT_PAGE,
        };
      };
      if (plan.kind === 'restore' && plan.targetId) {
        try {
          const target = await fetchMessage(plan.targetId);
          if (!messageInChannel(target, chId, isDefaultChannel)) throw new Error('wrong channel');
          const [older, newer] = await Promise.all([
            fetchMessages(target.created, chId, isDefaultChannel),
            fetchNewer(target.created, chId, isDefaultChannel),
          ]);
          items = [...older.slice(-12), target, ...newer];
          loadedHasMore = older.length >= SHOUT_PAGE;
          loadedHasNewer = newer.length >= SHOUT_PAGE;
        } catch {
          // The anchor may have been deleted while away — forget it and apply the normal
          // unread/tail rule.
          if (chId) readingPositionsRef.current.delete(chId);
          const unread = await loadUnreadWindow();
          if (unread) {
            plan.kind = 'unread';
            items = unread.items;
            loadedHasMore = unread.hasMore;
            loadedHasNewer = unread.hasNewer;
          } else {
            plan.kind = 'latest';
            atBottomRef.current = true;
            setAtBottom(true);
            items = await fetchMessages(undefined, chId, isDefaultChannel);
            loadedHasMore = items.length >= SHOUT_PAGE;
          }
        }
      } else if (plan.kind === 'unread' && seen) {
        const unread = await loadUnreadWindow();
        if (unread) {
          items = unread.items;
          loadedHasMore = unread.hasMore;
          loadedHasNewer = unread.hasNewer;
        } else {
          plan.kind = 'latest';
          atBottomRef.current = true;
          setAtBottom(true);
          items = await fetchMessages(undefined, chId, isDefaultChannel);
          loadedHasMore = items.length >= SHOUT_PAGE;
        }
      } else {
        items = await fetchMessages(undefined, chId, isDefaultChannel);
        loadedHasMore = items.length >= SHOUT_PAGE;
      }
      // Startup reload may run twice (without channels, then with the restored room); drop the
      // previous generation's response or it can land second and show another room.
      if (gen !== feedGenRef.current) return;
      setMessages((cur) => {
        const ids = new Set(items.map((m) => m.id));
        const arrived = cur.filter((m) => !initialIds.has(m.id) && !ids.has(m.id)
          && messageInChannel(m, chId, isDefaultChannel));
        return [...items, ...arrived].sort((a, b) => a.created.localeCompare(b.created));
      });
      setHasMore(loadedHasMore);
      setHasNewer(loadedHasNewer);
      hasNewerRef.current = loadedHasNewer;
    } catch {
      if (gen === feedGenRef.current) setError('Could not load messages.');
    } finally {
      if (gen === feedGenRef.current) setLoading(false);
    }
  }, [activeChannel?.id, activeChannel?.community, isDefaultChannel]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Pins fetched on room change, login/logout (guests see different rooms) and after pinning — not
  // on a timer.
  const loadPins = useCallback(async () => {
    const chId = activeChannel?.id;
    // Room not restored yet → don't fetch pins. With empty `chId` the query went "all visible
    // rooms" and the amber strip flashed the site's only pin from another room on every reload.
    if (!chId) {
      setPins([]);
      return;
    }
    // Same generation check as the feed: a slow pins response for room A landed over room B.
    const gen = feedGenRef.current;
    try {
      const got = await fetchPinned(chId, isDefaultChannel);
      if (gen === feedGenRef.current) setPins(got);
    } catch {
      if (gen === feedGenRef.current) setPins([]);
    }
  }, [activeChannel?.id, isDefaultChannel]);

  useEffect(() => {
    loadPins();
  }, [loadPins, signedIn]);

  // Topic header: fetch the ROOM (OP lives on it), not the first message. Separate request: the
  // plain chat menu has no topics (shoutVisibleChannels), and a direct link has nowhere else to get
  // the OP. Permanent rooms get a header too (shoutCommunityFindPublic serves both); DMs/private
  // rooms are excluded here.
  const threadRoom = activeChannel
    && !activeChannel.is_dm && !activeChannel.is_private
    ? activeChannel
    : undefined;
  const threadRoomId = threadRoom?.id;
  useEffect(() => {
    if (!threadRoomId) {
      setThreadTopic(null);
      return;
    }
    // Clear the previous topic immediately, or switching topics shows the old header for a second.
    setThreadTopic((cur) => (cur && cur.id === threadRoomId ? cur : null));
    let alive = true;
    fetchCommunityRoom(threadRoomId).then((r) => {
      if (alive) setThreadTopic(r);
    });
    return () => { alive = false; };
  }, [threadRoomId]);

  // New topic: header expanded and feed opens ON it (the OP is read before the discussion).
  // Permanent room: header is a signboard — starts COLLAPSED, feed opens at the end.
  const threadIsTopic = Boolean(threadRoom?.community);
  useEffect(() => {
    setOpCollapsed(Boolean(threadRoomId) && !threadIsTopic);
    opHRef.current = 0;
    opModeRef.current = 'keep';
    opCalmRef.current = 0;
  }, [threadRoomId, threadIsTopic]);

  // Both in refs: the subscription lives for the page's lifetime and closes over the first render.
  const loadPinsRef = useRef(loadPins);
  loadPinsRef.current = loadPins;
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  // Realtime filtered by channel on the client: one collection subscription is cheaper than an SSE
  // channel per room (prod already hit an SSE storm). Current channel in a ref.
  const filterRef = useRef<{ id?: string; legacy: boolean }>({ legacy: false });
  filterRef.current = {
    id: activeChannel?.id,
    legacy: isDefaultChannel,
  };

  // Catch-up after a pause: while the pipe is closed (hidden tab, sleep, network) realtime events
  // are lost — the server does NOT store them. That's why a woken phone kept messages a moderator
  // deleted. Re-fetch the last page and replace our tail (removes deleted, applies edits, adds
  // missed); older scrolled-in history is kept.
  const lastCatchUpRef = useRef(0);
  const catchUp = useCallback(async () => {
    // Wake often fires twice (visible + timer) — skip the second.
    if (Date.now() - lastCatchUpRef.current < 3000) return;
    // Detached from the tail → nothing to catch up; the fresh page comes when they scroll down.
    if (hasNewerRef.current) return;
    lastCatchUpRef.current = Date.now();
    const gen = feedGenRef.current;
    try {
      const chId = activeChannel?.id;
      const page = await fetchMessages(undefined, chId, isDefaultChannel);
      if (gen !== feedGenRef.current || page.length === 0) return;
      // Snapshot AFTER the await: a realtime message that arrived during the wait (and isn't in the
      // server response) would briefly vanish.
      const snapshot = messagesRef.current;
      const edge = page[0].created;
      const fresh = new Set(page.map((m) => m.id));
      // No known message in the fresh window → slept more than a page; there's a gap. Don't splice
      // across it: show the server tail (plus realtime arrivals during the wait); history via
      // scroll-up.
      const tail = snapshot
        .filter((m) => m.created >= edge && !fresh.has(m.id))
        .sort((a, b) => a.created.localeCompare(b.created));
      if (snapshot.length && !snapshot.some((m) => fresh.has(m.id))) {
        setMessages([...page, ...tail]);
        setHasMore(true);
        return;
      }
      const merged = [
        ...snapshot.filter((m) => m.created < edge && !fresh.has(m.id)),
        ...page,
        ...tail,
      ];
      // Enforce the memory window here too; trim from the top and hold the view with the anchor.
      if (merged.length > WINDOW_MAX) {
        const cut = merged.slice(merged.length - WINDOW_MAX);
        anchorOn(cut[0].id);
        setMessages(cut);
        setHasMore(true);
        return;
      }
      setMessages(merged);
    } catch { }
  }, [activeChannel?.id, isDefaultChannel, anchorOn]);
  // Catch-up passed into the subscription by ref so a room change doesn't recreate it.
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // Realtime only while the tab is visible — for prod's sake: persistent SSE through Cloudflare
  // already took it down (spec §12v), and a hidden tab holds a dead pipe Cloudflare cuts on idle
  // anyway.
  const [awake, setAwake] = useState(() => (
    typeof document === 'undefined' || document.visibilityState === 'visible'
  ));
  const [wakeEpoch, setWakeEpoch] = useState(0);
  useEffect(() => {
    const onVis = () => setAwake(document.visibilityState === 'visible');
    const onWake = () => setWakeEpoch((n) => n + 1);
    // A laptop sleeping with the tab open sends no visibilitychange; detect sleep by a timer that
    // overslept its window (background tabs are throttled to ~1/min, hence the generous threshold).
    let last = Date.now();
    const t = window.setInterval(() => {
      const now = Date.now();
      const slept = now - last > 90_000;
      last = now;
      if (slept) onWake();
    }, 30_000);
    // pageshow only with persisted: a normal load sends it too.
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) onWake(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onWake);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onWake);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  const subscribedOnceRef = useRef(false);
  useEffect(() => {
    if (!awake) return undefined;
    let stop: (() => void) | undefined;
    let dead = false;
    // The first subscription is the page load (reload() just fetched); later ones are returns from
    // pause.
    if (subscribedOnceRef.current) catchUpRef.current();
    subscribedOnceRef.current = true;
    // Jitter before subscribing: when many tabs wake at once (laptop opened), spread the
    // reconnects.
    const t = window.setTimeout(() => {
      subscribeMessages((action, rec) => {
        if (dead) return;
        // Compute the signal HERE, not inside setMessages: React may run updaters more than once
        // and the sound would double.
        if (action === 'create') {
          noteRef.current(rec);
          // Message from a channel not in my list = new DM/invite; catch up the list now.
          if (rec.channel && !channelsRef.current.some((c) => c.id === rec.channel)) unknownMessagesRef.current.set(rec.channel, rec);
          noteUnknownChannelRef.current(rec.channel);
          const room = channelsRef.current.find((c) => c.id === rec.channel);
          const ownTopic = communityRef.current.some((c) => c.id === rec.channel && ((c.owner && c.owner === meIdRef.current) || c.mine));
          if (rec.user !== meIdRef.current && !blockedRef.current.has(rec.user || '') && (room?.is_dm || ownTopic || pingRef.current(rec))) {
            noteAttention(rec.channel || channelsRef.current[0]?.id || '', rec.created, !!room?.is_dm);
          }
          liveRef.current?.(rec);
          // "New here" came only with the ping (a minute late); the message is already in hand —
          // light it now.
          setChanLast((cur) => {
            const id = rec.channel || channelsRef.current[0]?.id;
            if (!id) return cur;
            const ts = pbDateMs(rec.created) / 1000;
            return (cur[id] ?? 0) >= ts ? cur : { ...cur, [id]: ts };
          });
          if (rec.channel && rec.user !== meIdRef.current
              && communityIdsRef.current.has(rec.channel)) {
            const id = rec.channel;
            setLiveLit((cur) => (cur[id] ? cur : { ...cur, [id]: true }));
            // Mention computed immediately too, else a plain dot silently turns into "@" a minute
            // later. Same criteria as the server: reply to me, @name, and for topics any reply to
            // its owner. Anonymous topic `mine` comes from the server (no owner in the record).
            const mine = communityRef.current.some(
              (c) => c.id === id && ((c.owner && c.owner === meIdRef.current) || c.mine));
            if (mine || pingRef.current(rec)) {
              setChanMentions((cur) => (cur.includes(id) ? cur : [...cur, id]));
            }
          }
          // Approximate "+N" on topics immediately (the ping corrects it within a minute). Only for
          // watched topics with an existing read mark (shoutChanState.newSince).
          if (rec.channel && rec.user !== meIdRef.current
              && watchRef.current.includes(rec.channel)) {
            const id = rec.channel;
            if ((loadChannelSeen()[id] ?? 0) > 0) {
              setChanNew((cur) => ({ ...cur, [id]: Math.min(50, (cur[id] ?? 0) + 1) }));
            }
          }
        }
        // Pin changed elsewhere → refetch pins: unpin arrives as the same update as a text edit,
        // and order/top-up to PINS_MAX is known only to the server.
        if (rec.pinned || pinsRef.current.some((p) => p.id === rec.id)) {
          loadPinsRef.current();
        }
        setMessages((cur) => {
          if (action === 'delete') return cur.filter((m) => m.id !== rec.id);
          if (action === 'update') return cur.map((m) => (m.id === rec.id ? rec : m));
          // Bottom dropped out of the window: the fresh message arrives as a page when the user
          // scrolls down.
          if (hasNewerRef.current) return cur;
          const { id, legacy } = filterRef.current;
          if (!messageInChannel(rec, id, legacy)) return cur;
          if (cur.some((m) => m.id === rec.id)) return cur;
          return [...cur, rec];
        });
      }).then((fn) => {
        if (dead) fn();
        else stop = fn;
      }).catch(() => { });
    }, Math.random() * 1500);
    return () => {
      dead = true;
      window.clearTimeout(t);
      stop?.();
    };
  }, [awake, wakeEpoch, user?.id]);

  const liveRoomRef = useRef<((e: CommunityRoomEvent) => void) | null>(null);
  const onLiveRoom = useCallback((fn: (e: CommunityRoomEvent) => void) => {
    liveRoomRef.current = fn;
    return () => { if (liveRoomRef.current === fn) liveRoomRef.current = null; };
  }, []);

  // Second realtime pipe for TOPIC records: likes, OP and creation live on the channel record, not
  // messages (hence "likes only after reload" and 5-minute-late new topics before). No schema/rule
  // changes needed: the channels listRule is open; DMs/private rooms are `is_private` and excluded
  // (see subscribeCommunityRooms).
  useEffect(() => {
    if (!awake || !community) return undefined;
    let stop: (() => void) | undefined;
    let dead = false;
    const t = window.setTimeout(() => {
      void subscribeCommunityRooms((e) => {
        if (dead) return;
        liveRoomRef.current?.(e);
        // The side column is refetched, not patched: its order is server-known; creation/removal is
        // rare and likes don't change it.
        if (e.action === 'create' || e.action === 'delete' || e.room.hidden) {
          sideBustRef.current = e.room.id;
          setCommunitySideReload((n) => n + 1);
        }
        // A new topic is unread by definition (except your own; for anonymous ones `mine` tells via
        // anon_key).
        if (e.action === 'create' && e.room.owner !== meIdRef.current && !e.room.mine) {
          noteCommunityIds([e.room.id]);
          setLiveLit((cur) => (cur[e.room.id] ? cur : { ...cur, [e.room.id]: true }));
        }
      }).then((fn) => {
        if (dead) fn();
        else stop = fn;
      }).catch(() => { });
    }, Math.random() * 1500);
    return () => {
      dead = true;
      window.clearTimeout(t);
      stop?.();
    };
  }, [awake, wakeEpoch, community, noteCommunityIds]);

  // Presence ping. Visibility is read by the server from the profile (`chat_hidden`). The ping
  // includes this device's push endpoint so the server won't push to the tab being watched. chat=1
  // requests channel highlights, ch=<id> clears mentions in the room being read — no separate
  // request on purpose. Hidden tabs don't ping; on return the effect fires immediately. Watched
  // topic ids in a ref (the ping has its own timer).
  const watchRef = useRef<string[]>([]);
  // Server caps the list (shoutWatchMax); the column goes first so it's cut last (always on
  // screen).
  const watchIds = useCallback((): string[] | undefined => {
    const out: string[] = [];
    const add = (id: string) => { if (id && !out.includes(id)) out.push(id); };
    channelsRef.current.forEach((c) => { if (c.community) add(c.id); });
    watchRef.current.forEach(add);
    return out.length ? out : undefined;
  }, []);
  const setWatchIds = useCallback((ids: string[]) => {
    watchRef.current = ids;
    noteCommunityIds(ids);
  }, [noteCommunityIds]);

  useEffect(() => {
    if (!awake) return undefined;
    let alive = true;
    const ping = async () => {
      // While the chat screen is open it owns presence (its ping is a superset of the header
      // icon's). Claim BEFORE fetching the push endpoint: that awaits the service worker, and in
      // those ms the header sent a duplicate ping.
      claimShared(PING_KEY);
      try {
        const openCh = openChannelsRef.current;
        const res = await pingPresence({
          chat: true,
          channel: openCh.length === 1 ? openCh[0] : undefined,
          endpoint: (await pushEndpoint()) ?? undefined,
          // Roster piggybacks on the ping while the panel is open; a separate 30 s poll would
          // double chat traffic per wide-window reader.
          roster: rosterRef.current,
          // Send the whole read map every time: the server needs it to tell whether this device
          // lags; it writes to the DB only if marks actually grew.
          seen: signedIn ? loadChannelSeen() : undefined,
          // Watched topics come from TWO places (always-visible side column + open index). The
          // server only knew one — hence dots lighting and vanishing by themselves: the ping
          // answers only for listed topics, and the frontend took that as the FULL picture, wiping
          // what realtime had set every minute.
          watch: watchIds(),
        });
        if (!alive) return;
        const merged = mergeChannelSeen(res.reads);
        if (merged) setChannelSeen(merged);
        setOnline(res.online);
        if (res.anonKey) {
          setAnonKey(res.anonKey);
          // Same key needed by the topic list: authors recognize their anonymous topics by it (no
          // owner in the record, communityApi.ts).
          setCommunityAnonKey(res.anonKey);
        }
        if (res.who) setWho((cur) => (sameWho(cur, res.who!) ? cur : res.who!));
        if (res.rest) setRest(res.rest);
        if (res.here) {
          setHere((cur) => (cur && sameWho(cur, res.here!) ? cur : res.here!));
          setHereMore(res.hereMore ?? 0);
        }
        // MERGE, don't replace: the ping is complete only for `watch` topics; replacing turned off
        // dots that realtime lit a minute ago. Last-message time only grows, so max-merge is safe.
        // Only set state if it changed (new objects every minute).
        setChanLast((cur) => mergeNumMap(cur, res.channels));
        // A highlight key missing from my list = a room/DM created while away (or a missed realtime
        // event) — second line of defense; slower but survives tab sleep.
        Object.keys(res.channels ?? {}).forEach((id) => noteUnknownChannelRef.current(id));
        // The server clears mentions by read marks from this same ping, but a mark set a second ago
        // arrives only next ping — so also don't re-light what my own data says is read.
        const seenNow = loadChannelSeen();
        const fresh = (res.mentions ?? []).filter((id) => {
          const seen = seenNow[id];
          return seen === undefined || seen < (res.channels?.[id] ?? 0);
        });
        setChanMentions((cur) => (sameStrings(cur, fresh) ? cur : fresh));
        setChanNew((cur) => (sameCounts(cur, res.newCounts) ? cur : res.newCounts));
      } catch {
      }
    };
    ping();
    const t = setInterval(ping, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  // signedIn in deps for the login moment: otherwise a user who just logged in appears in the list
  // only a minute later.
  }, [signedIn, awake, watchIds]);

  // A room nobody has written in emits no signal (invites to quiet private rooms, a just-created
  // public room), so the list is also re-read every 5 min and right after tab wake. Skip the first
  // run (the effect above just fetched).
  const chanPollFirstRef = useRef(true);
  useEffect(() => {
    if (!awake) return undefined;
    const poll = () => {
      // Forget "useless ids": that fetch may have failed, leaving a live DM stuck until reload.
      chanSyncSkipRef.current = new Set();
      void syncChannels();
      setCommunitySideReload((n) => n + 1);
    };
    if (chanPollFirstRef.current) chanPollFirstRef.current = false;
    else poll();
    const t = setInterval(poll, CHAN_POLL_MS);
    return () => clearInterval(t);
  }, [awake, wakeEpoch, signedIn, syncChannels]);

  const activeChannelId = activeChannel?.id;
  // Throttle read-mark writes: the effect fires on EVERY incoming message and each write is two
  // sync localStorage transactions — landing in typing frames in a busy chat.
  const seenWriteRef = useRef(0);
  useEffect(() => {
    // Mark read ONLY the open room (origin of "dots vanished, I never went there"), and only while
    // ACTUALLY visible: the topic index / new-topic form covers the feed while the room stays
    // `active` — a direct visit to /chat/threads used to mark General read. The same condition
    // gates `ch` in the ping (server clears mentions by it).
    const ids = activeChannelId && !midView ? [activeChannelId] : [];
    openChannelsRef.current = ids;
    if (ids.length === 0) return undefined;
    if (!awake || loading || hasNewer || !atBottomRef.current
      || readGapChannelRef.current === activeChannelId) return undefined;

    const latest = messagesRef.current.at(-1);
    if (latest && !messageInChannel(latest, activeChannelId, isDefaultChannel)) return undefined;
    if (latest && activeChannelId && latest.channel === activeChannelId) {
      readAttention(activeChannelId, latest.id, latest.created);
      void dismissChatNotifications(activeChannelId, pbDateMs(latest.created));
    }

    const mark = () => {
      seenWriteRef.current = Date.now();
      markChannelsSeen(ids, messagesRef.current.at(-1)?.created);
      // Read → clear live-lit and mentions locally too (server cleared only the channel open at
      // ping time; skimming 10 topics brought all "@"s back a minute later).
      setLiveLit((cur) => (ids.some((id) => cur[id])
        ? Object.fromEntries(Object.entries(cur).filter(([id]) => !ids.includes(id)))
        : cur));
      setChanMentions((cur) => (cur.some((id) => ids.includes(id))
        ? cur.filter((id) => !ids.includes(id))
        : cur));
      const next = loadChannelSeen();
      // Touch state only if at least one room dot changes: the mark grows with every message, and
      // setChannelSeen(loadChannelSeen()) re-rendered the whole screen per message.
      setChannelSeen((cur) => {
        const dotsChanged = Object.keys(next).some((id) => {
          const last = chanLast[id] ?? 0;
          return (last > (cur[id] ?? 0)) !== (last > (next[id] ?? 0));
        });
        return dotsChanged ? next : cur;
      });
    };
    // At most once per second; a trailing timer marks the last message of a burst.
    const wait = 1000 - (Date.now() - seenWriteRef.current);
    if (wait <= 0) {
      mark();
      return undefined;
    }
    const t = window.setTimeout(mark, wait);
    return () => window.clearTimeout(t);
  // atBottom in deps to RE-RUN (the gate reads a ref, which doesn't trigger effects); without it
  // the "new" dot stayed after the user scrolled back down.
  }, [activeChannelId, midView, messages, chanLast, atBottom, awake, loading, hasNewer, isDefaultChannel]);

  useEffect(() => {
    activePillRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active, channels.length]);

  // While chat is mounted it plays its own sound; the service worker asks us per push and skips the
  // system notification (it checks tab visibility itself).
  useEffect(() => {
    setChatOpen(true);
    setAttentionChatOpen(true);
    return () => { setChatOpen(false); setAttentionChatOpen(false); };
  }, []);

  useEffect(() => {
    const latest = messages.at(-1);
    setChatReading(awake && !midView && atBottom && !loading && !hasNewer && latest?.channel === activeChannelId ? activeChannelId ?? '' : '', latest ? pbDateMs(latest.created) : 0);
    return () => setChatReading('', 0);
  }, [activeChannelId, awake, midView, atBottom, loading, hasNewer, messages]);

  useEffect(() => {
    if (awake && signedIn) return listenAttentionNotifications();
  }, [awake, signedIn, user?.id]);

  // Load the roster when the panel APPEARS — three ways (popover, wide column, swipe panel). Only
  // `showWho` was wired before, so column and panel stayed empty ("79 here, nobody shows their
  // name"). One request on appear; then it rides the ping.
  useEffect(() => {
    if (!rosterOn) return undefined;
    let alive = true;
    fetchWho().then((r) => {
      if (!alive) return;
      setOnline(r.online);
      setWho((cur) => (sameWho(cur, r.who) ? cur : r.who));
      setRest({ guests: r.guests, hidden: r.hidden, cut: r.cut });
    }).catch(() => { });
    return () => { alive = false; };
  }, [rosterOn]);

  // "Who's in this topic": first roster needs its own ping on channel change (the minute ping
  // doesn't know about switches). Reset to undefined on switch so the section disappears instead of
  // showing the previous room.
  const soloChannel = activeChannel?.id ?? '';
  useEffect(() => {
    setHere(undefined);
    if (!rosterOn || !soloChannel) return undefined;
    let alive = true;
    pingPresence({ chat: true, channel: soloChannel, roster: true }).then((r) => {
      if (!alive || !r.here) return;
      setHere(r.here);
      setHereMore(r.hereMore ?? 0);
    }).catch(() => { });
    return () => { alive = false; };
  }, [rosterOn, soloChannel]);

  // Autoscroll only if already at bottom (a moving feed while reading history is worse than a
  // missed message).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Restore the anchored row in a layout effect, not rAF: rAF showed a frame with the shifted
    // feed, and on long history scroll "stuck" at the top, pulling page after page.
    if (anchorRef.current) {
      const { id, top } = anchorRef.current;
      anchorRef.current = null;
      const node = el.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      if (node) {
        const now = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += now - top;
        return;
      }
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        el.scrollTop = el.scrollHeight;
      } else {
        const chId = activeChannel?.id;
        const saved = chId ? readingPositionsRef.current.get(chId) : undefined;
        const node = saved
          ? el.querySelector<HTMLElement>(`[data-mid="${saved.id}"]`)
          : null;
        if (saved && node) {
          const current = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
          el.scrollTop += current - saved.top;
        }
      }
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setAtBottom(atBottomRef.current);
    });
    observer.observe(el);
    if (feedContentRef.current) observer.observe(feedContentRef.current);
    if (opRef.current) observer.observe(opRef.current);
    return () => observer.disconnect();
  }, [threadTopic?.id, activeChannel?.id]);

  // Memory-window cap on the realtime path: pagination trims itself, but live appends never did —
  // an evening-long tab accumulated thousands of DOM nodes. Trim from the top (hasMore=true again);
  // if reading history, hold the anchor. Runs AFTER anchor restore on purpose, or the same frame
  // eats the fresh anchor and the feed jumps.
  useLayoutEffect(() => {
    if (messages.length <= WINDOW_MAX) return;
    const cut = messages.slice(messages.length - WINDOW_MAX);
    if (!atBottomRef.current) anchorOn(cut[0].id);
    setMessages(cut);
    setHasMore(true);
  }, [messages, anchorOn]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loading || loadingOlderRef.current) return;
    const oldest = messages[0];
    if (!oldest) return;
    const gen = feedGenRef.current;
    loadingOlderRef.current = true;
    try {
      const chId = activeChannel?.id;
      const older = await fetchMessages(oldest.created, chId, isDefaultChannel);
      if (gen !== feedGenRef.current) return;
      if (older.length < SHOUT_PAGE) setHasMore(false);
      // Dedup by id: pages can overlap (same `created` at the boundary) and realtime may have
      // delivered some.
      const known = new Set(messages.map((m) => m.id));
      const add = older.filter((m) => !known.has(m.id));
      if (!add.length) return;
      anchorOn(oldest.id);
      // Window overflow → detach the bottom; pages bring it back when the user returns.
      if (messages.length + add.length > WINDOW_MAX) {
        setHasNewer(true);
        // Update the ref immediately: a realtime handler may fire before the re-render and splice a
        // message across the gap.
        hasNewerRef.current = true;
      }
      setMessages((cur) => {
        const merged = [...add, ...cur];
        return merged.length > WINDOW_MAX ? merged.slice(0, WINDOW_MAX) : merged;
      });
    } catch { } finally {
      // Only the owning generation clears the flag (reload already cleared it; don't clobber
      // another load).
      if (gen === feedGenRef.current) loadingOlderRef.current = false;
    }
  }, [hasMore, loading, messages, activeChannel?.id, isDefaultChannel, anchorOn]);

  const loadNewer = useCallback(async () => {
    if (!hasNewer || loadingNewerRef.current) return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    const gen = feedGenRef.current;
    loadingNewerRef.current = true;
    try {
      const chId = activeChannel?.id;
      const page = await fetchNewer(newest.created, chId, isDefaultChannel);
      if (gen !== feedGenRef.current) return;
      // A short page is the end: feed re-attached to the live tail, realtime takes over.
      if (page.length < SHOUT_PAGE) {
        setHasNewer(false);
        hasNewerRef.current = false;
      }
      const known = new Set(messages.map((m) => m.id));
      const add = page.filter((m) => !known.has(m.id));
      if (!add.length) return;
      anchorOn(newest.id);
      if (messages.length + add.length > WINDOW_MAX) setHasMore(true);
      setMessages((cur) => {
        const merged = [...cur, ...add];
        return merged.length > WINDOW_MAX ? merged.slice(merged.length - WINDOW_MAX) : merged;
      });
    } catch { } finally {
      if (gen === feedGenRef.current) loadingNewerRef.current = false;
    }
  }, [hasNewer, messages, activeChannel?.id, isDefaultChannel, anchorOn]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // The topic header scrolls inside the feed. When less of it remains than the collapsed view's
    // height, swap to collapsed (same on-screen height → invisible swap). Near the top it expands
    // again like the first message of the topic.
    const op = opRef.current;
    if (op && Date.now() > opCalmRef.current) {
      if (!opCollapsedRef.current) {
        const tail = op.getBoundingClientRect().bottom - el.getBoundingClientRect().top;
        if (tail <= OP_TAIL_MIN) collapseOpRef.current('keep');
      } else if (el.scrollTop <= 0) {
        collapseOpRef.current('open');
      }
    }
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = fromBottom < 60;
    setAtBottom((cur) => (cur === atBottomRef.current ? cur : atBottomRef.current));
    captureReadingPosition(activeChannel?.id);
    // Different thresholds: history at the very edge, tail early. While the OP is expanded don't
    // load history: a topic opens on the post at scroll 0, which would otherwise trigger history
    // loads on every move while reading it.
    if (!(op && !opCollapsedRef.current) && el.scrollTop <= 80) loadOlder();
    if (fromBottom < 400) loadNewer();
  }, [loadOlder, loadNewer, captureReadingPosition, activeChannel?.id]);

  const jumpToBottom = useCallback(() => {
    readGapChannelRef.current = '';
    atBottomRef.current = true;
    setAtBottom(true);
    // Detached from the tail: fetch the fresh page directly (one request instead of ten catch-up
    // pages).
    if (hasNewerRef.current) {
      forceLatestRef.current = true;
      reload();
      return;
    }
    const el = listRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [reload]);

  const cancelInitialPosition = useCallback(() => {
    const plan = entryPlanRef.current;
    if (plan && !plan.applied) plan.cancelled = true;
  }, []);

  const submitMessage = useCallback(async (
    t: string,
    opts: { image: File | null; anon: boolean },
  ): Promise<boolean> => {
    setError('');
    // Edit uses its own handler: creates nothing, no mention notifications; image untouched, so
    // empty text only if the message has an image.
    if (editing) {
      try {
        await editOwnMessage(editing.id, t, loadDelPasses()[editing.id]);
        setMessages((cur) => cur.map((x) => (
          x.id === editing.id ? { ...x, text: t, edited: true } : x)));
        setEditing(null);
        return true;
      } catch (e) {
        const msg = (e as { response?: { message?: string } })?.response?.message;
        setError(msg || 'Edit not saved. Try again.');
        return false;
      }
    }
    // Secret for every anonymous message (guest or masked account); anon_key is a public IP-based
    // label, not ownership.
    const delPass = (!signedIn || opts.anon) ? makeDelPass() : undefined;
    const gen = feedGenRef.current;
    try {
      const newId = await postMessageV2(t, {
        channel: active || undefined,
        replyTo: replyTo?.id,
        anon: signedIn ? opts.anon : undefined,
        delPass,
        image: opts.image,
      });
      // Bind the password to the id the handler returned. It used to wait for realtime and pick "my
      // last by anon_key" — many people share an IP, and realtime could arrive before the password
      // was even in the ref.
      if (delPass && newId) rememberDelPass(newId, delPass);
      if (gen !== feedGenRef.current) return true;
      setReplyTo(null);
      atBottomRef.current = true;
      setAtBottom(true);
      anchorRef.current = null;
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      // Sent while detached in history: realtime won't bring our own message into that feed — go
      // back to the live tail.
      if (hasNewerRef.current) {
        forceLatestRef.current = true;
        await reload();
      } else if (newId) {
        try {
          const sent = await fetchMessage(newId);
          if (gen === feedGenRef.current) {
            setMessages((cur) => cur.some((m) => m.id === sent.id) ? cur
              : [...cur, sent].sort((a, b) => a.created.localeCompare(b.created)));
          }
        } catch {
          if (gen === feedGenRef.current) await reload();
        }
      }
      return true;
    } catch (e) {
      const msg = (e as { response?: { message?: string } })?.response?.message;
      setError(msg || 'Message not sent. Try again.');
      return false;
    }
  }, [editing, signedIn, active, replyTo, reload]);

  // `passes` computed outside: localStorage + JSON.parse per row costs more than the check.
  const canDelete = useCallback((m: ShoutMessage, passes: Record<string, string>): boolean => {
    if (m.kind === 'system') return false;
    if (signedIn && user && m.user === user.id) return true;
    return Boolean(passes[m.id]);
  }, [signedIn, user]);

  const removeOwn = useCallback(async (m: ShoutMessage) => {
    try {
      await deleteOwnMessage(m.id, loadDelPasses()[m.id]);
      forgetDelPass(m.id);
      setMessages((cur) => cur.filter((x) => x.id !== m.id));
    } catch {
      setError('Could not delete — the message may no longer count as yours.');
    }
  }, []);

  // Moderator-only buttons, both with confirmation: delete is irreversible, mute hits a live
  // person; a mis-tap on the phone mustn't do either.
  const modRemove = useCallback(async (m: ShoutMessage) => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await deleteMessage(m.id);
      forgetDelPass(m.id);
      setMessages((cur) => cur.filter((x) => x.id !== m.id));
    } catch {
      setError('Could not delete the message.');
    }
  }, []);

  const modMute = useCallback(async (m: ShoutMessage) => {
    if (!window.confirm('Mute the author of this message for 24 hours?')) return;
    try {
      await muteMessageSource(m.id);
      setError('Author muted for 24 hours.');
    } catch {
      setError('Could not mute the author.');
    }
  }, []);

  // Mutes live in server memory and aren't exposed, so unmute is a separate action (the button
  // can't show "pressed"). Before this, a wrong mute was undone only by a server restart.
  const modUnmute = useCallback(async (m: ShoutMessage) => {
    if (!window.confirm('Lift the mute from the author of this message?')) return;
    try {
      await unmuteMessageSource(m.id);
      setError('Mute lifted.');
    } catch {
      setError('Could not lift the mute.');
    }
  }, []);

  const togglePin = useCallback(async (m: ShoutMessage) => {
    const next = !m.pinned;
    try {
      await pinMessage(m.id, next);
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, pinned: next } : x)));
      // Update the pin strip optimistically; the realtime echo refetches and reconciles order and
      // others' unpins.
      setPins((cur) => (next
        ? [{ ...m, pinned: true }, ...cur.filter((x) => x.id !== m.id)]
        : cur.filter((x) => x.id !== m.id)));
    } catch {
      setError('Could not pin the message.');
    }
  }, []);

  // Reactions are NOT optimistic: a shared counter drawn before the answer diverges from concurrent
  // clicks. Replace with the server's map; others get it via the realtime echo.
  const toggleReaction = useCallback(async (m: ShoutMessage, emoji: string) => {
    try {
      const reactions = await reactToMessage(m.id, emoji);
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, reactions } : x)));
    } catch {
      setError('Could not save the reaction.');
    }
  }, []);

  // Edit rights = delete rights. Nobody edits system messages, including moderators (they're facts,
  // e.g. "game released").
  const canEdit = useCallback(
    (m: ShoutMessage, passes: Record<string, string>): boolean => (
      m.kind !== 'system' && canDelete(m, passes)
    ),
    [canDelete],
  );

  // Row handlers must be stable: MessageRow compares props; a new function per render kills feed
  // memoization.
  const toggleTouched = useCallback((m: ShoutMessage) => {
    setTouched((cur) => (cur === m.id ? null : m.id));
  }, []);
  const replyToMessage = useCallback((m: ShoutMessage) => {
    setReplyTo(m);
    composerRef.current?.focus();
  }, []);

  const insertMention = useCallback((username: string) => {
    composerRef.current?.insertMention(username);
  }, []);

  // On-screen keyboard: phones overlay it WITHOUT telling layout (window height and 100dvh
  // unchanged), so the composer either hides under it or floats above with a gap. visualViewport
  // tells the visible band; the difference is the keyboard, and we shrink the chat by it. Android
  // usually doesn't need this: `interactive-widget=resizes-content` in index.html resizes the
  // window itself. This is for iOS and others that ignore the hint.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const apply = () => {
      const gap = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      // Threshold: URL bar/toolbars also shift the visible band by tens of px.
      setKbInset(gap > 80 ? gap : 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);

  // Chat got shorter — keep a bottom-pinned reader at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [kbInset]);

  // Images load after the row renders and push the feed (height unknown in advance). Bottom-pinned
  // readers are handled here; history readers by the shared ResizeObserver above. Browser scroll
  // anchoring (overflow-anchor) is explicitly disabled on the feed: Safari lacks it and in Chrome
  // it stacks with our correction (double shift).
  const onImgLoad = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  // History readers are handled by the shared ResizeObserver; correcting here too would
  // double-compensate.
  }, []);

  // Collapse and expand share one path: height must be measured BEFORE relayout.
  const toggleOp = useCallback((mode: 'keep' | 'jump' | 'top' | 'open') => {
    opHRef.current = opRef.current?.offsetHeight ?? 0;
    opModeRef.current = mode === 'open' ? 'keep' : mode;
    setOpCollapsed(mode === 'keep' || mode === 'jump');
  }, []);
  // onScroll lives for the screen's lifetime and calls the toggler via ref, not closure — else the
  // handler is recreated and loses an in-progress scroll.
  const collapseOpRef = useRef(toggleOp);
  collapseOpRef.current = toggleOp;

  // Header swap changed the feed length by the height difference; compensate or comments jump by a
  // whole post height right when reached.
  useLayoutEffect(() => {
    const el = listRef.current;
    const op = opRef.current;
    if (!el || !op) return;
    const prev = opHRef.current;
    opHRef.current = op.offsetHeight;
    if (!prev) return;
    const mode = opModeRef.current;
    opModeRef.current = 'keep';
    if (mode === 'top') {
      el.scrollTop = 0;
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setAtBottom(atBottomRef.current);
      return;
    }
    if (mode === 'jump') {
      el.scrollTop = el.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      return;
    }
    const grew = opHRef.current > prev;
    el.scrollTop = Math.max(0, el.scrollTop - (prev - opHRef.current) - (grew ? OP_UNFOLD_NUDGE : 0));
    if (grew) {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      setAtBottom(atBottomRef.current);
    }
    // A short quiet period after swap in both directions: the threshold leaves the feed exactly at
    // the boundary, and the next scroll event would swap back (post see-saws under the finger).
    opCalmRef.current = Date.now() + 350;
  }, [opCollapsed]);

  // Single initial-positioning point, applied only once target rows (and the header for new topics)
  // are in the DOM. Any user gesture cancels pending positioning: a slow image/network must not
  // yank the screen later.
  useLayoutEffect(() => {
    const plan = entryPlanRef.current;
    const el = listRef.current;
    if (!plan || plan.applied || plan.cancelled || loading || !el) return;
    if (plan.channelId !== (activeChannel?.id ?? '')) return;

    if (plan.kind === 'thread-start') {
      if (!opRef.current) return;
      el.scrollTop = 0;
    } else if (plan.kind === 'latest') {
      el.scrollTop = el.scrollHeight;
    } else {
      const node = plan.targetId
        ? el.querySelector<HTMLElement>(`[data-mid="${plan.targetId}"]`)
        : null;
      if (!node) return;
      const current = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // For unread, keep ~5 lines of previous conversation visible; the NEW divider and target row
      // stay below the header.
      const wanted = plan.kind === 'unread' ? 100 : (plan.top ?? 0);
      el.scrollTop += current - wanted;
    }
    plan.applied = true;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setAtBottom(atBottomRef.current);
    captureReadingPosition(activeChannel?.id);
  }, [activeChannel?.id, loading, messages, threadTopic?.id, opCollapsed,
    captureReadingPosition]);

  // Index/topic editor temporarily replace the feed in the same tab: save the anchor before unmount
  // and restore on return without a network reload.
  useLayoutEffect(() => {
    if (midView || !activeChannelId) return undefined;
    return () => captureReadingPosition(activeChannelId);
  }, [midView, activeChannelId, captureReadingPosition]);

  const previousMidViewRef = useRef(midView);
  useLayoutEffect(() => {
    const previous = previousMidViewRef.current;
    previousMidViewRef.current = midView;
    if (!previous || midView || !activeChannelId) return;
    const saved = readingPositionsRef.current.get(activeChannelId);
    const el = listRef.current;
    if (!saved || saved.atBottom || !el) {
      if (saved?.atBottom && el) el.scrollTop = el.scrollHeight;
      return;
    }
    const node = el.querySelector<HTMLElement>(`[data-mid="${saved.id}"]`);
    if (!node) return;
    const current = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
    el.scrollTop += current - saved.top;
    atBottomRef.current = false;
    setAtBottom(false);
  }, [midView, activeChannelId]);

  // Composer grew (reply strip, expanded) → feed got shorter; restore bottom for bottom-pinned
  // readers only.
  const onComposerResize = useCallback(() => {
    const el = listRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  // Edit in the shared composer, not an inline editor: it already has the length counter,
  // @autocomplete and Ctrl+Enter. The composer fills itself when `editing` changes.
  const startEdit = useCallback((m: ShoutMessage) => {
    setReplyTo(null);
    setEditing(m);
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  // OP editable by topic owner and moderators (mirrors shoutCommunityCanEditOp; server has the
  // final say). Permanent rooms have no owner — moderators only.
  const canEditThreadOp = Boolean(
    threadTopic && (canModerateChat
      || (user?.id && threadTopic.owner === user.id)
      // Own anonymous topic: no owner in the record; the server decides "mine".
      || (threadTopic.anon && threadTopic.mine)),
  );
  const blurThreadImages = rating === 'sfw' && Boolean(
    threadTopic && (threadTopic.tags ?? []).includes('nsfw'),
  );

  useEffect(() => {
    if (!blurThreadImages || !threadTopic || viewPrefs.nsfwWarningDismissed
      || nsfwApprovedRef.current.has(threadTopic.id)) return;
    setNsfwGateRoom((cur) => cur?.id === threadTopic.id ? cur : threadTopic);
  }, [blurThreadImages, threadTopic, viewPrefs.nsfwWarningDismissed]);


  const cancelReply = useCallback(() => setReplyTo(null), []);

  // Switching rooms ends the edit (it points to a SPECIFIC message and Composer doesn't know rooms:
  // the "editing" header hung over the new feed and send silently rewrote a message from the
  // previous room). Replies are saved per-room by Composer's drafts — don't reset here.
  useEffect(() => {
    setEditing(null);
  }, [activeChannelId]);

  // Jump to the replied-to message by data-mid. The parent may be outside the WINDOW_MAX window —
  // say so explicitly (a no-op click reads as broken).
  const jumpTo = useCallback((id: string) => {
    const el = listRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!node) {
      setError('That message is too far back — scroll up to load it.');
      return;
    }
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Flash via Web Animations API, not React state: highlighting one row isn't worth re-rendering
    // the feed.
    try {
      node.animate(
        [
          { backgroundColor: 'rgba(252,52,71,0.28)' },
          { backgroundColor: 'rgba(252,52,71,0.28)', offset: 0.55 },
          { backgroundColor: 'rgba(252,52,71,0)' },
        ],
        { duration: 1400, easing: 'ease-out' },
      );
    } catch {
    }
  }, []);

  // Returns whether the pin was found in the memory window; if not the strip shows the pin's text
  // (pins are old by nature).
  const goToPin = useCallback((m: ShoutMessage): boolean => {
    if (!listRef.current?.querySelector(`[data-mid="${m.id}"]`)) return false;
    jumpTo(m.id);
    return true;
  }, [jumpTo]);

  // Up-arrow in an empty composer edits your last message (messenger habit); "own" = same rule as
  // the edit button, incl. guest delete password.
  const editLast = useCallback(() => {
    const passes = loadDelPasses();
    const list = messagesRef.current;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (canEdit(list[i], passes)) {
        startEdit(list[i]);
        return;
      }
    }
  }, [canEdit, startEdit]);

  const showProfile = useCallback((anchor: HTMLElement, id: string) => {
    setProfileAnchor(anchor);
    // Whose card we're showing: a slow response for Alice arriving after clicking Bob would paint
    // Alice's data into Bob's card.
    profileWantRef.current = id;
    const cached = profileCache.current[id];
    if (cached) { setProfile(cached); return; }
    setProfile(null);
    fetchProfile(id).then((p) => {
      if (!p) return;
      profileCache.current[id] = p;
      if (profileWantRef.current === id) setProfile(p);
    });
  }, []);

  const openProfile = useCallback((e: React.MouseEvent<HTMLElement>, m: ShoutMessage) => {
    const u = m.expand?.user;
    if (!u) return;
    if (!PROFILE_POPOVER) {
      if (u.username) insertMention(u.username);
      return;
    }
    showProfile(e.currentTarget, u.id);
  }, [insertMention, showProfile]);

  // Member-list clicks always open the card (regardless of PROFILE_POPOVER): the list exists to
  // message people.
  const openProfileById = useCallback((e: React.MouseEvent<HTMLElement>, id: string) => {
    showProfile(e.currentTarget, id);
  }, [showProfile]);

  const openChannel = useCallback((slug: string) => {
    captureReadingPosition(activeChannel?.id);
    if (explicitNavigationRef.current) explicitNavigationRef.current = false;
    else readGapChannelRef.current = '';
    setActive(slug);
    localStorage.setItem(CHAN_KEY, slug);
    // Opening a room clears the center (index/unfinished topic); ThreadComposer keeps the draft in
    // localStorage for exactly this (room switches by swipe mid-typing on phones).
    setMidView(null);
  }, [activeChannel?.id, captureReadingPosition]);

  // Topic from the full list: add it to channels first, or the feed has nothing to load.
  const enterCommunityRoom = useCallback((room: CommunityRoom) => {
    const ch = communityAsChannel(room);
    setChannels((cur) => (cur.some((c) => c.id === ch.id) ? cur : [...cur, ch]));
    openChannel(ch.slug);
  }, [openChannel]);

  const openCommunityRoom = useCallback((room: CommunityRoom) => {
    const nsfw = (room.tags ?? []).includes('nsfw');
    if (rating === 'sfw' && nsfw && !viewPrefs.nsfwWarningDismissed
      && !nsfwApprovedRef.current.has(room.id)) {
      setNsfwGateRoom(room);
      return;
    }
    setNsfwGateRoom(null);
    enterCommunityRoom(room);
  }, [enterCommunityRoom, rating, viewPrefs.nsfwWarningDismissed]);

  useEffect(() => {
    if (rating !== 'sfw') setNsfwGateRoom(null);
  }, [rating]);

  const declineNsfwRoom = useCallback(() => {
    setNsfwGateRoom(null);
    const safe = channels.find((c) => !c.community)?.slug;
    if (safe) openChannel(safe);
    setMidView('list');
  }, [channels, openChannel]);

  // URL `/chat/r/<slug>` or `/chat/t/<slug>` beats the remembered room. Wait for channels: on an
  // empty list "no such room" and "not loaded" are indistinguishable.
  const routeDoneRef = useRef('');
  // Until the URL slug is resolved, BLOCK the reverse (state → URL) write: on first render the LAST
  // room from localStorage is open and would overwrite `/chat/t/foreign-topic` with
  // `/chat/r/general`. Also the only guard against URL↔room ping-pong: Back puts the PREVIOUS room
  // in the URL while the old one is still open; any channel-list update (realtime, minute ping)
  // wakes the reverse write, which restores the old room, the server answer restores the new one…
  // the chat flips between two topics several times a second. While resolving, the URL wins.
  const [routeReady, setRouteReady] = useState(!routeSlug);
  // Resolution counter in a ref, not effect cancellation: the effect also reruns on channel-list
  // changes, and cancelling in cleanup would leave `routeReady = false` forever.
  const routeTokenRef = useRef(0);
  useEffect(() => {
    const slug = (routeSlug || '').trim();
    if (!slug) { routeDoneRef.current = ''; setRouteReady(true); return; }
    if (channels.length === 0 || routeDoneRef.current === slug) return;
    routeDoneRef.current = slug;
    const known = channels.find((c) => c.slug === slug);
    if (known) {
      openChannel(slug);
      setRouteReady(true);
      return;
    }
    // The column has a dozen topics; a link may point to any of thousands — fetch by slug. Not
    // found → stay put silently.
    const my = ++routeTokenRef.current;
    setRouteReady(false);
    void fetchCommunityRoom(slug).then((room) => {
      if (routeTokenRef.current !== my) return;
      if (room) {
        openCommunityRoom(room);
      } else {
        setError('That conversation is no longer available.');
      }
      setRouteReady(true);
    });
  }, [routeSlug, channels, openChannel, openCommunityRoom, rating]);

  const prevThreadsRef = useRef(startThreads);
  useEffect(() => {
    if (prevThreadsRef.current === startThreads) return;
    prevThreadsRef.current = startThreads;
    setMidView(startThreads ? 'list' : null);
  }, [startThreads]);

  // Previous URL/state snapshot to tell apart two mismatches that look the same: link opened from
  // outside (we wait) vs section closed inside chat (we write). Whoever changed last wins.
  const routeSyncRef = useRef({ threads: startThreads, list: false });

  // NEVER put DMs/private rooms in the URL: the slug would end up in history, tab title and the
  // referer of the next opened image.
  useEffect(() => {
    if (!onRouteChange) return;
    const listOpen = midView === 'list';
    const prevSync = routeSyncRef.current;
    routeSyncRef.current = { threads: startThreads, list: listOpen };
    // While the URL is resolving, silence ALL write directions (else we overwrite the URL being
    // processed). First check, before sections.
    if (!routeReady) return;
    // URL came from outside and state hasn't absorbed it yet (`/chat/threads` prop vs
    // setMidView('list') next frame). In between, the reverse write saw "section closed" and wrote
    // the room back → loop between `/chat/threads` and `/chat/r/<room>` several times a second.
    // Only reproduced when a room-list update landed in that same frame.
    if (startThreads !== listOpen && prevSync.threads !== startThreads) return;
    if (listOpen) {
      onRouteChange(CHAT_THREADS_PATH, {
        back: !prevSync.list && !startThreads && Boolean(channels.find((c) => c.slug === active)?.community),
      });
      return;
    }
    // An unfinished topic gets no URL (the draft is local); keep the index URL it was entered from.
    if (midView === 'compose') return;
    if (!active) {
      onRouteChange('/chat');
      return;
    }
    const ch = channels.find((c) => c.slug === active);
    if (!ch) return;
    onRouteChange(
      ch.is_dm || ch.is_private ? '/chat'
        : `${ch.community ? '/chat/t/' : '/chat/r/'}${ch.slug}`,
      { push: Boolean(ch.community && prevSync.list) },
    );
  // startThreads in deps is required: otherwise the effect doesn't wake on external URL changes and
  // "who changed last" is computed from a stale snapshot.
  }, [active, channels, onRouteChange, midView, routeReady, startThreads]);

  // Jump from a "replied in chat" notification: same jumpTo as quote clicks, but may need to switch
  // rooms and wait for the feed first.
  const jumpTokenRef = useRef(0);
  // Which topic we already fetched for the jump (the effect reruns per feed render; avoid request
  // bursts).
  const jumpFetchRef = useRef('');
  const pendingJumpRef = useRef<{ messageId: string; channelId?: string } | null>(null);

  useEffect(() => {
    if (!jumpTarget || jumpTarget.token === jumpTokenRef.current) return;
    jumpTokenRef.current = jumpTarget.token;
    jumpFetchRef.current = '';
    if (entryPlanRef.current) entryPlanRef.current.cancelled = true;
    setOpCollapsed(true);
    explicitNavigationRef.current = true;
    readGapChannelRef.current = jumpTarget.channelId || activeChannel?.id || '';
    pendingJumpRef.current = { messageId: jumpTarget.messageId, channelId: jumpTarget.channelId };
  }, [jumpTarget, activeChannel?.id]);

  useEffect(() => {
    const pending = pendingJumpRef.current;
    if (!pending) return;

    if (pending.channelId) {
      const targetChannel = channels.find((c) => c.id === pending.channelId);
      if (!targetChannel) {
        if (channels.length === 0) return;
        // A notification may point to a TOPIC not in the column (dozen of thousands) — waiting
        // forever meant "replied in your topic" did nothing. Fetch by id like `/chat/t/<slug>`.
        const want = pending.channelId;
        if (jumpFetchRef.current === want) return;
        jumpFetchRef.current = want;
        void fetchCommunityRoom(want).then((room) => {
          if (pendingJumpRef.current !== pending) return;
          // Topic gone → abandon the jump so the next notification works.
          if (!room) {
            pendingJumpRef.current = null;
            explicitNavigationRef.current = false;
            readGapChannelRef.current = '';
            setError('That conversation or message is no longer available.');
            return;
          }
          openCommunityRoom(room);
        });
        return;
      }
      if (active !== targetChannel.slug) {
        openChannel(targetChannel.slug);
        return;
      }
    }

    if (loading) return;
    if (!pending.messageId) {
      pendingJumpRef.current = null;
      explicitNavigationRef.current = false;
      jumpToBottom();
      return;
    }
    const node = listRef.current?.querySelector(`[data-mid="${pending.messageId}"]`);
    if (node) {
      pendingJumpRef.current = null;
      jumpFetchRef.current = '';
      explicitNavigationRef.current = false;
      jumpTo(pending.messageId);
      return;
    }

    // Links can point far beyond the memory window: load context around the record rather than
    // making the user page through hundreds.
    const fetchKey = `message:${pending.messageId}`;
    if (jumpFetchRef.current === fetchKey) return;
    jumpFetchRef.current = fetchKey;
    const gen = feedGenRef.current;
    void fetchMessage(pending.messageId).then(async (target) => {
      if (pendingJumpRef.current !== pending || gen !== feedGenRef.current) return;
      if (!messageInChannel(target, activeChannel?.id, isDefaultChannel)) throw new Error('wrong channel');
      const [older, newer] = await Promise.all([
        fetchMessages(target.created, activeChannel?.id, isDefaultChannel),
        fetchNewer(target.created, activeChannel?.id, isDefaultChannel),
      ]);
      if (pendingJumpRef.current !== pending || gen !== feedGenRef.current) return;
      setMessages([...older.slice(-12), target, ...newer]);
      setHasMore(older.length >= SHOUT_PAGE);
      const moreBelow = newer.length >= SHOUT_PAGE;
      setHasNewer(moreBelow);
      hasNewerRef.current = moreBelow;
      jumpFetchRef.current = '';
    }).catch(() => {
      if (pendingJumpRef.current !== pending) return;
      pendingJumpRef.current = null;
      jumpFetchRef.current = '';
      explicitNavigationRef.current = false;
      readGapChannelRef.current = '';
      setError('That message was deleted or is not available to you.');
    });
  }, [channels, active, activeChannel?.id, loading, messages, isDefaultChannel,
    openChannel, jumpTo, openCommunityRoom, jumpTarget, jumpToBottom]);

  // Room list changed: refetch rather than patching state (membership may change; on leave the room
  // vanishes).
  const refreshChannels = useCallback(async (goTo?: string) => {
    const cs = withCommunity(await fetchChannels(true));
    setChannels(cs);
    if (goTo && cs.some((c) => c.slug === goTo)) openChannel(goTo);
    else if (!cs.some((c) => c.slug === active)) openChannel(cs[0]?.slug ?? '');
  }, [active, openChannel, withCommunity]);

  // Via ref so block handlers declared above can trigger it.
  const refreshChannelsRef = useRef(refreshChannels);
  refreshChannelsRef.current = refreshChannels;

  // "Message" from a profile card: the server finds-or-creates the DM; the frontend keeps no DM
  // list.
  const [elsewhereNew, elsewhereMention] = useMemo(() => {
    let any = false;
    let mention = false;
    channels.forEach((c) => {
      if (c.slug === active) return;
      if (chanMentions.includes(c.id)) { any = true; mention = true; return; }
      if (channelHasNew(c.id)) any = true;
    });
    return [any, mention];
  }, [channels, active, chanMentions, channelHasNew]);

  // Panel width by the SHELL, not window: on tablets chat is a column mid-page.
  const panelWidth = useCallback(() => {
    const w = shellRef.current?.clientWidth ?? window.innerWidth;
    return Math.round(Math.min(240, Math.max(150, w * 0.38)));
  }, []);

  // The only place the panel moves: style written directly, bypassing React — it follows the finger
  // per frame; re-rendering the feed at 60 fps is not an option.
  const applyPanel = useCallback((x: number, animate: boolean) => {
    const w = panelWidth();
    panelWRef.current = w;
    // One coordinate for both panels (positive = rooms left, negative = members right), so they
    // never fight over the gesture.
    const at = Math.max(-w, Math.min(w, x));
    const t = animate ? 'transform .22s cubic-bezier(.2,.7,.3,1)' : 'none';
    if (panelRef.current) {
      panelRef.current.style.transition = t;
      panelRef.current.style.transform = `translateX(${Math.min(0, Math.max(-w, at - w))}px)`;
    }
    if (membersRef.current) {
      membersRef.current.style.transition = t;
      membersRef.current.style.transform = `translateX(${Math.max(0, Math.min(w, w + at))}px)`;
    }
    if (colRef.current) {
      colRef.current.style.transition = t;
      colRef.current.style.transform = `translateX(${at}px)`;
    }
  }, [panelWidth]);

  const openSide = useCallback((s: PanelSide) => {
    sideRef.current = s;
    setSide(s);
    const w = panelWidth();
    applyPanel(s === 'rooms' ? w : s === 'members' ? -w : 0, true);
  }, [applyPanel, panelWidth]);

  // The idle history entry under the panel was pushed by US and still exists. A flag in the entry
  // won't do: it survives F5 but our right to pop it doesn't ("back" after reload would leave the
  // site).
  const panelEntryRef = useRef(false);

  // Actions that change the URL first pop the panel's idle entry: it sits ON TOP of the real chat
  // entry holding the URL at panel-open time. A room switch uses replace, landing on the idle
  // entry, leaving the previous room below — Back walked through rooms instead of leaving chat (the
  // "ladder"). Order via popstate, not "back() then act": back is async, the action would write the
  // URL before the pop and the pop would restore the old room.
  const withoutPanelEntry = useCallback((fn: () => void) => {
    openSide(null);
    if (!panelEntryRef.current) { fn(); return; }
    panelEntryRef.current = false;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      window.removeEventListener('popstate', run);
      fn();
    };
    window.addEventListener('popstate', run);
    // Safety: if popstate never comes, still perform the action (with an extra history entry).
    window.setTimeout(run, 500);
    window.history.back();
  }, [openSide]);

  // Gesture: drag right → rooms, left → members; anywhere EXCEPT edge strips (system back/forward
  // gestures own them).
  useEffect(() => {
    if (!narrow) return;
    const el = shellRef.current;
    if (!el) return;

    const EDGE = 24;
    const AXIS = 12;
    const SNAP = 60;
    let x0 = 0;
    let y0 = 0;
    let base = 0;
    let tracking = false;
    let axis: 'h' | 'v' | null = null;

    const onStart = (e: TouchEvent) => {
      // Multitouch is zoom, not swipe.
      if (e.touches.length > 1) { tracking = false; return; }
      const t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) { tracking = false; return; }
      x0 = t.clientX;
      y0 = t.clientY;
      const w = panelWidth();
      base = sideRef.current === 'rooms' ? w : sideRef.current === 'members' ? -w : 0;
      tracking = true;
      axis = null;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (!axis) {
        if (Math.abs(dx) < AXIS && Math.abs(dy) < AXIS) return;
        // Lock the axis once per gesture, or diagonal moves shift feed and panel together.
        axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (axis === 'v') { tracking = false; return; }
      }
      // preventDefault only once the gesture is ours: a non-passive listener would weigh on normal
      // feed scrolling.
      if (e.cancelable) e.preventDefault();
      applyPanel(base + dx, false);
    };

    const onEnd = (e: TouchEvent) => {
      if (!tracking || axis !== 'h') { tracking = false; return; }
      tracking = false;
      const dx = (e.changedTouches[0]?.clientX ?? x0) - x0;
      if (base > 0) openSide(dx > -SNAP ? 'rooms' : null);
      else if (base < 0) openSide(dx < SNAP ? 'members' : null);
      else if (dx > SNAP) openSide('rooms');
      else if (dx < -SNAP) openSide('members');
      else openSide(null);
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [narrow, applyPanel, panelWidth, openSide]);

  // System Back closes the panel instead of leaving; the second Back leaves chat. Manual close
  // leaves one idle entry reused next time (same as the old chat).
  useEffect(() => {
    if (!side) return;
    if (!(window.history.state && window.history.state.chatPanel)) {
      window.history.pushState({ ...window.history.state, chatPanel: true }, '');
      panelEntryRef.current = true;
    }
    const onPop = () => { panelEntryRef.current = false; openSide(null); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [side, openSide]);

  // Gate and dependency on `side` (state), not `sideRef`: refs don't wake effects, so the resize
  // listener was never attached and a rotated screen kept the old transform. Measure width INSIDE
  // the handler.
  useEffect(() => {
    if (!side) return undefined;
    const onResize = () => {
      const w = panelWidth();
      applyPanel(side === 'members' ? -w : w, false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [side, applyPanel, panelWidth]);

  // Narrow → wide: close the panel (the channel strip/columns are visible; a shifted chat looks
  // broken).
  useEffect(() => {
    if (!narrow && sideRef.current) openSide(null);
  }, [narrow, openSide]);

  const startDM = useCallback(async (userId: string) => {
    try {
      const ch = await openDM(userId);
      setProfileAnchor(null);
      await refreshChannels(ch.slug);
    } catch (e) {
      setError((e as { message?: string })?.message || 'Failed to open the conversation.');
    }
  }, [refreshChannels]);

  // "Show me in the list": write to the account and ping at once, else the user sees themselves
  // listed for another minute.
  const toggleVisible = useCallback(() => {
    if (!user) return;
    pb.collection('users').update(user.id, { chat_hidden: visible })
      .then(() => pingPresence({ chat: true, roster: rosterRef.current }))
      .then((res) => {
        setOnline(res.online);
        if (res.who) setWho((cur) => (sameWho(cur, res.who!) ? cur : res.who!));
        if (res.rest) setRest(res.rest);
      })
      .catch(() => { });
  }, [user, visible]);

  const toggleSound = () => {
    const v = !sound;
    setSound(v);
    localStorage.setItem(SOUND_KEY, v ? '1' : '0');
    // The first enable is the gesture that unlocks audio; also lets the user hear it.
    if (v) playPingSound();
  };

  // Drop target = the whole chat shell; type/size checks live in Composer (one path for all attach
  // methods).
  const [dragging, setDragging] = useState(false);
  // Nesting counter: dragleave fires on moving into children; without it the hint flickers per row.
  const dragDepth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.items || []).some((it) => it.kind === 'file')) return;
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Without preventDefault the browser opens the image.
    if (dragDepth.current > 0) e.preventDefault();
  }, []);

  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) composerRef.current?.attachImage(f);
  }, []);

  // Hide DMs with blocked people (server closed them both ways). The server doesn't hide them: the
  // room list is shared/cacheable.
  const channelsShown = useMemo(() => {
    if (blockedSet.size === 0) return channels;
    return channels.filter((c) => !(
      c.is_dm && (c.members || []).some((id) => id !== user?.id && blockedSet.has(id))
    ));
  }, [channels, blockedSet, user?.id]);

  // Permanent rooms = author's: public, ownerless, not topics.
  const permanentRooms = useMemo(
    () => channelsShown.filter((c) => !c.is_dm && !c.is_private && !c.community),
    [channelsShown],
  );

  // Room strip memoized: typing must not rebuild every pill.
  const channelBar = useMemo(() => (
    <Box sx={CHANBAR_SX}>
      {midView ? (
        // When topics occupy the center, the top bar talks about them, not the room you came from
        // ("#Magocratic Beta Test" above a list of other topics). The Back arrow lives in this bar;
        // no separate room toggle here — two adjacent arrows to different places was the original
        // confusion.
        <>
          <Tooltip title={midView === 'compose' ? 'Back to the threads' : 'Back to the conversation'}>
            <IconButton
              size="small"
              onClick={leaveMidView}
              aria-label={midView === 'compose' ? 'Back to the threads' : 'Back to the conversation'}
              sx={{ flexShrink: 0, ml: -0.5 }}
            >
              <ArrowBackIcon sx={{ fontSize: 19 }} />
            </IconButton>
          </Tooltip>
          <Typography sx={BAR_TITLE_SX} noWrap>
            {midView === 'compose' ? 'New thread' : 'Threads'}
          </Typography>
        </>
      ) : activeChannel?.community ? (
        // In a user topic: ONE arrow, to the topic index (there were two identical-looking arrows
        // going to different places). Topic title shown only here, not repeated in the post header.
        <>
          <Tooltip title="Back to all threads">
            <IconButton
              size="small"
              onClick={() => {
                captureReadingPosition(activeChannel?.id);
                setMidView('list');
              }}
              aria-label="Back to all threads"
              sx={{ flexShrink: 0, ml: -0.5 }}
            >
              <ArrowBackIcon sx={{ fontSize: 19 }} />
            </IconButton>
          </Tooltip>
          <Typography sx={BAR_TITLE_SX} noWrap>
            {channelLabel(activeChannel, user?.id)}
          </Typography>
          {narrow && elsewhereNew && (
            <Box sx={{
              flexShrink: 0, width: 7, height: 7, borderRadius: 999,
              bgcolor: elsewhereMention ? 'error.main' : 'primary.main',
            }} />
          )}
        </>
      ) : wide ? (
        <Typography sx={BAR_TITLE_SX} noWrap>
          {activeChannel
            ? `${activeChannel.is_dm ? '@' : '#'}${channelLabel(activeChannel, user?.id)}`
            : ''}
        </Typography>
      ) : narrow ? (
        // On phones the pill strip is useless (two rooms fit, blind sideways scrolling): one button
        // — where I am + open the list.
        <Box
          component="button"
          type="button"
          onClick={() => openSide(sideRef.current === 'rooms' ? null : 'rooms')}
          aria-label={panelOpen ? 'Hide rooms' : 'Show rooms'}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1,
            py: 0.5,
            border: 0,
            borderRadius: 1.5,
            bgcolor: 'rgba(255,255,255,0.06)',
            color: 'text.primary',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            maxWidth: '100%',
          }}
        >
          {panelOpen
            ? <ArrowBackIcon sx={{ fontSize: 17, opacity: 0.75 }} />
            : <ArrowForwardIcon sx={{ fontSize: 17, opacity: 0.75 }} />}
          <Box component="span" sx={{
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {midView === 'compose' ? 'New thread'
              : midView === 'list' ? 'Threads'
              : activeChannel
                ? `${activeChannel.is_dm ? '' : '#'}${channelLabel(activeChannel, user?.id)}`
                : ''}
          </Box>
          {elsewhereNew && (
            <Box sx={{
              flexShrink: 0, width: 7, height: 7, borderRadius: 999,
              bgcolor: elsewhereMention ? 'error.main' : 'primary.main',
            }} />
          )}
        </Box>
      ) : (
        // Closed conversations also leave the strip. No user topics in the strip (hundreds); the
        // currently open one stays.
        channelsShown
          .filter((c) => !(c.is_dm && c.slug !== active && dmHidden(c.id)))
          .filter((c) => !(c.community && c.slug !== active))
          .map((c) => {
          const isActive = c.slug === active;
          const mentioned = !isActive && chanMentions.includes(c.id);
          const fresh = !isActive && !mentioned && channelHasNew(c.id);
          return (
            <Box
              key={c.id}
              component="button"
              type="button"
              ref={isActive ? activePillRef : undefined}
              onClick={() => openChannel(c.slug)}
              sx={{
                // Three deliberately contrasting states: mentioned (loud), new (faint), current
                // (filled). No counters: they'd need per-user×channel read state in the DB for the
                // same answer as a dot.
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                flexShrink: 0,
                px: 1.25,
                py: 0.5,
                borderRadius: 999,
                border: 1,
                borderColor: mentioned ? 'error.main' : isActive ? 'primary.main' : 'transparent',
                bgcolor: isActive ? 'rgba(252,52,71,0.16)' : 'transparent',
                color: isActive || fresh || mentioned ? 'text.primary' : 'text.secondary',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: isActive || fresh || mentioned ? 700 : 500,
                lineHeight: 1.4,
                whiteSpace: 'nowrap',
                cursor: 'pointer',
                transition: 'background-color .15s, color .15s',
                '&:hover': { bgcolor: isActive ? 'rgba(252,52,71,0.22)' : 'rgba(255,255,255,0.06)' },
              }}
            >
              {/*
                Icon = channel kind (# public, lock private, @ DM): the cost of confusion is
                "posted in front of strangers".
              */}
              <Box component="span" sx={PILL_HASH_SX}>
                {c.is_dm ? '@' : c.is_private ? '🔒' : '#'}
              </Box>
              {channelLabel(c, user?.id)}
              {(mentioned || fresh) && (
                <Box sx={{
                  width: mentioned ? 'auto' : 6,
                  height: mentioned ? 'auto' : 6,
                  px: mentioned ? 0.5 : 0,
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  lineHeight: '14px',
                  bgcolor: mentioned ? 'error.main' : 'primary.main',
                  color: mentioned ? '#fff' : 'transparent',
                }}>
                  {mentioned ? '@' : ''}
                </Box>
              )}
            </Box>
          );
        })
      )}
      {/*
        "Create room" button removed until release (DMs work without it; rooms need
        visibility/invite/moderation decisions). RoomDialog and server handlers remain — restoring
        is one line.
      */}
      {signedIn && activeChannel?.is_private && !activeChannel.is_dm && (
        <Box
          component="button"
          type="button"
          title="Members"
          onClick={() => setRoomDialog({ room: activeChannel })}
          sx={PILL_ACTION_SX}
        >
          <PeopleOutlineIcon sx={{ fontSize: 15 }} />
        </Box>
      )}
    </Box>
  ), [channelsShown, active, chanMentions, channelHasNew, dmHidden, openChannel,
      signedIn, activeChannel, user?.id,
      narrow, wide, panelOpen, openSide, elsewhereNew, elsewhereMention, midView, leaveMidView,
      captureReadingPosition]);

  // Pins this reader will actually see: blocked authors hidden like in the feed. Plus a room check:
  // the pins response briefly survives a room switch and flashed another room's pin.
  const visiblePins = useMemo(() => {
    const chId = activeChannel?.id;
    // The default room also owns pre-channel history (`channel = ""`, see channelScope) and its
    // pins.
    let out = chId
      ? pins.filter((m) => m.channel === chId || (isDefaultChannel && !m.channel))
      : [];
    if (blockedSet.size > 0) out = out.filter((m) => !m.user || !blockedSet.has(m.user));
    return out;
  }, [pins, blockedSet, activeChannel?.id, isDefaultChannel]);

  // Feed assembled separately and memoized; only neighborhood facts are computed here (day divider,
  // block merge, room change). Everything else is inside memoized MessageRow, so screen re-renders
  // don't reach rows.
  const feed = useMemo(() => {
    const passes = loadDelPasses();
    // Remove blocked users BEFORE neighborhood computation (else gaps: a foreign header over a
    // merged block, a day divider with nothing below). Also remember what was hidden to hide their
    // quotes in others' replies — the server can't (shared cached feed, personal block).
    const hidden = new Set<string>();
    let rows = messages;
    if (blockedSet.size > 0) {
      rows = [];
      for (const m of messages) {
        if (m.user && blockedSet.has(m.user)) hidden.add(m.id);
        else rows.push(m);
      }
    }
    return rows.map((m, i) => {
      const prev = rows[i - 1];
      const unread = m.id === firstUnreadId;
      return (
        <MessageRow
          key={m.id}
          m={m}
          daySepLabel={i === 0 || !sameDay(prev.created, m.created)
            ? dayLabel(m.created)
            : undefined}
          unread={unread}
          quoteHidden={Boolean(m.reply && hidden.has(m.reply.id))}
          // Merge: same author, same room, short gap. Replies always start a block; the NEW divider
          // breaks blocks too.
          grouped={!unread && sameRun(prev, m)}
          touched={touched === m.id}
          isModerator={canModerateChat}
          admins={admins}
          canEdit={canEdit(m, passes)}
          canDelete={canDelete(m, passes)}
          meUsername={user?.username}
          meId={user?.id}
          emojiVer={emojiPack.ready ? emojiVersion() : 0}
          onTouch={toggleTouched}
          onReply={replyToMessage}
          onEdit={startEdit}
          onDeleteOwn={removeOwn}
          onTogglePin={togglePin}
          onModDelete={modRemove}
          onModMute={modMute}
          onModUnmute={modUnmute}
          onOpenProfile={openProfile}
          onMention={insertMention}
          onJumpTo={jumpTo}
          onImgLoad={onImgLoad}
          onOpenImage={openImage}
          blurImages={blurThreadImages}
          // Only logged-in users react: anonymous users have no id to distinguish repeat clicks.
          onReact={user ? toggleReaction : undefined}
        />
      );
    });
  }, [
    messages, blockedSet, touched, firstUnreadId, canModerateChat, admins,
    user, emojiPack.ready, toggleReaction,
    canEdit, canDelete, toggleTouched, replyToMessage, startEdit,
    removeOwn, togglePin, modRemove, modMute, modUnmute, openProfile, insertMention, jumpTo,
    onImgLoad, openImage, blurThreadImages,
  ]);

  // Side list contents shared between swipe panels and wide columns (no duplicate markup to fix
  // twice).
  const roomsList = (
    <ChannelPanel
      channels={channelsShown}
      active={midView ? '' : active}
      meId={user?.id}
      mentions={chanMentions}
      hasNew={channelHasNew}
      hidden={dmHidden}
      // Closed the open conversation → move to the first room.
      onHide={(id) => {
        hideDm(id);
        if (activeChannel?.id === id) openChannel(channels[0]?.slug ?? '');
      }}
      // Pins go to the server: conversation order is per person, not device.
      onPins={(ids) => {
        saveChatPins(ids).catch(() => setError('Pins not saved. Try again.'));
      }}
      signedIn={signedIn}
      onPick={openChannel}
      // Topics section enabled by URL; without these handlers ChannelPanel doesn't render it.
      rating={rating}
      communityOpen={viewPrefs.communityOpen}
      onToggleCommunity={community
        ? () => setChatPref('communityOpen', !viewPrefs.communityOpen)
        : undefined}
      onExpandCommunity={community
        ? () => withoutPanelEntry(() => setCommunityView(true))
        : undefined}
      onCreateCommunity={community
        ? () => withoutPanelEntry(() => setMidView('compose'))
        : undefined}
      communityListActive={communityView}
    />
  );

  const membersList = (
    <MembersPanel
      who={who}
      online={online}
      guests={rest.guests}
      hidden={rest.hidden}
      cut={rest.cut}
      here={midView ? undefined : here}
      hereMore={midView ? 0 : hereMore}
      hereLabel={activeChannel?.community ? 'In this thread' : 'In this room'}
      meId={user?.id}
      blocked={blockedSet}
      signedIn={signedIn}
      visible={visible}
      onToggleVisible={toggleVisible}
      // Don't close the panel: the profile card is anchored to it.
      onPick={openProfileById}
    />
  );

  // Settings gear and "who's here" as separate pieces: the topic index filter row renders the same
  // pair.
  const prefsBtn = (
    <Tooltip title="Chat settings">
      <IconButton size="small" onClick={(e) => setPrefsAnchor(e.currentTarget)}>
        <TuneOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );

  const whoBtn = (
    <Tooltip title={wide ? 'Who is here now' : 'Who is here now — tap to see'}>
      <Box
        component="button"
        type="button"
        disabled={wide}
        onClick={(e: React.MouseEvent<HTMLElement>) => {
          if (wide) return;
          if (narrow) { openSide(sideRef.current === 'members' ? null : 'members'); return; }
          setWhoAnchor(showWho ? null : e.currentTarget);
        }}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0,
          px: 1, py: 0.5, borderRadius: 999, border: 0,
          bgcolor: showWho || side === 'members' ? 'rgba(255,255,255,0.09)' : 'transparent',
          color: 'text.secondary', fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
          cursor: wide ? 'default' : 'pointer',
          '&:hover': { bgcolor: wide ? 'transparent' : 'rgba(255,255,255,0.06)' },
        }}
      >
        <Box sx={{
          width: 7, height: 7, borderRadius: '50%',
          bgcolor: online > 0 ? '#3fb950' : 'text.disabled',
          boxShadow: online > 0 ? '0 0 6px rgba(63,185,80,0.8)' : 'none',
        }} />
        {online}
        <PeopleOutlineIcon sx={{ fontSize: 15, opacity: 0.7 }} />
      </Box>
    </Tooltip>
  );

  return (
    <Box
      ref={outerRef}
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        width: '100%',
        pb: kbInset ? `${kbInset}px` : 0,
      }}
    >
    <Box
      ref={shellRef}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        width: '100%',
        maxWidth: wide ? 900 + COLUMN_W * 2 : 900,
        mx: 'auto',
        // `clip`, NOT `hidden`: `hidden` is still a scroll container, and the browser may scroll it
        // to reveal an off-edge caret. In narrow layout something is always past the edge (members
        // panel on the right), so a long unbroken word in the composer shifted the whole shell
        // sideways and the scrollLeft never reset until reload. `clip` creates no scroll container.
        position: 'relative',
        overflow: 'hidden',
        '@supports (overflow: clip)': { overflow: 'clip' },
        borderLeft: { xs: 0, md: 1 },
        borderRight: { xs: 0, md: 1 },
        borderColor: { md: 'divider' },
      }}
    >
      {wide && (
        <Box sx={{ width: COLUMN_W, flexShrink: 0 }}>{roomsList}</Box>
      )}

      {/*
        Narrow: both panels are always mounted and pushed past their edges, so nothing mounts at
        touch time.
      */}
      {narrow && (
        <Box
          ref={panelRef}
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            zIndex: 2,
            width: 'min(240px, max(150px, 38%))',
            transform: 'translateX(-100%)',
          }}
        >
          {roomsList}
        </Box>
      )}

      {narrow && (
        <Box
          ref={membersRef}
          sx={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            zIndex: 2,
            width: 'min(240px, max(150px, 38%))',
            borderLeft: 1,
            borderColor: 'divider',
            transform: 'translateX(100%)',
          }}
        >
          {membersList}
        </Box>
      )}

      <Box
        ref={colRef}
        // Typing closes an open side panel (it shifts the column; the composer's right third goes
        // off-screen). Listen to INPUT, not focus: the panel is often swiped open with focus
        // already in the field and keyboard up — no focus event then. input bubbles, so one handler
        // covers composer, OP editor and topic search; the panel isn't a descendant, so typing in
        // its own search doesn't close it.
        onInput={() => { if (sideRef.current) openSide(null); }}
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
      {/*
        No room strip on the TOPIC INDEX: it has its own row (sort, rating, new topic); gear and
        "who's here" move into that filter row (`actions` of CommunityList).
      */}
      {!communityView && (
      <Box sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: { xs: 0.75, sm: 1.25 },
        minHeight: 48,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'rgba(21,21,21,0.72)',
        backdropFilter: 'blur(12px)',
      }}>
        {channelBar}

        {/*
          The bell = SUBSCRIPTION TO THIS PLACE (in a topic, subscribes to the topic), so it sits
          by the title. Sound moved under the gear (global, not per-place).
        */}
        <PushBell
          signedIn={signedIn}
          onMessage={setError}
          roomId={activeChannel?.id}
          roomName={
            activeChannel
              ? `${activeChannel.is_dm ? '' : '#'}${channelLabel(activeChannel, user?.id)}`
              : undefined
          }
          onRoomPrefs={(p) => { roomMutedRef.current = p; }}
        />

        {prefsBtn}
        {whoBtn}
      </Box>
      )}

      <Popover
        open={showWho}
        anchorEl={whoAnchor}
        onClose={() => setWhoAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 260, maxWidth: '92vw', borderRadius: 2, overflow: 'hidden' } } }}
      >
        <Box sx={{ display: 'flex', maxHeight: 360 }}>{membersList}</Box>
      </Popover>

      {/*
        Pin as a strip under the header (Telegram-style): it belongs to the conversation, so above
        the feed. Blocked authors hidden here too. Absent while the center shows the index or a new
        topic — a pin from another place hanging over them was the top complaint about this screen.
      */}
      {visiblePins.length > 0 && !midView && (
        <PinnedBar
          pins={visiblePins}
          isModerator={canModerateChat}
          onJump={goToPin}
          onUnpin={togglePin}
        />
      )}

      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      {/*
        The topic list replaces the feed instead of a separate page (keeps the open room and
        scroll).
      */}
      {composeView ? (
        <ThreadComposer
          onCancel={() => setMidView(community ? 'list' : null)}
          onDone={(room) => {
            setMidView(null);
            setCommunityReload((n) => n + 1);
            // The OP arrived with the room (it's a room field): render the header before the room
            // request returns.
            setThreadTopic(room);
            openCommunityRoom(room);
          }}
        />
      ) : communityView ? (
        <CommunityList
          rating={rating}
          signedIn={signedIn}
          reloadKey={communityReload}
          onOpen={openCommunityRoom}
          onCreate={() => setMidView('compose')}
          rooms={permanentRooms}
          onOpenRoom={openChannel}
          hasNew={channelHasNew}
          onWatch={setWatchIds}
          newCount={channelNewCount}
          onLiveMessage={onLiveMessage}
          onLiveRoom={onLiveRoom}
          // Viewer id splits "mine" into own topics vs replied-in by topic owner.
          meId={user?.id}
          // No chat strip on this screen: gear and "who's here" ride the right edge of the filter
          // row. On phones the online counter stays out — the row is already full, and 60 px for a
          // number unrelated to any room would be taken from the filters. Members panel on phones
          // via edge swipe.
          actions={<>{prefsBtn}{narrow ? null : whoBtn}</>}
        />
      ) : (
      <>
      <Box
        ref={listRef}
        onScroll={onScroll}
        onWheel={cancelInitialPosition}
        onTouchStart={cancelInitialPosition}
        onPointerDown={cancelInitialPosition}
        // role=log for screen readers: new rows are read incrementally instead of the whole feed.
        role="log"
        aria-label="Chat messages"
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          // We own scroll (row anchor + ResizeObserver). Native overflow-anchor would apply the
          // same correction blindly and late — double shift. Safari also lacks it; identical
          // behavior everywhere matters more.
          overflowAnchor: 'none',
          px: { xs: 0.5, sm: 1 },
          // No top padding on purpose: the sticky topic header sticks to the feed edge; padding
          // would open a gap under the chat header with messages visible through it.
          pt: 0,
          pb: 1,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/*
          Topic header is the FIRST feed item, not a separate bar above it. As a bar it was capped
          at a third of the screen and scrolled internally — a long post read through a slit.
          Inside the feed it reads fully and flows into comments in one gesture.
        */}
        {threadRoom && threadTopic && (
          <ThreadHeader
            topic={threadTopic}
            nodeRef={opRef}
            collapsed={opCollapsed}
            // Expand = read the OP in place, not jump to topic start. Collapsing back keeps the
            // same reply row under the eyes via toggleOp's height compensation.
            onCollapsed={(v) => toggleOp(v ? 'keep' : 'open')}
            onEdit={canEditThreadOp ? () => setOpDialog(true) : undefined}
          // Moderation only for topics (title, tags, hide); permanent rooms aren't hidden from here
          // and the handler refuses. The only difference: a topic has an owner.
          onModerate={canModerateChat && (threadTopic.owner || threadTopic.anon)
            ? () => setModDialog(true) : undefined}
            signedIn={signedIn}
            meId={user?.id || ''}
            blurImages={blurThreadImages}
          />
        )}

        {/*
          mt:auto pins a short feed to the composer: an empty room's conversation starts at the
          bottom like any messenger. With many messages the auto margin collapses.
        */}
        <Box ref={feedContentRef} sx={{ mt: 'auto', pt: 1 }}>
        {loading && messages.length === 0 ? (
          <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress size={24} /></Stack>
        ) : messages.length === 0 ? (
          <Stack alignItems="center" spacing={1} sx={{ py: 6, opacity: 0.6 }}>
            <ChatBubbleOutlineIcon sx={{ fontSize: 32 }} />
            <Typography variant="body2" color="text.secondary">
              Nothing here yet. Be the first.
            </Typography>
          </Stack>
        ) : (
          feed
        )}
        </Box>
      </Box>

        {/* "Scroll down" only when the reader is in history; otherwise it just covers the last line. */}
        {(!atBottom || hasNewer) && messages.length > 0 && (
          <Box
            component="button"
            type="button"
            onClick={jumpToBottom}
            sx={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 0.5,
              px: 1.25, py: 0.5, borderRadius: 999,
              border: 1, borderColor: 'divider', bgcolor: 'background.paper',
              color: 'text.secondary', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
              '&:hover': { color: 'text.primary' },
            }}
          >
            <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
            Jump to latest
          </Box>
        )}
      </>
      )}
      </Box>

      {/*
        pointerEvents:none is mandatory: if the hint grabbed the pointer, dragleave would fire
        right after it appears and it would flicker against itself.
      */}
      {dragging && (
        <Box sx={{
          position: 'absolute', inset: 8, zIndex: 5, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px dashed', borderColor: 'primary.main', borderRadius: 2,
          bgcolor: 'rgba(21,21,21,0.72)', backdropFilter: 'blur(2px)',
          color: 'text.primary', fontWeight: 700, fontSize: 15,
        }}>
          Drop the image here
        </Box>
      )}

      {/* Hide the composer while the center shows the index or a new topic: nowhere to write there. */}
      {!midView && (
      <Composer
        ref={composerRef}
        signedIn={signedIn}
        anonKey={anonKey}
        privateChannel={Boolean(activeChannel?.is_private)}
        draftKey={`${user?.id || `guest:${anonKey}`}:${activeChannel?.id || 'default'}`}
        placeholder={activeChannel
          ? `Message ${activeChannel.is_dm ? '' : '#'}${channelLabel(activeChannel, user?.id)}…`
          : 'Write a message…'}
        replyTo={replyTo}
        editing={editing}
        onCancelReply={cancelReply}
        onRestoreReply={setReplyTo}
        onCancelEdit={cancelEdit}
        onSubmit={submitMessage}
        onEditLast={editLast}
        onError={setError}
        onResize={onComposerResize}
      />
      )}

      {/* OP editing in a separate dialog: the post is long; the reply composer doesn't fit it. */}
      <OpEditDialog
        open={opDialog}
        room={threadTopic}
        onClose={() => setOpDialog(false)}
        onSaved={(room) => { setOpDialog(false); setThreadTopic(room); setCommunityReload((n) => n + 1); }}
      />

      {/* Topic moderation (title, tags, hide): button for moderators only; server has the final say. */}
      <ThreadModerateDialog
        open={modDialog}
        room={threadTopic}
        onClose={() => setModDialog(false)}
        onSaved={(room) => { setModDialog(false); setThreadTopic(room); setCommunityReload((n) => n + 1); }}
      />

      {/*
        Profile card: deliberately minimal (avatar, name, joined date) — site profiles are empty
        for now. Space reserved for favorite games/builds.
      */}
      <Popover
        open={Boolean(profileAnchor)}
        anchorEl={profileAnchor}
        onClose={() => setProfileAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1.5, maxWidth: 260 } } }}
      >
        {profile ? (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Avatar src={avatarUrlOf(profile)} sx={{ width: 40, height: 40 }}>
                {(profile.name || profile.username || '?')[0]}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="subtitle2"
                  noWrap
                  sx={{ color: staffNickColor(profile.id, profile.isModerator, admins) ?? nickColor(profile.id) }}
                >
                  {chatNotes.notes[profile.id]?.a || profile.name || profile.username || 'User'}
                </Typography>
                {/*
                  Under a signed (masked) name show the real one: the card is where you see who's
                  actually there.
                */}
                {chatNotes.notes[profile.id]?.a && (profile.name || profile.username) && (
                  <Typography variant="caption" color="text.secondary" noWrap display="block">
                    {profile.name || profile.username}
                  </Typography>
                )}
                {profile.username && (
                  <Typography variant="caption" color="text.secondary" noWrap display="block">
                    @{profile.username}
                  </Typography>
                )}
              </Box>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {profile.isModerator ? 'Moderator · ' : ''}
              Here since {new Date(profile.created.replace(' ', 'T')).toLocaleDateString()}
            </Typography>
            {profile.username && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => {
                  insertMention(profile.username as string);
                  setProfileAnchor(null);
                }}
              >
                Mention
              </Button>
            )}
            {/*
              DM only for logged-in users and not to self (guests can't read private channels by
              collection rule). Not offered to a blocked user: the server closed that conversation;
              the button would lead to a refusal.
            */}
            {signedIn && user && profile.id !== user.id && !blockedSet.has(profile.id) && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<ChatBubbleOutlineIcon sx={{ fontSize: 15 }} />}
                onClick={() => startDM(profile.id)}
              >
                Message
              </Button>
            )}
            {/*
              Personal note about a person (own name + free note): visible only to its author. No
              self-notes.
            */}
            {signedIn && user && profile.id !== user.id && (
              <NoteEditor
                userId={profile.id}
                realName={profile.name || profile.username || 'User'}
                note={chatNotes.notes[profile.id]}
              />
            )}
            {/*
              Block. Moderators can't be hidden: their warnings are the one thing that must be
              read.
            */}
            {signedIn && user && profile.id !== user.id && !profile.isModerator && (
              <Button
                size="small"
                variant="text"
                color={blockedSet.has(profile.id) ? 'inherit' : 'error'}
                startIcon={<BlockIcon sx={{ fontSize: 15 }} />}
                onClick={() => { void toggleBlock(profile.id); setProfileAnchor(null); }}
              >
                {blockedSet.has(profile.id) ? 'Unblock' : 'Block'}
              </Button>
            )}
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">Loading…</Typography>
        )}
      </Popover>

      {roomDialog && user && (
        <RoomDialog
          open
          room={roomDialog.room}
          meId={user.id}
          onClose={() => setRoomDialog(null)}
          // Left a room → dialog already closed, reload list; created → switch into it.
          // Invited/kicked → swap the room object in the dialog, or its member list stays stale
          // until closed.
          onDone={(ch, opened) => {
            if (ch && roomDialog.room) setRoomDialog({ room: ch });
            void refreshChannels(opened ? ch?.slug : undefined);
          }}
        />
      )}

      {/* View settings apply instantly and aren't sent anywhere: per tab, not per account. */}
      <Menu
        anchorEl={prefsAnchor}
        open={Boolean(prefsAnchor)}
        onClose={() => setPrefsAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={() => setChatPref('hideImages', !viewPrefs.hideImages)}>
          <ListItemIcon>
            {viewPrefs.hideImages
              ? <VisibilityOffOutlinedIcon fontSize="small" />
              : <VisibilityOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Hide images until clicked"
            secondary={viewPrefs.hideImages ? 'On — nothing loads on its own' : 'Off'}
          />
        </MenuItem>
        <MenuItem onClick={() => setChatPref('freezeEmoji', !viewPrefs.freezeEmoji)}>
          <ListItemIcon>
            {viewPrefs.freezeEmoji
              ? <MotionPhotosOffOutlinedIcon fontSize="small" />
              : <GifBoxOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Freeze animated emoji"
            secondary={viewPrefs.freezeEmoji ? 'On — first frame only' : 'Off'}
          />
        </MenuItem>
        <Divider />
        {/*
          Mention sound lives here (was a strip button next to the bell): the bell is about the
          CURRENT room, sound is global and touched once in a lifetime. Stored in localStorage.
        */}
        <MenuItem onClick={toggleSound}>
          <ListItemIcon>
            {sound
              ? <VolumeUpOutlinedIcon fontSize="small" />
              : <VolumeOffOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Sound when someone calls you"
            secondary={sound
              ? 'On — a chime when you are mentioned or written to'
              : 'Off — nothing makes a sound'}
          />
        </MenuItem>
        {/*
          Where PERSONAL pins sit on the topic index. Default bottom: on top they pushed down the
          topic feed itself. Shared ("pinned for everyone") pins stay on top always — the section's
          showcase for first-time visitors.
        */}
        <MenuItem onClick={() => setChatPref('threadPinsBottom', !viewPrefs.threadPinsBottom)}>
          <ListItemIcon>
            {viewPrefs.threadPinsBottom
              ? <VerticalAlignBottomOutlinedIcon fontSize="small" />
              : <VerticalAlignTopOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Pinned threads at the bottom"
            secondary={viewPrefs.threadPinsBottom
              ? 'On — the thread list starts right away'
              : 'Off — your pins sit above the list'}
          />
        </MenuItem>
        <Divider />
        {/*
          Header chat-icon click behavior: the toggle SWAPS single and double click actions, not
          disables one.
        */}
        <MenuItem onClick={() => setChatPref('singleClickFullChat', !viewPrefs.singleClickFullChat)}>
          <ListItemIcon>
            {viewPrefs.singleClickFullChat
              ? <OpenInFullOutlinedIcon fontSize="small" />
              : <CloseFullscreenOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Header icon opens the full chat"
            secondary={viewPrefs.singleClickFullChat
              ? 'On — one click for the full page, two for the quick chat'
              : 'Off — one click for the quick chat, two for the full page'}
          />
        </MenuItem>
        {/*
          Right-to-left swipe opens quick chat from any page (finger-only gesture). The option is
          shown EVERYWHERE, not only on touch: behind TOUCH_ONLY it vanished on tablets with flaky
          detection and in mobile "desktop mode", and people asked where it went. Per-device
          setting (localStorage).
        */}
        <MenuItem
          onClick={() => setChatPref('swipeOpenMode', SWIPE_OPEN_MODE_CYCLE[viewPrefs.swipeOpenMode])}
        >
          <ListItemIcon>
            {viewPrefs.swipeOpenMode === 'off'
              ? <DoNotTouchOutlinedIcon fontSize="small" />
              : viewPrefs.swipeOpenMode === 'games_off'
                ? <SportsEsportsOutlinedIcon fontSize="small" />
                : <SwipeLeftOutlinedIcon fontSize="small" />}
          </ListItemIcon>
          <ListItemText
            primary="Swipe to open chat"
            secondary={
              viewPrefs.swipeOpenMode === 'off'
                ? 'Off — swipe does nothing'
                : viewPrefs.swipeOpenMode === 'games_off'
                  ? 'Off in games'
                  : 'Everywhere'
            }
          />
        </MenuItem>
        {/*
          Anonymous signature: needed by guests (they only write masked) and by logged-in users in
          anonymous topics/rooms where they chose anonymity.
        */}
        <MenuItem onClick={() => { setPrefsAnchor(null); setMaskOpen(true); }}>
          <ListItemIcon><AnonMaskIcon fontSize="small" /></ListItemIcon>
          <ListItemText
            primary="Your anon name"
            secondary={anonIdentity('', anonMaskName).name}
          />
        </MenuItem>
        {/*
          Previously a blocked user could never be unblocked (no visible block list). Logged-in
          only — guests have no block list (fetchBlocks).
        */}
        {signedIn && (
          <MenuItem onClick={() => { setPrefsAnchor(null); setBlockedListOpen(true); }}>
            <ListItemIcon><BlockIcon fontSize="small" /></ListItemIcon>
            <ListItemText
              primary="Blocked users"
              secondary={blocked.length > 0 ? `${blocked.length} blocked` : 'Nobody blocked'}
            />
          </MenuItem>
        )}
        {canModerateChat && [
          <Divider key="div" />,
          <MenuItem key="rooms" onClick={() => { setPrefsAnchor(null); setRoomsAdmin(true); }}>
            <ListItemIcon><ForumOutlinedIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="Manage rooms…" secondary="Moderators only" />
          </MenuItem>,
        ]}
      </Menu>

      <RoomsAdminDialog
        open={roomsAdmin}
        meId={user?.id || ''}
        onClose={() => setRoomsAdmin(false)}
        onChanged={() => { void refreshChannels(); }}
      />

      <AnonMaskDialog open={maskOpen} onClose={() => setMaskOpen(false)} />

      <BlockedUsersDialog
        open={blockedListOpen}
        ids={blocked}
        onClose={() => setBlockedListOpen(false)}
        onUnblock={(id) => { void toggleBlock(id); }}
      />

      <ImageLightbox m={zoomed} onClose={closeImage} />

      <Dialog
        open={Boolean(nsfwGateRoom)}
        onClose={declineNsfwRoom}
        BackdropProps={{
          sx: {
            backdropFilter: 'blur(5px)',
            bgcolor: 'rgba(8, 8, 12, 0.52)',
          },
        }}
        PaperProps={{
          sx: {
            borderRadius: 3,
            maxWidth: 420,
            mx: 'auto',
          },
        }}
      >
        <DialogTitle sx={{ textAlign: 'center', fontWeight: 700, pb: 1 }}>
          NSFW thread
        </DialogTitle>
        <DialogContent>
          <Typography color="text.secondary" sx={{ textAlign: 'center', lineHeight: 1.7 }}>
            This thread may contain adult content.
            <br /><br />
            <Box component="strong" sx={{ color: 'text.primary' }}>
              Are you sure you are 18+ and want to continue?
            </Box>
          </Typography>
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ display: 'block', mt: 1.5, textAlign: 'center', lineHeight: 1.5 }}
          >
            In SFW mode, images in this thread stay blurred until you click them.
          </Typography>
        </DialogContent>
        <DialogActions sx={{
          flexDirection: 'column',
          gap: 1,
          pb: 2.5,
          px: 3,
          '& > :not(style) ~ :not(style)': { ml: 0 },
        }}>
          <Stack direction="row" justifyContent="center" spacing={1} sx={{ width: '100%' }}>
            <Button
              onClick={declineNsfwRoom}
              variant="outlined"
              color="inherit"
              sx={{ borderRadius: 2, px: 3, textTransform: 'none' }}
            >
              No, take me back
            </Button>
            <Button
              variant="contained"
              color="primary"
              onClick={() => {
                const room = nsfwGateRoom;
                if (!room) return;
                nsfwApprovedRef.current.add(room.id);
                setNsfwGateRoom(null);
                enterCommunityRoom(room);
              }}
              sx={{ borderRadius: 2, px: 3, textTransform: 'none', fontWeight: 600 }}
            >
              Yes, continue
            </Button>
          </Stack>
          <Button
            variant="text"
            color="primary"
            onClick={() => {
              const room = nsfwGateRoom;
              if (!room) return;
              setChatPref('nsfwWarningDismissed', true);
              setNsfwGateRoom(null);
              enterCommunityRoom(room);
            }}
            sx={{ borderRadius: 2, px: 2, textTransform: 'none' }}
          >
            Yes and don't remind me again.
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(error)}
        autoHideDuration={5000}
        onClose={() => setError('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" onClose={() => setError('')}>{error}</Alert>
      </Snackbar>
      </Box>

      {wide && (
        <Box sx={{ width: COLUMN_W, flexShrink: 0, borderLeft: 1, borderColor: 'divider' }}>
          {membersList}
        </Box>
      )}
    </Box>
    </Box>
  );
}
