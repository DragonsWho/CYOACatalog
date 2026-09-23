// Personal chat display prefs (not notifications/rooms). localStorage, not DB: per-device on
// purpose ("hide images" on the work laptop, show at home) and guests can configure too. Own
// useSyncExternalStore subscription because readers sit in different tree branches (feed row,
// inline emoji, reaction pill); prop-drilling would re-render the whole feed per toggle.

import { useSyncExternalStore } from 'react';

// 'everywhere' (default); 'games_off' — everywhere except game pages (conflicts with game input:
// swipe CYOAs, calculator drawer); 'off'.
export type SwipeOpenMode = 'everywhere' | 'games_off' | 'off';

export interface ChatPrefs {
  // Don't show images until clicked ("safe-for-over-the-shoulder" mode).
  hideImages: boolean;
  // Animated emoji as a single frame (jitter annoys; dozens of animations lag old phones).
  freezeEmoji: boolean;
  swipeOpenMode: SwipeOpenMode;
  // Header chat icon: single click opens the /chat page, double click the drawer (see
  // ShoutboxButton). Default page: clearer for newcomers.
  singleClickFullChat: boolean;
  // User-topics section in the left list expanded by default: collapsing means agreeing not to see
  // fresh topics — the user's decision.
  communityOpen: boolean;
  // Markdown bar off by default (chat is lines, not documents); once opened, it stays open.
  mdBarOpen: boolean;
  // Personal pins on the topic index go BELOW the list by default (up to ten pushed the feed down).
  // Doesn't affect shared pins, always on top.
  threadPinsBottom: boolean;
  // Adult-topics warning accepted. SFW mode itself stays on: images remain blurred; only the repeat
  // modal is skipped.
  nsfwWarningDismissed: boolean;
}

const KEY = 'chatlab_view_prefs';

const DEFAULTS: ChatPrefs = {
  hideImages: false,
  freezeEmoji: false,
  swipeOpenMode: 'everywhere',
  singleClickFullChat: true,
  communityOpen: true,
  mdBarOpen: false,
  threadPinsBottom: true,
  nsfwWarningDismissed: false,
};

const SWIPE_OPEN_MODES: SwipeOpenMode[] = ['everywhere', 'games_off', 'off'];

// Old records had `disableSwipeOpen: boolean` — migrate "off" as is, so a disabled gesture doesn't
// re-enable after a frontend update.
function parseSwipeOpenMode(raw: Partial<ChatPrefs> & { disableSwipeOpen?: boolean }): SwipeOpenMode {
  if (typeof raw.swipeOpenMode === 'string' && SWIPE_OPEN_MODES.includes(raw.swipeOpenMode)) {
    return raw.swipeOpenMode;
  }
  return raw.disableSwipeOpen === true ? 'off' : 'everywhere';
}

function load(): ChatPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<ChatPrefs> & { disableSwipeOpen?: boolean };
    return {
      hideImages: raw.hideImages === true,
      freezeEmoji: raw.freezeEmoji === true,
      swipeOpenMode: parseSwipeOpenMode(raw),
      // Missing value (new browser, old record) = default, not "off" — hence not `=== true`.
      singleClickFullChat: raw.singleClickFullChat !== false,
      // Default-on too: `!== false`, not `=== true`.
      communityOpen: raw.communityOpen !== false,
      mdBarOpen: raw.mdBarOpen === true,
      // Default-on: `!== false`, not `=== true`.
      threadPinsBottom: raw.threadPinsBottom !== false,
      nsfwWarningDismissed: raw.nsfwWarningDismissed === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let prefs: ChatPrefs = load();
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Snapshot must be the same object while nothing changed: useSyncExternalStore compares by
// reference; a new object each time = infinite re-render.
const snapshot = () => prefs;

export function setChatPref<K extends keyof ChatPrefs>(key: K, value: ChatPrefs[K]) {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch { }
  for (const fn of listeners) fn();
}

export function useChatPrefs(): ChatPrefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
}
