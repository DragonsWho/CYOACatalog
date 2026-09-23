// Chat icon for the header: bubble + unread badge. Owns presence ("I'm here") and drawer state.
// Feature flag off → renders null (indistinguishable from nonexistent).
// This is the MOST widespread code on the site: it sits in every page header for every visitor,
// incl. those who never open chat. With chat closed it does two cheap things:
// 1. reads the "pulse" — ONE shared response served by the edge (Cloudflare); unread count is
// computed in the browser;
// 2. occasionally says "I'm here" — not on a timer but only after user activity, at most every 10
// minutes.
// No permanent /api/realtime subscription here ON PURPOSE: every visitor on every tab used to hold
// its own SSE stream even with chat closed, which at scale caused a Cloudflare reconnect storm and
// 100% CPU on prod. Live SSE is held ONLY while chat is open (ChatView.tsx, gated on mount).

import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Badge, IconButton, Tooltip } from '@mui/material';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import { useLocation, useNavigate } from 'react-router-dom';
import { pb } from '../../pocketbase/pocketbase';
import type { ChatJumpTarget } from '../Chat/ChatDrawer';
import { CHAT_THREADS_PATH, type CommunityRating } from '../Chat/communityApi';
import { useChatPrefs } from '../Chat/chatPrefs';
import { getAttention, subscribeAttention } from '../Notifications/chatAttention';
import {
  fetchPulse, countPulseUnread, pingPresence, markSeenServer, type ShoutPulse,
} from './shoutboxApi';
import {
  createLease, readShared, writeShared, parseShared,
  LEADER_KEY, PULSE_KEY, PING_KEY, type SharedPing,
} from './tabLeader';

// Chat loads as a separate chunk ONLY when opened (it used to ship in the header chunk to everyone
// reading one game). Chat v1 lived here as a second import until v2; it's in
// `archive/site-frontend-shoutbox-v1/`.
const ChatDrawer = lazy(() => import('../Chat/ChatDrawer'));

// Pulse re-read interval while visible. The response lives on the edge — "take from nearby cache",
// not a server request.
const PULSE_MS = 60_000;

// Tab opened and forgotten (not hidden by the browser — on a second monitor or a sibling phone
// tab): pace drops fivefold. At scale such tabs are the majority; one vs five minutes is 5× of all
// background site traffic.
const IDLE_AFTER_MS = 10 * 60_000;
const PULSE_MS_IDLE = 5 * 60_000;

// Presence: NEVER more often than once per 15 minutes, and "at most", not "every": a silent tab
// sends nothing. The mark is shared across browser tabs (PING_KEY): ten tabs = one ping per 15 min.
// 15 min is bound to the server online window (shoutOnlineWindow, 20 min): the user must confirm
// presence BEFORE falling out of the counter. Change these two constants only together.
const PRESENCE_MIN_GAP_MS = 15 * 60_000;

// Full-page chat URL (`App.tsx`). While there, the chat screen pings, not the header. If chat
// moves, change here and in `pushChatURL` (push.go).
const CHAT_ROUTE = '/chat';

// Same prefix as the game route in App.tsx (`/game/:id`), for the "games_off" swipe mode (conflicts
// with game input: swipe CYOAs, CyoaCompanionDrawer).
const GAME_ROUTE_PREFIX = '/game/';

// Double click on the icon = full-page chat. Standard system threshold; the first click already
// opened quick chat, so single clicks have no delay.
const DBLCLICK_MS = 300;

// Right-to-left swipe opens quick chat from any page (v2). The very edge belongs to the system
// ("back"), so starts within 24px of the edge are ignored. Same threshold as the calculator on game
// pages (CyoaCompanionDrawer).
const SWIPE_EDGE = 24;
const SWIPE_MIN = 70;

const SEEN_KEY = 'shoutbox_seen';  // localStorage: last read moment
const ENABLED_KEY = 'shoutbox_enabled';  // localStorage: feature flag cache (anti-jitter)

// Max age for a foreign pulse to substitute our own. The leader tab re-reads every minute (every
// five if forgotten), so a live cache is always fresher; older means the leader probably died.
const PULSE_STALE_MS = 10 * 60_000;
// anon_key and read mark don't expire (the key lasts days; the mark is a past fact). Age only keeps
// very old data out of a new session.
const PING_ADOPT_MS = 24 * 3600_000;

function authUid(): string {
  return pb.authStore.record?.id ?? '';
}

// Initial flag from cache so the icon sits in the row FROM THE FIRST FRAME instead of jumping in
// after the server responds. If the flag is turned off, the next pulse returns 404, the cache
// clears, the icon disappears.
function cachedEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

// Moment from an ISO string; empty/garbage → 0. Never compare marks as strings: the browser writes
// "…:00.000Z", the server "…:00Z" — equal moments differ lexically.
function ms(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

interface ShoutboxButtonProps {
  rating?: CommunityRating;
  iconFontSize?: string;
  padding?: string;
}

export default function ShoutboxButton({ iconFontSize, padding, rating }: ShoutboxButtonProps) {
  const navigate = useNavigate();
  const location = useLocation();
  // On the full chat page the user reads exactly what the badge counts. Path from the router, not
  // window: gesture handlers live outside React and need an instant answer, while the counter must
  // RECOMPUTE on navigation.
  const onChatPage = location.pathname.startsWith(CHAT_ROUTE);
  // Chat view prefs (Chat Settings / profile): single click → page or drawer, and swipe mode.
  // Browser-level, same shelf as hideImages/freezeEmoji.
  const { swipeOpenMode, singleClickFullChat } = useChatPrefs();
  const [enabled, setEnabled] = useState(cachedEnabled);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  // Conversation reads are independent of notification tray dismissal.
  const attention = useSyncExternalStore(subscribeAttention, getAttention);
  const hasDm = Object.entries(attention.channels).some(([id, c]) => c.dm && c.latest > (attention.reads[id] ?? 0));
  // Jump target from a "replied in chat" notification: message/channel id + click token (grows even
  // for a repeat click on the same notification, else ChatView sees no prop change).
  const [jumpTarget, setJumpTarget] = useState<ChatJumpTarget | null>(null);
  const jumpTokenRef = useRef(0);
  // Drawer mounted on first open and kept: closed it does nothing (effects gated on open);
  // unmounting broke the close animation and re-downloaded the chunk.
  const [everOpen, setEverOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Last-read in a ref (no re-renders) + localStorage. New visitors start at "now" → 0 unread;
  // returning ones see accumulated. markSeen moves the mark to now and clears the badge.
  const lastSeenRef = useRef<string>('');
  const openRef = useRef(open);
  // "Chat in front of the eyes" = open drawer OR the /chat page: counting unread over the
  // conversation being read would lie. Gestures still look at openRef (no swipe needed on the chat
  // page at all).
  const readingRef = useRef(false);
  const wasReadingRef = useRef(false);
  const pulseRef = useRef<ShoutPulse | null>(null);
  // Presence: "user moved since the last ping" + when THIS tab pinged. The shared browser mark
  // lives in localStorage (PING_KEY); the local one is insurance where storage is blocked.
  const activeRef = useRef(true);
  const pingedAtRef = useRef(0);
  // Last activity + last pulse read: enough to tell a live tab from a forgotten one.
  const activeAtRef = useRef(Date.now());
  const pulsedAtRef = useRef(0);

  const markSeen = () => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    try { localStorage.setItem(SEEN_KEY, now); } catch { }
    setUnread(0);
  };

  useEffect(() => {
    const saved = (() => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } })();
    if (saved) {
      lastSeenRef.current = saved;
    } else {
      lastSeenRef.current = new Date().toISOString();
      try { localStorage.setItem(SEEN_KEY, lastSeenRef.current); } catch { }
    }
  }, []);

  useEffect(() => {
    openRef.current = open;
    if (open) setEverOpen(true);
  }, [open]);

  // Navigated to the chat page with the drawer open (link inside chat, history forward) → close the
  // drawer, else /chat has two live ChatViews (see openChat).
  useEffect(() => {
    if (onChatPage) setOpen(false);
  }, [onChatPage]);

  // Reading = chat in front of me (drawer or page). Start reading → clear badge and move the mark;
  // stop → everything until now is read. On first mount (not reading, never read) do nothing, so
  // cross-session unread isn't wiped.
  const reading = open || onChatPage;
  useEffect(() => {
    readingRef.current = reading;
    // Local mark (localStorage → storage event clears the badge in other tabs) + server mark
    // (users.shoutbox_last_seen → clears on other devices). The server mark moves only on
    // start/stop reading transitions — two writes per chat session.
    if (reading) { markSeen(); markSeenServer(); }
    else if (wasReadingRef.current) { markSeen(); markSeenServer(); }
    wasReadingRef.current = reading;
  }, [reading]);

  useEffect(() => {
    let cancelled = false;

    const applyPulse = (p: ShoutPulse) => {
      pulseRef.current = p;
      // The pulse has an online count too, but unused here: closed, the button shows only unread;
      // the chat header draws "how many of us".
      if (readingRef.current) {
        // Chat is visible — nothing to count; also move the local mark so sibling tabs (and the
        // next visit) don't count what was just read.
        markSeen();
        return;
      }
      setUnread(countPulseUnread(p, lastSeenRef.current));
    };

    // A read mark arrived externally (server — "read on phone", or a sibling tab). Take it only if
    // NEWER than ours and recompute the badge from our own pulse.
    const adoptSeen = (iso: string) => {
      if (!iso || ms(iso) <= ms(lastSeenRef.current)) return;
      lastSeenRef.current = iso;
      try { localStorage.setItem(SEEN_KEY, iso); } catch { }
      if (pulseRef.current && !readingRef.current) {
        setUnread(countPulseUnread(pulseRef.current, iso));
      }
    };

    // Follower tab: the leader already fetched everything. Zero requests.
    const adoptShared = () => {
      const p = readShared<ShoutPulse>(PULSE_KEY, PULSE_STALE_MS);
      if (p) { setEnabled(true); applyPulse(p); }
      const sp = readShared<SharedPing>(PING_KEY, PING_ADOPT_MS);
      if (sp && sp.uid === authUid()) adoptSeen(sp.lastSeen);
    };

    const pulse = async () => {
      const p = await fetchPulse();
      if (cancelled || !p) return;
      if (p === 'disabled') {
        try { localStorage.setItem(ENABLED_KEY, '0'); } catch { }
        setEnabled(false);
        stopLoop();
        return;
      }
      try { localStorage.setItem(ENABLED_KEY, '1'); } catch { }
      setEnabled(true);
      writeShared(PULSE_KEY, p);  // and to sibling tabs via the storage event
      applyPulse(p);
    };

    // Say "I'm here" only if the user did something since last time AND enough time passed since
    // the last ping of ANY tab in this browser. Also brings the anon_key and the server read mark —
    // share them with siblings. "Any tab" includes an open chat screen: it pings every minute into
    // the same `PING_KEY`, so while chat is open anywhere, no ping goes from here.
    const ping = async () => {
      // On the chat page presence belongs entirely to it (pings every minute with a superset: room
      // highlights, device endpoint). Check the URL, not the shared localStorage mark: the chat
      // screen is a separate chunk mounting noticeably later than the header, so on page open it
      // hasn't claimed anything yet and the header sent a second ping every time. After leaving,
      // chat unmounts and the header takes presence back next tick.
      if (window.location.pathname.startsWith(CHAT_ROUTE)) return;
      if (!activeRef.current) return;
      if (Date.now() - pingedAtRef.current < PRESENCE_MIN_GAP_MS) return;
      const uid = authUid();
      // A fresh ping mark = some tab already reported for all. It says nothing about another
      // account: logged into a different one in another tab → ping.
      const recent = readShared<SharedPing>(PING_KEY, PRESENCE_MIN_GAP_MS);
      if (recent && recent.uid === uid) return;
      activeRef.current = false;
      pingedAtRef.current = Date.now();
      try {
        // Empty ping: "I'm on the site", nothing else. No room highlights (nobody looking), no
        // device endpoint (user isn't in chat; their pushes must not be muted), no visibility
        // requests (the server knows from the profile). pingPresence sets PING_KEY for siblings.
        const res = await pingPresence();
        if (cancelled) return;
        adoptSeen(res.lastSeen);
      } catch {
        // Failed (network blip, server restart): waiting the full interval means vanishing from the
        // counter meanwhile; retry in a couple of minutes.
        if (!cancelled) {
          activeRef.current = true;
          pingedAtRef.current = Date.now() - PRESENCE_MIN_GAP_MS + 2 * 60_000;
        }
      }
    };

    // The leader tab goes to the network, followers read what it fetched. Only a visible tab can
    // lead: when hidden it yields leadership (onVisibility), else a minimized window would hold the
    // lock while the browser throttles its timers.
    const lease = createLease(LEADER_KEY, () => {
      // Leadership arrived asynchronously (a sibling released it) — start immediately.
      if (cancelled) return;
      pulsedAtRef.current = Date.now();
      pulse();
      ping();
    });

    const tick = () => {
      if (!lease.hold()) { adoptShared(); return; }
      const now = Date.now();
      const idle = now - activeAtRef.current > IDLE_AFTER_MS;
      if (!idle || now - pulsedAtRef.current >= PULSE_MS_IDLE) {
        pulsedAtRef.current = now;
        pulse();
      }
      ping();
    };

    const startLoop = () => {
      if (timerRef.current !== null) return;
      tick();
      timerRef.current = window.setInterval(tick, PULSE_MS);
    };
    function stopLoop() {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        lease.release();
        stopLoop();
        return;
      }
      activeRef.current = true;
      activeAtRef.current = Date.now();
      // Returned from another device/tab — the badge must correct immediately. Costs the leader
      // nothing (within 10 s even the browser cache answers, then the edge); followers take the
      // sibling's data.
      if (timerRef.current === null) startLoop();  // startLoop does the first tick itself
      else if (lease.is()) { pulsedAtRef.current = Date.now(); pulse(); }
      else adoptShared();
    };
    // Any user action on the page = "still here". Sends nothing itself; only sets a flag the next
    // tick reads.
    const onActivity = () => { activeRef.current = true; activeAtRef.current = Date.now(); };

    // Cross-tab: a sibling learned something — take it for free.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SEEN_KEY) { adoptSeen(e.newValue ?? ''); return; }
      if (e.key === PULSE_KEY) {
        const p = parseShared<ShoutPulse>(e.newValue);
        if (p) { setEnabled(true); applyPulse(p); }
        return;
      }
      if (e.key === PING_KEY) {
        const sp = parseShared<SharedPing>(e.newValue);
        if (sp && sp.uid === authUid()) adoptSeen(sp.lastSeen);
        return;
      }
      if (e.key === ENABLED_KEY && e.newValue === '0') setEnabled(false);
    };

    // Whatever siblings knew at this tab's open, we know for free before any request.
    adoptShared();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    window.addEventListener('storage', onStorage);
    for (const ev of ['pointerdown', 'keydown', 'scroll'] as const) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    onVisibility();

    return () => {
      cancelled = true;
      lease.release();
      stopLoop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      window.removeEventListener('storage', onStorage);
      for (const ev of ['pointerdown', 'keydown', 'scroll'] as const) {
        window.removeEventListener(ev, onActivity);
      }
    };
  }, []);

  useEffect(() => {
    const openChat = (e: Event) => {
      // On the chat page the drawer never opens: a SECOND live ChatView in one tab would mean two
      // SSE subscriptions, two presence pings per minute, two writers into one localStorage, a
      // doubled title counter. Click and swipe are muted there; the notification event is not — the
      // mounted chat takes the jump (ChatPage listens to the same event).
      if (window.location.pathname.startsWith(CHAT_ROUTE)) return;
      setOpen(true);
      const detail = (e as CustomEvent<{ messageId?: string; channelId?: string }>).detail;
      if (detail?.messageId) {
        jumpTokenRef.current += 1;
        setJumpTarget({
          messageId: detail.messageId,
          channelId: detail.channelId,
          token: jumpTokenRef.current,
        });
      }
    };
    window.addEventListener('shoutbox:open', openChat);
    return () => window.removeEventListener('shoutbox:open', openChat);
  }, []);

  // Waiting for a second click? The first click used to fire immediately and roll back if a second
  // came — but rolling back navigation to `/chat` is visible (the page mounts for a frame or two).
  // Honest debounce: every click waits the threshold, then exactly one action fires.
  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
  }, []);

  const onIconClick = () => {
    // Chat already fills the page — nothing to open over it.
    if (window.location.pathname.startsWith(CHAT_ROUTE)) return;

    // A full navigation always closes the drawer afterwards, or it hangs over the new page.
    const goFull = () => { setOpen(false); navigate(CHAT_THREADS_PATH); };

    if (clickTimerRef.current !== null) {
      // Second click in a row → the action single click does NOT do (the Chat Settings toggle
      // decides which).
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      if (singleClickFullChat) setOpen(true); else goFull();
      return;
    }

    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      if (singleClickFullChat) {
        goFull();
      } else {
        // A repeat click AFTER the threshold = "close", like any toggle.
        setOpen((cur) => !cur);
      }
    }, DBLCLICK_MS);
  };

  useEffect(() => {
    // "off" mode → no listeners at all, so the disabled feature costs no touch events.
    if (swipeOpenMode === 'off') return undefined;

    let start: { x: number; y: number } | null = null;

    const onStart = (e: TouchEvent) => {
      // Two fingers = zoom; on a zoomed page a horizontal gesture is panning.
      if (e.touches.length > 1) { start = null; return; }
      if (window.visualViewport && window.visualViewport.scale > 1.05) { start = null; return; }
      const t = e.touches[0];
      if (t.clientX < SWIPE_EDGE || t.clientX > window.innerWidth - SWIPE_EDGE) { start = null; return; }
      start = { x: t.clientX, y: t.clientY };
    };

    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      // With chat open, gestures inside it belong to chat (rooms left, members right); on the chat
      // page all the more.
      if (!s || openRef.current) return;
      if (window.location.pathname.startsWith(CHAT_ROUTE)) return;
      // "games_off": gesture live everywhere except game pages (conflicts with game input).
      if (swipeOpenMode === 'games_off' && window.location.pathname.startsWith(GAME_ROUTE_PREFIX)) return;
      const t = e.changedTouches[0];
      const dx = s.x - t.clientX;
      const dy = Math.abs(s.y - t.clientY);
      // Right-to-left and clearly horizontal, else any scroll drifting sideways would open chat.
      if (dx > SWIPE_MIN && dx > dy * 1.5) setOpen(true);
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [swipeOpenMode]);

  if (!enabled) return null;

  return (
    <>
      <Tooltip
        title={hasDm
          ? 'You have a personal message'
          : singleClickFullChat
            ? 'Chat — double click for the quick chat'
            : 'Chat — double click for the full page'}
        arrow
      >
        <IconButton
          color="inherit"
          onClick={onIconClick}
          sx={{ padding }}
          aria-label={hasDm ? 'Chat — you have a personal message' : 'Chat'}
        >
          <Badge
            // A DM replaces the number on purpose: "someone wrote to you personally" is a different
            // matter, not one more unit of chatter, and must read at a glance (author's decision).
            badgeContent={hasDm ? '!' : unread}
            // Cap equals what the pulse carries (shoutPulseKeep): the server counts no further;
            // "100" vs "200" makes no difference to a person.
            max={50}
            overlap="circular"
            sx={{
              // Unread, not online (online is in the chat header). Muted green; MUI hides the badge
              // at 0.
              '& .MuiBadge-badge': {
                // DM in a warm color (the bell's error shade), chatter in muted green: color
                // separates "for you" from "in general". The "!" slightly larger than digits, else
                // at 15px it reads as a dot.
                bgcolor: hasDm ? 'rgba(180,62,62,0.92)' : 'rgba(56,110,66,0.9)',
                color: 'rgba(255,255,255,0.88)',
                fontSize: hasDm ? '0.68rem' : '0.6rem',
                fontWeight: hasDm ? 700 : 500,
                minWidth: 15, height: 15, px: 0.5,
              },
            }}
          >
            <ChatBubbleOutlineIcon sx={{ fontSize: iconFontSize }} />
          </Badge>
        </IconButton>
      </Tooltip>
      {everOpen && (
        <Suspense fallback={null}>
          {/*
            The drawer handles site header, back and Esc itself; the chat inside is the same as
            /chat and pings presence itself.
          */}
          <ChatDrawer open={open} onClose={() => setOpen(false)} jumpTarget={jumpTarget} rating={rating} />
        </Suspense>
      )}
    </>
  );
}
