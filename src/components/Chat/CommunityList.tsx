// Full list of user topics, shown in the chat center (via "Expand") instead of the feed. One row
// per topic, 30 per page, button pagination.
// Default sort "Newest" (final decision). "Latest reply" = activity over the last week (new OP and
// fresh reply count equally). "Top" = likes per week/month/year.
// sfw/nsfw are NOT in the filter: they follow the SITE header toggle — never two "show NSFW"
// settings.
// Filters are dropdowns, not pill rows (8 pills scrolled sideways on phones; dropdown width doesn't
// grow with options and shows a hint per item).
// No own title: "Threads" + back arrow live in the chat's shared top bar (channelBar in ChatView).
// Width and thumbnails per row come from a ResizeObserver on the list itself, not MUI breakpoints:
// the list sits between two columns, so xs/sm lie.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Avatar, Box, Button, CircularProgress, IconButton, InputBase, Menu, MenuItem,
  Stack, Tooltip, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import FavoriteIcon from '@mui/icons-material/Favorite';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ChatBubbleIcon from '@mui/icons-material/ChatBubble';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import {
  avatarUrlOf, saveChatPins, type ShoutChannel, type ShoutMessage,
} from '../Shoutbox/shoutboxApi';
import { pbDateMs } from '../CyoaPage/Comments/relativeTime';
import { useChatNotes } from '../Shoutbox/chatNotes';
import AnonMaskIcon from './AnonMaskIcon';
import {
  agoLabel, communityAuthor, fetchCommunityList, fetchCommunityMine, opImageUrlAt, opImages,
  stripOpTokens, toggleCommunityLike, fetchCommunitySitePins, COMMUNITY_PINS_MAX,
  type CommunityRoom, type CommunityMine, type CommunityRoomEvent, type CommunitySort, type CommunitySpan, type CommunityRating,
  type CommunityReact,
} from './communityApi';
import { EXTRA_TAGS, TAG_INFO, knownTags, type CommunityTag } from './communityTags';
import { useChatPrefs } from './chatPrefs';
import EmojiImg from '../Emoji/EmojiImg';
import { useEmojiPack } from '../Emoji/registry';
import HiddenImage from './HiddenImage';

const PER_PAGE = 30;

const SORT_KEYS: CommunitySort[] = ['new', 'active', 'top'];
const SPAN_KEYS: CommunitySpan[] = ['week', 'month', 'year'];

function paramSort(v: string | null): CommunitySort {
  return SORT_KEYS.includes(v as CommunitySort) ? v as CommunitySort : 'new';
}
function paramSpan(v: string | null): CommunitySpan {
  return SPAN_KEYS.includes(v as CommunitySpan) ? v as CommunitySpan : 'week';
}
function paramTag(v: string | null): CommunityTag | '' {
  return v && EXTRA_TAGS.includes(v as CommunityTag) ? v as CommunityTag : '';
}

function contentAllowed(room: CommunityRoom, tag: CommunityTag | '', needle: string) {
  const tags = room.tags ?? [];
  if (tag && !tags.includes(tag)) return false;
  if (needle.length >= 2 && !room.title.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) return false;
  return true;
}

function threadHref(room: CommunityRoom) {
  return `/chat/t/${encodeURIComponent(room.slug)}`;
}

function openThreadLink(
  e: React.MouseEvent<HTMLElement>, room: CommunityRoom, onOpen: (room: CommunityRoom) => void,
) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  e.preventDefault();
  onOpen(room);
}

// Sorts as labelled on the buttons; `active` second because the default is now "Newest".
const SORTS: { key: CommunitySort; label: string; hint: string }[] = [
  { key: 'new', label: 'Newest', hint: 'Newly started threads first' },
  { key: 'active', label: 'Latest activity', hint: 'Recently started or replied to in the last week' },
  { key: 'top', label: 'Top', hint: 'Most liked in the chosen window' },
];

const SPANS: { key: CommunitySpan; label: string }[] = [
  { key: 'week', label: 'week' },
  { key: 'month', label: 'month' },
  { key: 'year', label: 'year' },
];

// Thumbnails per row for a given list width. Low one-thumb threshold on purpose: on phones title +
// two summary lines must remain. Thumb side 64 (52 read as an icon, not an illustration).
const THUMB = 64;

function thumbsFor(width: number): number {
  // Thresholds derived from the tile (64 + gap ≈ 70 each): at 390 px two tiles squeezed the title
  // to "S…".
  if (width < 440) return 1;
  if (width < 540) return 2;
  if (width < 650) return 3;
  if (width < 760) return 4;
  return 5;
}

type Props = {
  // Adult toggle from the SITE header (sfw/all/nsfw). Chat deliberately has no own one.
  rating: CommunityRating;
  signedIn: boolean;
  onOpen: (room: CommunityRoom) => void;
  onCreate: () => void;
  // External update counter: when it changes, the list refetches (a just-created topic appears
  // without F5).
  reloadKey?: number;
  // Author's permanent rooms as a strip above topics: deliberately few, placed to show chatting
  // here is fine but starting your own topic is normal and expected.
  rooms?: ShoutChannel[];
  onOpenRoom?: (slug: string) => void;
  // "Channel has unread" — shared chat machinery: server last-message mark newer than local read
  // mark.
  hasNew?: (id: string) => boolean;
  // Tell the parent which topics we watch (ids go into the ping). The screen decides; nothing
  // beyond the horizon (page 2, older topics): thousands of topics would make every ping of every
  // tab a megabyte.
  onWatch?: (ids: string[]) => void;
  // Live chat message subscription from ChatView: one collection subscription per tab; a second for
  // a counter would receive every site message twice.
  onLiveMessage?: (fn: (m: ShoutMessage) => void) => () => void;
  onLiveRoom?: (fn: (e: CommunityRoomEvent) => void) => () => void;
  // New messages since my read mark. 0 = nothing to say: all read, or never opened (then just
  // "unread", no number possible).
  newCount?: (id: string) => number;
  // Viewer id: needed only to split "mine" into own topics vs replied-in (compare with `owner`).
  // Guests never get here.
  meId?: string;
  // Chat's own buttons (view gear, who's here) at the right edge of the filter row. Passed in
  // because their state lives in ChatView; here because the chat bar on this screen is gone (it and
  // the filter row were two rows for one screen).
  actions?: ReactNode;
};

export function TagWord({ tag }: { tag: string }) {
  const info = TAG_INFO[tag as keyof typeof TAG_INFO];
  if (!info) return null;
  return (
    <Tooltip title={info.hint}>
      <Box
        component="span"
        sx={{
          display: 'inline-block',
          px: 0.75,
          py: 0.1,
          borderRadius: 0.75,
          border: 1,
          borderColor: info.color,
          color: info.color,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.4,
          lineHeight: 1.6,
          whiteSpace: 'nowrap',
        }}
      >
        {info.label}
      </Box>
    </Tooltip>
  );
}

// OP reaction summary: up to three most frequent with counts. Same in the index row and the
// COLLAPSED topic header (which intentionally mirrors the row that was clicked — keep them
// identical). Three, not four: server sends four, but a fourth pill wraps next to date and reply
// count. NOT buttons: the whole row is inside one big "open topic" button (button-in-button is
// invalid), and people react after reading.
export function OpReacts({ top, max = 3 }: { top?: CommunityReact[]; max?: number }) {
  // Shortcode image from the pack; until it arrives render no pills (empty beats broken squares).
  const byName = useEmojiPack().byName;
  if (!top?.length) return null;
  return (
    <>
      {top.slice(0, max).map((re) => {
        const def = byName.get(re.n);
        if (!def) return null;
        return (
          <Tooltip key={re.n} title={`:${re.n}:`} disableInteractive>
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.3,
                px: 0.4,
                py: 0.1,
                borderRadius: 999,
                // Own reactions use the same blue as under the post: "I pressed this" must read the
                // same in both places.
                bgcolor: re.m ? 'rgba(88,101,242,0.22)' : 'rgba(255,255,255,0.06)',
                color: re.m ? '#c9cdfb' : 'text.secondary',
                fontWeight: 700,
              }}
            >
              <EmojiImg emoji={def} size={14} />
              {re.c}
            </Box>
          </Tooltip>
        );
      })}
    </>
  );
}

// "Something new" dot — the same as rooms in the left list; one signal for both.
function NewDot() {
  return (
    <Box sx={{
      width: 7,
      height: 7,
      borderRadius: '50%',
      bgcolor: 'primary.main',
      flexShrink: 0,
    }} />
  );
}

// Compact topic row for pins and activity sections. Not the list row (that's a showcase for
// choosing among strangers); but not a bare title either — one text line in an empty strip read as
// "broken". Same language as the feed (author face, tags, like), denser, one line.
function MiniRow({
  room, fresh, pinned, onOpen, onPin, onLike, signedIn,
}: {
  room: CommunityRoom;
  fresh: boolean;
  pinned?: boolean;
  onOpen: (room: CommunityRoom) => void;
  onPin?: (room: CommunityRoom) => void;
  onLike?: (room: CommunityRoom) => void;
  signedIn?: boolean;
}) {
  const author = communityAuthor(room);
  const owner = author.card;
  return (
    <Box sx={{
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' },
    }}>
      <Box
        component="a"
        href={threadHref(room)}
        onClick={(e: React.MouseEvent<HTMLElement>) => openThreadLink(e, room, onOpen)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.6,
          flex: 1,
          minWidth: 0,
          px: 1.25,
          py: 0.5,
          border: 0,
          bgcolor: 'transparent',
          color: 'inherit',
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          textDecoration: 'none',
        }}
      >
        {/* Dot slot on the left always reserved, or titles shift sideways when a reply arrives. */}
        {fresh ? <NewDot /> : <Box sx={{ width: 7, flexShrink: 0 }} />}

        <Avatar
          src={avatarUrlOf(owner)}
          sx={{ width: 20, height: 20, flexShrink: 0, fontSize: 10 }}
        >
          {author.anon ? <AnonMaskIcon sx={{ fontSize: 12 }} /> : (owner?.name || '?')[0]}
        </Avatar>

        <Typography sx={{
          fontSize: 13,
          fontWeight: fresh ? 700 : 500,
          color: fresh ? 'text.primary' : 'text.secondary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}>
          {room.title}
        </Typography>

        {/* Tags shrink first: seeing the full title matters more. */}
        <Box component="span" sx={{ display: 'inline-flex', gap: 0.5, flexShrink: 1, minWidth: 0, overflow: 'hidden' }}>
          {knownTags(room.tags).map((t) => <TagWord key={t} tag={t} />)}
        </Box>

        <Box component="span" sx={{
          ml: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.35,
          fontSize: 11,
          color: 'text.disabled',
          flexShrink: 0,
        }}>
          <ChatBubbleOutlineIcon sx={{ fontSize: 11 }} />
          {room.msgs}
          {room.last_at ? ` · ${agoLabel(room.last_at)}` : ''}
        </Box>
      </Box>

      {/* Like as a separate button next to the row, not inside: button-in-button is invalid markup. */}
      {onLike && (
        <Tooltip title={signedIn ? (room.liked ? 'Remove like' : 'Like') : 'Sign in to like'}>
          <Box component="span" sx={{ flexShrink: 0 }}>
            <Box
              component="button"
              type="button"
              aria-label={room.liked ? 'Remove like' : 'Like'}
              aria-pressed={Boolean(room.liked)}
              disabled={!signedIn}
              onClick={() => onLike(room)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.3,
                px: 0.5,
                py: 0.4,
                border: 0,
                bgcolor: 'transparent',
                color: room.liked ? 'error.main' : 'text.disabled',
                fontFamily: 'inherit',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
                cursor: signedIn ? 'pointer' : 'default',
              }}
            >
              {room.liked
                ? <FavoriteIcon sx={{ fontSize: 12 }} />
                : <FavoriteBorderIcon sx={{ fontSize: 12 }} />}
              {room.likes || ''}
            </Box>
          </Box>
        </Tooltip>
      )}

      {onPin && (
        <Tooltip title={pinned ? 'Unpin' : 'Pin this thread'}>
          <Box
            component="button"
            type="button"
            aria-label={pinned ? 'Unpin' : 'Pin this thread'}
            aria-pressed={Boolean(pinned)}
            onClick={() => onPin(room)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              px: 0.75,
              py: 0.4,
              border: 0,
              bgcolor: 'transparent',
              color: pinned ? 'primary.main' : 'text.disabled',
              cursor: 'pointer',
              '&:hover': { color: 'text.primary' },
            }}
          >
            {pinned
              ? <PushPinIcon sx={{ fontSize: 14 }} />
              : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
          </Box>
        </Tooltip>
      )}
    </Box>
  );
}

// Shelf heading in "mine": a seam between two different lists (not SectionCap, which labels one
// shelf). Larger, centered, lighter; the lower one gets a blank line above.
function MineCap({ children, gap }: { children: ReactNode; gap?: boolean }) {
  return (
    <Box sx={{
      display: 'flex',
      justifyContent: 'center',
      px: 1.25,
      pt: gap ? 3 : 1.5,
      pb: 0.75,
      fontSize: 12.5,
      fontWeight: 800,
      letterSpacing: 1,
      textTransform: 'uppercase',
      color: 'text.secondary',
    }}>
      {children}
    </Box>
  );
}

// Empty-shelf label in "mine": shelves stay visible when empty — the user must see BOTH headings,
// or it's unclear whether the list is empty or the button failed.
function MineNote({ children }: { children: ReactNode }) {
  return (
    <Typography align="center" sx={{ px: 1.25, pb: 1.25, fontSize: 12, color: 'text.disabled' }}>
      {children}
    </Typography>
  );
}

// Personal-block section heading: small caps-spaced — the real screen title ("Threads") is above in
// the chat bar.
function SectionCap({ children }: { children: ReactNode }) {
  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 0.75,
      px: 1.25,
      pt: 1.25,
      pb: 0.5,
      fontSize: 10.5,
      fontWeight: 800,
      letterSpacing: 0.7,
      textTransform: 'uppercase',
      color: 'text.disabled',
    }}>
      {children}
    </Box>
  );
}

export default function CommunityList({
  rating, signedIn, onOpen, onCreate, reloadKey = 0,
  rooms: permanentRooms = [], onOpenRoom, hasNew, onWatch, newCount, onLiveMessage, onLiveRoom,
  meId, actions,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const pinsBottom = useChatPrefs().threadPinsBottom;

  // Every param has its own prefix: the topic list lives in the URL of the same page as the catalog
  // feed; bare `sort`/`q` hit the other filter — `?sort=active` from chat broke the catalog feed
  // (no such sort there) and it stopped loading.
  const [sort, setSort] = useState<CommunitySort>(() => paramSort(searchParams.get('chatSort')));
  const [span, setSpan] = useState<CommunitySpan>(() => paramSpan(searchParams.get('chatSpan')));
  const [tag, setTag] = useState<CommunityTag | ''>(() => paramTag(searchParams.get('chatTag')));
  const [page, setPage] = useState(() => Math.max(1, Number(searchParams.get('chatPage')) || 1));
  // Search: typed value vs debounced query value, else every letter costs a DB request on a modest
  // server.
  const [query, setQuery] = useState(() => searchParams.get('chatQ') ?? '');
  const [needle, setNeedle] = useState(() => {
    const q = (searchParams.get('chatQ') ?? '').trim();
    return q.length >= 2 ? q : '';
  });
  // Search expanded? Collapsed = header icon (rarely used, always took space). With a typed query
  // the row stays open regardless, or it's unclear why the list is short.
  const [searchOpen, setSearchOpen] = useState(() => searchParams.has('chatQ'));
  const searchOn = searchOpen || Boolean(query);
  const closeSearch = useCallback(() => { setQuery(''); setSearchOpen(false); }, []);
  const [onlyMine, setOnlyMine] = useState(() => searchParams.get('chatMine') === '1');
  // Which of the three dropdowns is open — one state (only one can be open; three flags would need
  // manual mutual exclusion).
  const [menu, setMenu] = useState<{ kind: 'sort' | 'span' | 'tag'; el: HTMLElement } | null>(null);
  const [rooms, setRooms] = useState<CommunityRoom[]>([]);
  // List failed (network, 5xx) — separate from empty: network failure used to look like "no topics"
  // and people left thinking the section was empty.
  const [netFail, setNetFail] = useState(false);
  // "Retry" via a key, not a manual call: a refetch is exactly the filter-change effect, with all
  // its race handling.
  const [retryKey, setRetryKey] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const allow = useCallback(
    (room: CommunityRoom) => contentAllowed(room, tag, needle),
    [tag, needle],
  );

  // Measure the list's own width: it sits between columns; on wide screens it gets far less than
  // the viewport.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const thumbs = thumbsFor(width || 720);
  // Single-line header only when everything truly fits; otherwise "NEW THREAD" got truncated (as on
  // phones).
  const wideHead = (width || 720) >= 700;
  // Intermediate width: short "Thread" label. Bare plus only on the narrowest — nobody recognizes
  // an unlabeled icon as "start topic".
  const midHead = (width || 720) >= 430;

  // Any sort/filter change returns to page 1: page 7 of another list shows emptiness.
  const filtersMounted = useRef(false);
  useEffect(() => {
    if (!filtersMounted.current) { filtersMounted.current = true; return; }
    setPage(1);
  }, [sort, span, tag, needle, onlyMine]);

  // 350 ms debounce: feels instant, but a whole word fits into one request instead of six.
  useEffect(() => {
    const t = setTimeout(() => {
      const q = query.trim();
      setNeedle(q.length >= 2 ? q : '');
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  // The list URL is the durable view state: browser Back, a copied link and a newly opened tab all
  // return to the same filter/page instead of "All tags".
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const put = (key: string, value: string, defaultValue = '') => {
      if (!value || value === defaultValue) next.delete(key); else next.set(key, value);
    };
    put('chatSort', sort, 'new');
    put('chatSpan', sort === 'top' ? span : '', 'week');
    put('chatTag', tag);
    put('chatPage', page > 1 ? String(page) : '');
    put('chatQ', query.trim());
    put('chatMine', onlyMine ? '1' : '');
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [sort, span, tag, page, query, onlyMine, searchParams, setSearchParams]);

  // Silent refetch: like `reloadKey` but no spinner and no jump to page 1. Driven by the "pulse"
  // below.
  const [quietKey, setQuietKey] = useState(0);
  const quietRef = useRef(0);
  const pulseRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Spinner only on filter change: a silent refetch runs over the drawn list; blanking it for
    // half a second for an updated counter is worse than not updating.
    if (quietRef.current === quietKey) setLoading(true);
    quietRef.current = quietKey;
    fetchCommunityList({
      page, per: PER_PAGE, sort, span, tag, q: needle, mine: onlyMine,
    }).then((res) => {
      if (!alive) return;
      setNetFail(!!res.failed);
      // A failed SILENT refetch must not wipe the drawn list: keep the old one; the error line
      // above says "couldn't reach".
      if (!res.failed || rooms.length === 0) {
        setRooms(res.rooms);
        setTotal(res.total);
      }
      setLoading(false);
      if (!res.failed) fetchedAtRef.current = Date.now();
    });
    return () => { alive = false; };
    // `rooms` intentionally not in deps: used only for "is there anything to keep on screen";
    // subscribing would refetch on every reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, span, tag, needle, onlyMine, reloadKey, quietKey, retryKey]);

  const fetchedAtRef = useRef(0);

  // Returning to the screen is the only refresh trigger for what the ping doesn't report (likes,
  // title edits, removed topics). On return, not on a timer: /community/list is personal (`private,
  // no-store` due to the "I liked" flag), not edge-cached, costs two DB queries. At most once per
  // 20 s.
  const aliveAtRef = useRef(Date.now());

  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      aliveAtRef.current = Date.now();
      if (Date.now() - fetchedAtRef.current < 20_000) return;
      setQuietKey((k) => k + 1);
    };
    const touch = () => { aliveAtRef.current = Date.now(); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(ev, touch, { passive: true });
    }

    // Timer poll covers the last gap (someone likes while you stare at this screen). Three
    // conditions cut cost: topic screen OPEN (component lifetime), tab foreground, user active in
    // last 2 min. A week-old forgotten tab costs nothing. Cost: two DB queries per minute per
    // active viewer; audience of the INDEX is small by definition.
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - aliveAtRef.current > 120_000) return;
      if (Date.now() - fetchedAtRef.current < 20_000) return;
      setQuietKey((k) => k + 1);
    }, 60_000);

    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
        window.removeEventListener(ev, touch);
      }
    };
  }, []);

  // "Something happened in visible topics" as one string for value comparison. Derived from the
  // PING (per minute), not the list, so a refetch doesn't retrigger itself.
  const pulseSig = rooms
    .map((r) => `${r.id}:${newCount?.(r.id) ?? 0}:${hasNew?.(r.id) ? 1 : 0}`)
    .join(',');

  useEffect(() => {
    // First computation isn't an event: the list just arrived.
    if (pulseRef.current === null) { pulseRef.current = pulseSig; return; }
    if (pulseRef.current === pulseSig) return;
    pulseRef.current = pulseSig;
    // Reply counts and likes come with the LIST, not the ping: otherwise "7" stayed 7 until reload
    // next to a glowing "+2". Costs one request per minute, only on change.
    setQuietKey((k) => k + 1);
  }, [pulseSig]);

  // Patch a like in place: refetching would reset scroll; the server returned the result anyway.
  const like = useCallback(async (room: CommunityRoom) => {
    if (!signedIn) return;
    try {
      const res = await toggleCommunityLike(room.id);
      const patch = (r: CommunityRoom) => (
        r.id === room.id ? { ...r, likes: res.likes, liked: res.liked } : r
      );
      setRooms((cur) => cur.map(patch));
      // The same topic can be in pins and "where you posted", possibly absent from the open page.
      // Patch ALL three places, or the pinned heart stays grey.
      setRoomIndex((cur) => (cur[room.id] ? { ...cur, [room.id]: patch(cur[room.id]) } : cur));
      setMine((cur) => ({ ...cur, pins: cur.pins.map(patch), recent: cur.recent.map(patch) }));
      setSitePins((cur) => cur.map(patch));
    } catch { }
  }, [signedIn]);

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));

  // "Mine" split into two lists: topics I started and topics I only replied in. Split here, not on
  // the server (server already sends that set: 10 own + 20 replied; ownership visible by `owner`).
  // Own + replied goes UP. `r.mine` covers anonymous topics: no owner in the record, only the
  // server knows (communityApi).
  const mineOwn = useMemo(
    () => (meId ? rooms.filter((r) => r.owner === meId || r.mine) : []),
    [rooms, meId],
  );
  const mineIn = useMemo(
    () => (meId ? rooms.filter((r) => r.owner !== meId && !r.mine) : rooms),
    [rooms, meId],
  );

  // Pins come from shared chat state: same field as pinned DMs, part of it points to topics. No
  // separate "pinned topics" in the schema on purpose.
  const { pins: allPins } = useChatNotes();
  const [mine, setMine] = useState<CommunityMine>({ pins: [], recent: [], posted: [] });
  // Where I posted — a Set, checked on every feed row.
  const postedIds = useMemo(() => new Set(mine.posted), [mine.posted]);
  // Shared pins (moderator-pinned for EVERYONE): own state, not part of `mine` — same for all incl.
  // guests, while `/community/mine` requires auth and is cached per person. Until the author
  // applies the PB script the server returns empty — no block, the correct "nothing pinned yet"
  // view.
  const [sitePins, setSitePins] = useState<CommunityRoom[]>([]);
  useEffect(() => {
    let alive = true;
    void fetchCommunitySitePins().then((res) => { if (alive) setSitePins(res.rooms); });
    return () => { alive = false; };
  }, [reloadKey]);

  // Guests don't call it: RequireAuth would 401 on every open. Empty response draws the placeholder
  // row (block stays so layout doesn't jump across devices/accounts).
  useEffect(() => {
    if (!signedIn) { setMine({ pins: [], recent: [], posted: [] }); return undefined; }
    let alive = true;
    fetchCommunityMine().then((res) => { if (alive) setMine(res); });
    return () => { alive = false; };
  // allPins in deps so a pin appears in the block immediately, not after a minute of server cache.
  }, [signedIn, reloadKey, allPins]);

  // What's pinned is known from `allPins`, NOT the server topic response. Both button and block
  // used to read `mine.pins` (the cached /community/mine): clicks did nothing until next fetch, F5
  // showed pins retroactively, a second click was read as "pin again" — unpinning took minutes.
  // Pins are set instantly and locally (saveChatPins); render from that.
  const pinnedIds = useMemo(() => new Set(allPins), [allPins]);

  // Own id → topic store for the personal block: a just-pinned topic comes from the on-screen list,
  // the server returns it only in the next /community/mine. Without the store the pin row appears
  // with the delay we're avoiding.
  const [roomIndex, setRoomIndex] = useState<Record<string, CommunityRoom>>({});
  useEffect(() => {
    setRoomIndex((cur) => {
      const next = { ...cur };
      for (const r of [...mine.pins, ...mine.recent, ...rooms]) next[r.id] = r;
      return next;
    });
  }, [mine, rooms]);

  // Live reply → bump the counter in place, no request. The subscription brings ALL site messages
  // incl. off-screen topics; previously dropped, so "7" stayed next to a lit "+1". Patch all four
  // places (feed, shared and personal pins, `roomIndex`, which resolves pins not on the open page).
  // Unknown topics aren't inserted: only the server knows their sort position; guessing makes rows
  // jump on refetch.
  useEffect(() => {
    if (!onLiveMessage) return undefined;
    return onLiveMessage((m) => {
      const id = m.channel;
      if (!id) return;
      const at = Math.floor(pbDateMs(m.created) / 1000);
      const bump = (r: CommunityRoom): CommunityRoom => (
        r.id === id ? { ...r, msgs: r.msgs + 1, last_at: Math.max(r.last_at, at) } : r
      );
      const has = (list: CommunityRoom[]) => list.some((r) => r.id === id);
      setRooms((cur) => (has(cur) ? cur.map(bump) : cur));
      setSitePins((cur) => (has(cur) ? cur.map(bump) : cur));
      setMine((cur) => (has(cur.pins) || has(cur.recent)
        ? { ...cur, pins: cur.pins.map(bump), recent: cur.recent.map(bump) }
        : cur));
      setRoomIndex((cur) => (cur[id] ? { ...cur, [id]: bump(cur[id]) } : cur));
    });
  }, [onLiveMessage]);

  // Live topic event (like, OP edit, new, removed). Computed fields (`msgs`, `last_at`) arrive as
  // zero (the server computes them from messages; the event comes straight from the DB) — carry
  // them over from the drawn row instead of replacing. New/removed → silent refetch: only the
  // server knows position and page.
  useEffect(() => {
    if (!onLiveRoom) return undefined;
    return onLiveRoom((e) => {
      const id = e.room.id;
      const gone = e.action === 'delete' || e.room.hidden;
      if (e.action === 'create' || gone) {
        if (gone) {
          const drop = (list: CommunityRoom[]) => list.filter((r) => r.id !== id);
          setRooms(drop);
          setSitePins(drop);
          setMine((cur) => ({ ...cur, pins: drop(cur.pins), recent: drop(cur.recent) }));
        }
        setQuietKey((k) => k + 1);
        return;
      }
      const merge = (r: CommunityRoom): CommunityRoom => (
        r.id === id ? { ...e.room, msgs: r.msgs, last_at: r.last_at } : r
      );
      const has = (list: CommunityRoom[]) => list.some((r) => r.id === id);
      setRooms((cur) => (has(cur) ? cur.map(merge).filter(allow) : cur));
      setSitePins((cur) => (has(cur) ? cur.map(merge).filter(allow) : cur));
      setMine((cur) => (has(cur.pins) || has(cur.recent)
        ? { ...cur, pins: cur.pins.map(merge), recent: cur.recent.map(merge) }
        : cur));
      setRoomIndex((cur) => (cur[id] ? { ...cur, [id]: merge(cur[id]) } : cur));
      // The update may also make a previously excluded thread eligible; only the server knows its
      // correct page and sort position.
      setQuietKey((k) => k + 1);
    });
  }, [onLiveRoom, allow]);

  // Pinned TOPICS in user order. The shared pin list also contains DMs — exclude; a topic is what
  // we know as a topic.
  const threadPins = useMemo(
    () => allPins
      .map((id) => roomIndex[id])
      .filter((r): r is CommunityRoom => Boolean(r) && allow(r as CommunityRoom)),
    [allPins, roomIndex, allow],
  );
  const visibleSitePins = useMemo(() => sitePins.filter(allow), [sitePins, allow]);

  // Pin/unpin sends the whole pin list: pin, unpin and reorder are three actions on ONE order (see
  // /pins); separately they'd diverge from the screen.
  const togglePin = useCallback((room: CommunityRoom) => {
    if (!signedIn) return;
    const on = !pinnedIds.has(room.id);
    if (on && threadPins.length >= COMMUNITY_PINS_MAX) return;
    const next = on
      ? [...allPins, room.id]
      : allPins.filter((id) => id !== room.id);
    // Rejection rolls back the screen itself (saveChatPins): the pin snaps back, more honest than
    // any message.
    saveChatPins(next).catch(() => {});
  }, [signedIn, pinnedIds, threadPins.length, allPins]);

  // Watch set for dots: pins, activity section, then the list page. The server truncates at
  // PING_WATCH_MAX — order matters: personal first, list fills the rest.
  const watchIds = useMemo(() => {
    const out: string[] = [];
    const add = (id: string) => { if (!out.includes(id)) out.push(id); };
    threadPins.forEach((r) => add(r.id));
    mine.recent.forEach((r) => add(r.id));
    rooms.forEach((r) => add(r.id));
    return out;
  }, [threadPins, mine.recent, rooms]);
  useEffect(() => { onWatch?.(watchIds); }, [watchIds, onWatch]);
  // Leaving the screen → stop asking for dots; the ping would keep carrying ~20 ids a minute for
  // nothing.
  useEffect(() => () => onWatch?.([]), [onWatch]);

  // Dropdown handle labelled with the CURRENT value ("Newest", not "Sort: Newest" — doesn't fit on
  // phones).
  const picker = (
    kind: 'sort' | 'span' | 'tag',
    label: string,
    hint: string,
    color?: string,
  ) => (
    <Tooltip key={kind} title={hint} disableInteractive>
      <Box
        component="button"
        type="button"
        onClick={(e: React.MouseEvent<HTMLElement>) => setMenu({ kind, el: e.currentTarget })}
        aria-haspopup="listbox"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.1,
          flexShrink: 0,
          pl: 1,
          pr: 0.25,
          py: 0.35,
          maxWidth: 160,
          border: 1,
          borderColor: color ?? 'divider',
          borderRadius: 999,
          bgcolor: color ? `${color}1f` : 'transparent',
          color: color ?? 'text.secondary',
          fontFamily: 'inherit',
          fontSize: 11.5,
          fontWeight: 700,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.07)', color: color ?? 'text.primary' },
        }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
        <ArrowDropDownIcon sx={{ fontSize: 16, flexShrink: 0 }} />
      </Box>
    </Tooltip>
  );

  // Menu item: value on top, purpose line below, visible without hover ("Latest reply" vs "Top"
  // differ exactly by that line).
  const item = (
    key: string,
    label: string,
    hint: string,
    on: boolean,
    pick: () => void,
    color?: string,
  ) => (
    <MenuItem
      key={key}
      selected={on}
      onClick={() => { pick(); setMenu(null); }}
      sx={{ py: 0.5, alignItems: 'flex-start', flexDirection: 'column', gap: 0 }}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 700, color: color ?? 'text.primary' }}>
        {label}
      </Typography>
      {hint && (
        <Typography sx={{ fontSize: 11, color: 'text.secondary', whiteSpace: 'normal', maxWidth: 240 }}>
          {hint}
        </Typography>
      )}
    </MenuItem>
  );

  const curSort = SORTS.find((o) => o.key === sort) ?? SORTS[0];
  const curSpan = SPANS.find((o) => o.key === span) ?? SPANS[0];
  const curTag = tag ? TAG_INFO[tag] : null;

  const filters = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, flexShrink: 1 }}>
      {picker('sort', curSort.label, curSort.hint)}

      {/*
        Window only for "Top": for Newest/Latest reply it means nothing; a lingering "week" would
        lie.
      */}
      {sort === 'top' && picker('span', curSpan.label, `Most liked over the last ${curSpan.label}`)}

      {picker(
        'tag',
        curTag ? curTag.label : 'All tags',
        curTag ? curTag.hint : 'Every thread, whatever it is tagged',
        curTag?.color,
      )}

      <Menu
        open={menu?.kind === 'sort'}
        anchorEl={menu?.el ?? null}
        onClose={() => setMenu(null)}
        slotProps={{ paper: { sx: { minWidth: 220 } } }}
      >
        {SORTS.map((o) => item(o.key, o.label, o.hint, sort === o.key, () => setSort(o.key)))}
      </Menu>

      <Menu open={menu?.kind === 'span'} anchorEl={menu?.el ?? null} onClose={() => setMenu(null)}>
        {SPANS.map((o) => item(
          `s-${o.key}`, o.label, `Most liked over the last ${o.label}`, span === o.key,
          () => setSpan(o.key),
        ))}
      </Menu>

      <Menu
        open={menu?.kind === 'tag'}
        anchorEl={menu?.el ?? null}
        onClose={() => setMenu(null)}
        slotProps={{ paper: { sx: { minWidth: 220 } } }}
      >
        {/* "All tags" as its own item: nobody discovers "click the selected one again to clear". */}
        {item('t-', 'All tags', 'Every thread, whatever it is tagged', tag === '', () => setTag(''))}
        {EXTRA_TAGS.map((t) => item(
          `t-${t}`, TAG_INFO[t].label, TAG_INFO[t].hint, tag === t, () => setTag(t), TAG_INFO[t].color,
        ))}
      </Menu>
    </Box>
  );

  const createBtn = (
    <Tooltip title="Start a thread (10 per day)" disableInteractive>
      <Button
        variant="contained"
        size="small"
        onClick={onCreate}
        startIcon={<AddIcon sx={{ fontSize: wideHead ? 18 : 16 }} />}
        sx={{
          flexShrink: 0,
          ml: 0.25,
          px: { xs: 1.25, sm: 1.75 },
          fontSize: 12.5,
          fontWeight: 800,
          whiteSpace: 'nowrap',
          // Label shrinks with width but doesn't disappear: a bare plus reads as "another filter"
          // or "expand". Phones get "Thread"; only the narrowest column gets the icon alone.
          ...(wideHead ? {} : {
            px: 0.75,
            fontSize: 11,
            letterSpacing: 0,
            minWidth: midHead ? 0 : 34,
            '& .MuiButton-startIcon': midHead ? { mr: 0.35, ml: 0 } : { m: 0 },
          }),
        }}
      >
        {/*
          Label nudged 1.5 px down: caps have no descenders, so geometric centering reads as
          shifted up next to the honestly centered icon.
        */}
        <Box component="span" sx={{ display: 'inline-block', transform: 'translateY(1.5px)' }}>
          {wideHead ? 'New thread' : midHead ? 'Thread' : ''}
        </Box>
      </Button>
    </Tooltip>
  );

  // "Mine" = topics I started AND topics I replied in (people remember their own topics but lose
  // the one they replied to a week ago). Counts decided by the server (10 own, 20 replied). Guests
  // see it disabled, not removed — removing broke the header layout.
  const mineBtn = (
    <Tooltip
      title={signedIn
        ? 'Threads you started, plus the ones you replied in'
        : 'Sign in to see your own threads'}
      disableInteractive
    >
      <Box component="span" sx={{ flexShrink: 0 }}>
        <Box
          component="button"
          type="button"
          aria-pressed={onlyMine}
          disabled={!signedIn}
          onClick={() => setOnlyMine((v) => !v)}
          sx={{
            px: 1,
            py: 0.35,
            border: 1,
            borderColor: onlyMine ? 'primary.main' : 'divider',
            borderRadius: 999,
            bgcolor: onlyMine ? 'primary.main' : 'transparent',
            color: onlyMine ? '#111' : 'text.secondary',
            opacity: signedIn ? 1 : 0.4,
            fontFamily: 'inherit',
            fontSize: 11.5,
            fontWeight: 700,
            whiteSpace: 'nowrap',
            cursor: signedIn ? 'pointer' : 'default',
          }}
        >
          Mine
        </Box>
      </Box>
    </Tooltip>
  );

  // Row renderer as a function (not inline in .map): "mine" renders TWO chunks and inline markup
  // would duplicate ~300 lines. Not useMemo or component: depends on half a dozen closures; props
  // would cost more than re-rendering a list that re-renders fully on each response anyway.
  const renderRow = (r: CommunityRoom) => {
    const author = communityAuthor(r);
  const owner = author.card;
    const names = opImages(r);
    const shown = names.slice(0, thumbs);
    const extra = names.length - shown.length;
    const snippet = r.op_text || r.description || '';
    const blurNsfw = rating === 'sfw' && (r.tags ?? []).includes('nsfw');
    // Unread = "new since my read" OR "never opened" (no mark = unread). Style the READ rows, not
    // unread: for a newcomer everything is unread and highlighting it distinguishes nothing.
    const unread = Boolean(hasNew?.(r.id));
    // The count exists only for opened topics; "+50" on every never-opened row would lie about
    // novelty.
    const fresh = newCount?.(r.id) ?? 0;
    // "I was here": own or replied topic (last thirty, see shoutCommunityPostedN). No deeper
    // history — beyond the list horizon anyway.
    const joined = Boolean(meId) && (r.owner === meId || r.mine || postedIds.has(r.id));
    return (
      <Box
        key={r.id}
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1.25,
          // Left stripe marks "not visited yet": peripheral vision catches a vertical bar during
          // fast scroll, not two greys. Transparent on read rows so text doesn't shift 2 px.
          borderLeft: 2,
          borderLeftColor: unread ? 'primary.main' : 'transparent',
          pl: { xs: 1, sm: 1.5 },
          pr: { xs: 1, sm: 1.5 },
          py: 0.85,
          borderBottom: 1,
          // borderBottomColor, NOT borderColor: the shorthand paints all four sides and silently
          // erased the unread stripe above — this one line made the mark appear nowhere.
          borderBottomColor: 'divider',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.035)' },
        }}
      >
        {/*
          Left column: author avatar with the like below. Like moved from the right edge (with pin
          it ate ~100 px of text). Space under the avatar ALWAYS exists (row is never below 34+20
          px); rows also became equal height.
        */}
        <Box sx={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          // Full-height column: avatar stays by the title; the like centers in the REMAINING space
          // (looks even, larger hit area).
          alignSelf: 'stretch',
          mt: 0.25,
        }}>
          <Avatar
            src={avatarUrlOf(owner)}
            sx={{
              width: 34, height: 34, flexShrink: 0, fontSize: 14,
              opacity: unread ? 1 : 0.75,
            }}
          >
            {author.anon ? <AnonMaskIcon sx={{ fontSize: 20 }} /> : (owner?.name || '?')[0]}
          </Avatar>

          {/*
            Like shown but disabled for guests: the server would refuse, and a hidden button reads
            as "no likes here at all".
          */}
          <Tooltip title={signedIn ? (r.liked ? 'Remove like' : 'Like') : 'Sign in to like'}>
            {/*
              Wrapper takes all space under the avatar and centers the like: the empty height is
              the finger hit area.
            */}
            <Box component="span" sx={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              minHeight: 22,
            }}>
              <Box
                component="button"
                type="button"
                aria-label={r.liked ? 'Remove like' : 'Like'}
                aria-pressed={Boolean(r.liked)}
                onClick={() => void like(r)}
                disabled={!signedIn}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.3,
                  px: 0.5,
                  py: 0.35,
                  border: 0,
                  borderRadius: 999,
                  bgcolor: 'transparent',
                  color: r.liked ? 'error.main' : 'text.disabled',
                  fontFamily: 'inherit',
                  fontSize: 11.5,
                  fontWeight: 700,
                  lineHeight: 1,
                  cursor: signedIn ? 'pointer' : 'default',
                  '&:hover': signedIn ? { bgcolor: 'rgba(255,255,255,0.07)' } : {},
                }}
              >
                {r.liked
                  ? <FavoriteIcon sx={{ fontSize: 13 }} />
                  : <FavoriteBorderIcon sx={{ fontSize: 13 }} />}
                {r.likes || ''}
              </Box>
            </Box>
          </Tooltip>
        </Box>

        <Box
          component="a"
          href={threadHref(r)}
          onClick={(e: React.MouseEvent<HTMLElement>) => openThreadLink(e, r, onOpen)}
          sx={{
            flex: 1,
            minWidth: 0,
            p: 0,
            // Padding for the bottom-right pin: without images the text would run under the icon.
            // Order matters — `p: 0` above would override it.
            pr: 3,
            border: 0,
            bgcolor: 'transparent',
            color: 'inherit',
            fontFamily: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
            textDecoration: 'none',
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
              <Typography sx={{
                fontSize: 15,
                fontWeight: 700,
                // Read → only the title greys out: dimming the whole card (tags, OP images) read as
                // "hidden by moderator", not "already read".
                color: unread ? 'text.primary' : 'text.secondary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}>
                {r.title}
              </Typography>
              {knownTags(r.tags).map((t) => <TagWord key={t} tag={t} />)}
            </Stack>

            {/*
              OP summary — two lines (one truncated line doesn't say what the topic is). Markup
              deliberately NOT parsed: emoji in the summary are noise and a spoiler revealed in the
              index stops being a spoiler.
            */}
            {snippet && (
              <Typography sx={{
                mt: 0.25,
                fontSize: 12.5,
                lineHeight: 1.45,
                color: 'text.secondary',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}>
                {stripOpTokens(snippet)}
              </Typography>
            )}

            {/*
              Row caption: author, created, message count, last reply — "who" to "when", like a
              game card in the catalog.
            */}
            <Stack
              direction="row"
              spacing={0.75}
              alignItems="center"
              sx={{ mt: 0.5, fontSize: 11, color: 'text.disabled', flexWrap: 'wrap', rowGap: 0.25 }}
            >
              <Box component="span" sx={{ fontWeight: 700, color: author.color || 'text.secondary' }}>
                {author.name}
              </Box>
              <Tooltip title={new Date(r.created * 1000).toLocaleString()} disableInteractive>
                <Box component="span">· {agoLabel(r.created)}</Box>
              </Tooltip>
              {/*
                Filled bubble instead of outlined = "I posted here" (no third colored mark next to
                tags). Red "+3" is the only color in the caption — intentionally, it's why people
                scan it.
              */}
              <Tooltip
                title={joined ? 'You posted here' : `${r.msgs} replies`}
                disableInteractive
              >
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35, ml: 0.5 }}>
                  {joined
                    ? <ChatBubbleIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
                    : <ChatBubbleOutlineIcon sx={{ fontSize: 12 }} />}
                  {r.msgs}
                  {fresh > 0 && (
                    <Box component="span" sx={{ color: 'primary.main', fontWeight: 800 }}>
                      {`(+${fresh >= 50 ? '50+' : fresh})`}
                    </Box>
                  )}
                </Box>
              </Tooltip>
              <Tooltip
                title={r.last_at ? new Date(r.last_at * 1000).toLocaleString() : 'No replies yet'}
                disableInteractive
              >
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.35 }}>
                  <ScheduleIcon sx={{ fontSize: 12 }} />
                  {r.last_at ? agoLabel(r.last_at) : 'no replies'}
                </Box>
              </Tooltip>

              <OpReacts top={r.op_top} />
            </Stack>
          </Box>
        </Box>

        {/*
          OP thumbnails as squares at the right edge; show as many as fit (for collection topics
          the images ARE the content). thumbsFor computes by LIST WIDTH; phones get one. They sit
          NEXT TO the row button, not inside (the row has its own like/pin buttons now); clicking
          an image still opens the topic, so they're hidden from keyboard/screen readers — the
          title button opens it.
        */}
        {shown.length > 0 && (
          <Box
            onClick={() => onOpen(r)}
            sx={{ display: 'flex', gap: 0.5, flexShrink: 0, mt: 0.25, cursor: 'pointer' }}
          >
            {shown.map((_, i) => (
              <Box
                key={i}
                sx={{ position: 'relative', width: THUMB, height: THUMB, flexShrink: 0 }}
              >
                <HiddenImage
                  src={opImageUrlAt(r, i, '160x160') ?? ''}
                  revealKey={`thread-list:${r.id}:${i}`}
                  alt=""
                  loading="lazy"
                  blurUntilClicked={blurNsfw}
                  sx={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    borderRadius: 1,
                    border: 1,
                    borderColor: 'divider',
                  }}
                />
                {/* "+N" on the last tile, not a separate tile (that would take a real image's slot). */}
                {i === shown.length - 1 && extra > 0 && (
                  <Box sx={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 1,
                    bgcolor: 'rgba(0,0,0,0.55)',
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 800,
                  }}>
                    +{extra}
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

        {/*
          Pin in the bottom-right corner under the images (space there is empty; like moved under
          avatar so they don't compete). Disabled for guests, same as like.
        */}
        <Tooltip
          title={!signedIn
            ? 'Sign in to pin'
            : pinnedIds.has(r.id)
              ? 'Unpin'
              : threadPins.length >= COMMUNITY_PINS_MAX
                ? `All ${COMMUNITY_PINS_MAX} pins are taken`
                : 'Pin this thread'}
        >
          <Box
            component="span"
            sx={{ position: 'absolute', right: 4, bottom: 2 }}
          >
            <Box
              component="button"
              type="button"
              aria-label={pinnedIds.has(r.id) ? 'Unpin' : 'Pin this thread'}
              aria-pressed={pinnedIds.has(r.id)}
              onClick={() => togglePin(r)}
              disabled={!signedIn
                || (!pinnedIds.has(r.id) && threadPins.length >= COMMUNITY_PINS_MAX)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                px: 0.75,
                py: 0.35,
                border: 0,
                borderRadius: 999,
                bgcolor: 'transparent',
                color: pinnedIds.has(r.id) ? 'primary.main' : 'text.disabled',
                cursor: signedIn ? 'pointer' : 'default',
                '&:disabled': { opacity: 0.4, cursor: 'default' },
                '&:hover:not(:disabled)': { bgcolor: 'rgba(255,255,255,0.07)' },
              }}
            >
              {pinnedIds.has(r.id)
                ? <PushPinIcon sx={{ fontSize: 14 }} />
                : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
            </Box>
          </Box>
        </Tooltip>
      </Box>
    );
  };

  // Personal pins: ten slots (five made sense while the block was on TOP and every slot pushed the
  // feed; at the bottom that cost is gone). No empty block — no "nothing pinned" hint, no guest
  // row. The "3/10" counter stays: it tells the cap.
  const pinsBlock = signedIn && threadPins.length > 0 && (
    <Box sx={pinsBottom
      ? { borderTop: 1, borderColor: 'divider', pb: 0.5 }
      : { borderBottom: 1, borderColor: 'divider', pb: 0.5 }}
    >
      <SectionCap>
        Pinned
        <Box component="span" sx={{ letterSpacing: 0, fontWeight: 600 }}>
          {`${threadPins.length}/${COMMUNITY_PINS_MAX}`}
        </Box>
      </SectionCap>
      {threadPins.map((r) => (
        <MiniRow
          key={r.id}
          room={r}
          fresh={Boolean(hasNew?.(r.id))}
          pinned
          onOpen={onOpen}
          onPin={togglePin}
          onLike={like}
          signedIn={signedIn}
        />
      ))}
    </Box>
  );

  const clearFilters = useCallback(() => {
    setSort('new');
    setSpan('week');
    setTag('');
    setPage(1);
    setQuery('');
    setNeedle('');
    setOnlyMine(false);
    setSearchOpen(false);
  }, []);
  const hasResettableFilters = sort !== 'new' || span !== 'week' || tag !== ''
    || page !== 1 || Boolean(query) || onlyMine;
  const activeFilterLabels = [
    tag ? TAG_INFO[tag].label : '',
    onlyMine ? 'Mine' : '',
    sort !== 'new' ? (SORTS.find((s) => s.key === sort)?.label ?? sort) : '',
    sort === 'top' && span !== 'week' ? span : '',
  ].filter(Boolean);

  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollKey = `cyoa.chat.threadList.scroll:${sort}:${span}:${tag}:${page}:${needle}:${onlyMine ? 1 : 0}`;
  const scrollRestoreRef = useRef<{ key: string; top: number; done: boolean }>({ key: '', top: 0, done: true });
  useEffect(() => {
    const el = listScrollRef.current;
    if (!el) return undefined;
    let top = 0;
    try { top = Number(sessionStorage.getItem(scrollKey)) || 0; } catch { }
    scrollRestoreRef.current = { key: scrollKey, top, done: top <= 0 };
    if (top <= 0) el.scrollTop = 0;
    return () => {
      try { sessionStorage.setItem(scrollKey, String(el.scrollTop)); } catch { }
    };
  }, [scrollKey]);
  useEffect(() => {
    const wanted = scrollRestoreRef.current;
    const el = listScrollRef.current;
    if (loading || !el || wanted.key !== scrollKey || wanted.done) return;
    requestAnimationFrame(() => {
      el.scrollTop = wanted.top;
      wanted.done = true;
    });
  }, [loading, rooms.length, scrollKey]);

  return (
    // minWidth: 0 is mandatory: flex items default to min-width:auto, the filter header PUSHED the
    // column wider than the phone — rows went off-screen with the like button, and ResizeObserver
    // measured 484 at 390, laying out five thumbnails instead of one.
    <Box ref={boxRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/*
        The list header is ONE row: sort, tag, mine, search, "new". Two rows used to exist, the
        second entirely a search field (rarely used, cost as much as all filters). Search collapses
        to an icon and expands to full row; with a typed query it stays open. No screen name here —
        "Threads" is in the chat bar above.
      */}
      <Box sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: { xs: 1, sm: 1.5 },
        py: 0.5,
        borderBottom: 1,
        borderColor: 'divider',
      }}>
        {searchOn ? (
          <>
            <Box sx={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              px: 1,
              py: 0.15,
              border: 1,
              borderColor: 'divider',
              borderRadius: 999,
            }}>
              <SearchIcon sx={{ fontSize: 15, color: 'text.disabled', flexShrink: 0 }} />
              <InputBase
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search thread titles"
                autoFocus
                // Esc closes search entirely: the expanded row hides the filters.
                onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
                sx={{ flex: 1, minWidth: 0, fontSize: 12.5 }}
                inputProps={{ 'aria-label': 'Search thread titles' }}
              />
            </Box>
            <Tooltip title="Close search" disableInteractive>
              <IconButton size="small" onClick={closeSearch} sx={{ flexShrink: 0, p: 0.4 }}>
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <>
            {filters}
            {mineBtn}

            <Box sx={{ flex: 1, minWidth: 0 }} />

            {/*
              No "N topics found" count anymore: it answered a question nobody asks; page count is
              at the pagination. Its space went to the chat bar controls.
            */}
            <Tooltip title="Search thread titles" disableInteractive>
              <IconButton
                size="small"
                onClick={() => setSearchOpen(true)}
                sx={{ flexShrink: 0, p: 0.4, color: 'text.secondary' }}
              >
                <SearchIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Tooltip>

            {/*
              "New thread" is a filled button: the ONLY action on the screen, must not hide among
              toggles.
            */}
            {createBtn}

            {/*
              Gear and who's-here come from the chat bar absent on this screen; placed last, after
              "New thread" — the screen's action outranks global chat settings.
            */}
            {actions}
          </>
        )}
      </Box>

      {(searchOn || activeFilterLabels.length > 0) && (
        <Box sx={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.5,
          flexWrap: 'wrap', px: { xs: 1, sm: 1.5 }, py: 0.45,
          borderBottom: 1, borderColor: 'divider', fontSize: 11, color: 'text.disabled',
        }}>
          {searchOn && (
            <Box component="span">
              Search is by title · 2 characters minimum
            </Box>
          )}
          {activeFilterLabels.map((label) => (
            <Box key={label} component="span" sx={{
              px: 0.7, py: 0.15, border: 1, borderColor: 'divider', borderRadius: 999,
              color: 'text.secondary',
            }}>
              {label}
            </Box>
          ))}
          {hasResettableFilters && (
            <Box
              component="button"
              type="button"
              onClick={clearFilters}
              sx={{
                ml: 'auto', border: 0, bgcolor: 'transparent', color: 'primary.light',
                fontFamily: 'inherit', fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Reset filters
            </Box>
          )}
        </Box>
      )}


      {/*
        Body scrolls as ONE sheet: rooms strip, pins, topic feed, pagination, activity section.
        Pinning pagination to the bottom would bury "where you posted recently" beneath it.
        Author's decision: one sheet, reached by swiping down. Only the filter header stays fixed.
      */}
      <Box ref={listScrollRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/*
          Permanent rooms as a strip, not a list: few and should stay few — topics are the main
          entity. No label: the "#" before each name says "room" (and distinguishes it from filter
          pills, which have no "#").
        */}
        {permanentRooms.length > 0 && onOpenRoom && (
          <Box sx={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 0.75,
            px: 1.25,
            py: 0.75,
            borderBottom: 1,
            borderColor: 'divider',
          }}>
            <Box sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 0.5,
              minWidth: 0,
            }}>
              {permanentRooms.map((ch) => {
                const fresh = Boolean(hasNew?.(ch.id));
                return (
                  <Box
                    key={ch.id}
                    component="button"
                    type="button"
                    onClick={() => onOpenRoom(ch.slug)}
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      px: 1,
                      py: 0.35,
                      border: 1,
                      borderColor: 'divider',
                      borderRadius: 999,
                      bgcolor: 'transparent',
                      color: fresh ? 'text.primary' : 'text.secondary',
                      fontFamily: 'inherit',
                      fontSize: 12,
                      fontWeight: fresh ? 800 : 600,
                      cursor: 'pointer',
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.07)' },
                    }}
                  >
                    {fresh && <NewDot />}
                    {/*
                      "#" and name are ONE element: pill gap 0.5 would separate a child "#" ("#
                      General"). Muted so it reads as a sign, not a letter.
                    */}
                    <Box component="span">
                      <Box component="span" sx={{ opacity: 0.45 }}>#</Box>{ch.title}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          </Box>
        )}

        {/*
          Shared pins (moderator-pinned for ALL) sit ABOVE personal ones: the section's showcase
          for first-time visitors incl. guests. Can't unpin here (not yours): no button; the filled
          icon is a mark, not a toggle — moderators unpin from the topic's moderation dialog.
          Without the site_pin schema field the list is empty and the block absent. Not shown in
          "mine": someone else's pinned topic first would read as a broken filter.
        */}
        {!onlyMine && visibleSitePins.length > 0 && (
          <Box sx={{ borderBottom: 1, borderColor: 'divider', pb: 0.5 }}>
            <SectionCap>
              Pinned for everyone
            </SectionCap>
            {visibleSitePins.map((r) => (
              <MiniRow
                key={r.id}
                room={r}
                fresh={Boolean(hasNew?.(r.id))}
                pinned
                onOpen={onOpen}
                onLike={like}
                signedIn={signedIn}
              />
            ))}
          </Box>
        )}

        {!onlyMine && !pinsBottom && pinsBlock}

        {netFail && rooms.length > 0 && (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.65,
            borderBottom: 1, borderColor: 'divider', bgcolor: 'rgba(237,108,2,0.08)',
          }}>
            <Typography sx={{ flex: 1, fontSize: 11.5, color: 'warning.light' }}>
              Could not refresh the list. Showing the last loaded results.
            </Typography>
            <Button size="small" variant="text" onClick={() => setRetryKey((k) => k + 1)}>
              Retry
            </Button>
          </Box>
        )}

        {loading ? (
          <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress size={22} /></Stack>
        ) : (netFail && rooms.length === 0) ? (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 7, px: 2 }}>
            <Typography variant="body2" color="text.secondary" align="center">
              Could not reach the server. The list is not empty — it just did not load.
            </Typography>
            <Button variant="outlined" size="small" onClick={() => setRetryKey((k) => k + 1)}>
              Try again
            </Button>
          </Stack>
        ) : rooms.length === 0 ? (
          <Stack alignItems="center" spacing={1.5} sx={{ py: 7, px: 2 }}>
            <ChatBubbleOutlineIcon sx={{ fontSize: 34, opacity: 0.45 }} />
            <Typography variant="body2" color="text.secondary" align="center">
              {/*
                Search and "mine" answer before the content filter: someone who typed a word
                expects an answer about the word; "start the first topic" would read as "the site
                is empty".
              */}
              {hasResettableFilters
                ? 'No threads match the active filters.'
                : 'No threads yet — the first one is yours to start.'}
            </Typography>
            {hasResettableFilters && (
              <Button variant="outlined" size="small" onClick={clearFilters}>Reset filters</Button>
            )}
            <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={onCreate}>
              New thread
            </Button>
          </Stack>
        ) : onlyMine ? (
          // "Mine" is not a feed filter but its own two-list screen (own topics, then replied). One
          // mixed list (as before) answered nothing: own topics drowned among others and the button
          // seemed to do nothing.
          <>
            <MineCap>Your threads</MineCap>
            {mineOwn.length > 0
              ? mineOwn.map(renderRow)
              : <MineNote>You haven’t started a thread yet.</MineNote>}

            <MineCap gap>Your replies</MineCap>
            {mineIn.length > 0
              ? mineIn.map(renderRow)
              : <MineNote>Threads you answer in show up here.</MineNote>}
          </>
        ) : rooms.map(renderRow)}

        {/*
          Button pagination, not infinite scroll: people read the list to pick and leave; "where
          was I" beats smoothness.
        */}
        {pages > 1 && (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            justifyContent="center"
            sx={{ py: 1, borderTop: 1, borderColor: 'divider' }}
          >
            <Box
              component="button"
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              sx={PAGE_BTN_SX}
            >
              ← Prev
            </Box>
            <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
              {page} / {pages}
            </Typography>
            <Box
              component="button"
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              sx={PAGE_BTN_SX}
            >
              Next →
            </Box>
          </Stack>
        )}

        {/*
          Pins at the bottom by default (toggle in chat settings). In "mine" NO pins at all: you
          can pin anyone's topic, and foreign rows in a list promising yours read as a selection
          error.
        */}
        {!onlyMine && pinsBottom && pinsBlock}

        {/*
          Rules at the bottom of the sheet, not above the feed (would take the first screen from
          topics); whoever scrolled to the bottom is about to start a topic. Short, no link to a
          separate page (nobody follows those).
        */}
        <Box sx={{ borderTop: 1, borderColor: 'divider', px: 1.25, py: 1.25 }}>
          <SectionCap>Some rules</SectionCap>
          <Stack component="ul" spacing={0.4} sx={{ m: 0, pl: 2, listStyle: 'disc' }}>
            {RULES.map((r) => (
              <Typography
                key={r}
                component="li"
                sx={{ fontSize: 12, lineHeight: 1.45, color: 'text.secondary' }}
              >
                {r}
              </Typography>
            ))}
          </Stack>
        </Box>
      </Box>
    </Box>
  );
}

// Topic rules — short list, author's words, not ToS. Kept in code, not DB: edited once a year; an
// extra collection lives forever. Deliberately three, all inviting; engine mechanics (duplicates,
// daily topic limit, moderator rights) removed — under the feed they read as warnings to a newcomer
// who hasn't done anything.
const RULES = [
  'Tag the rating honestly: NSFW threads must be marked NSFW.',
  "Nothing illegal, please — and try to be kind to each other.",
  "Small threads are welcome. You don't need a big reason to start a conversation.",
];

const PAGE_BTN_SX = {
  px: 1.25,
  py: 0.4,
  border: 1,
  borderColor: 'divider',
  borderRadius: 1,
  bgcolor: 'transparent',
  color: 'text.secondary',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  '&:disabled': { opacity: 0.3, cursor: 'default' },
  '&:hover:not(:disabled)': { color: 'text.primary' },
} as const;
