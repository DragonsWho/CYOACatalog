// Custom chat emoji registry. The pack lives in PocketBase (`chat_emoji`), not the frontend build:
// when it was baked into the binary, renaming one image meant rebuilding frontend + Go and
// deploying. Now the list comes from /api/custom/chat/emoji; images served from
// /api/files/chat_emoji/… cached in CDN for 31 days (Cloudflare "PB media" rule). Animated webp
// still prepared locally by _dev/emoji_pack/build.py.
// Module singleton, not a stateful hook: the markup parser (Shoutbox/richText.tsx) is a plain
// synchronous function outside React and needs the pack without context or promises.
// Unicode emoji are NOT touched: no 😄→image substitution, no ":3" conversion. Our pack only via
// explicit :shortcodes:.

import { useEffect, useState } from 'react';

export interface EmojiDef {
  id: string;
  name: string;
  // PB filename with random suffix: replacing the image changes the URL, so caches refresh without
  // purge.
  file: string;
  pack: string;
  // Removed from the picker but kept in the list: old messages already use the shortcode and it
  // must keep rendering.
  hidden: boolean;
  quick: boolean;
  animated: boolean;
  // No alpha → a light brick on the dark chat background; the panel flags it.
  opaque: boolean;
  bytes: number;
  source: string;
  w: number;
  h: number;
}

interface EmojiManifest {
  quick: string[];
  emoji: EmojiDef[];
}

export const EMOJI_API = '/api/custom/chat/emoji';

export const emojiUrl = (e: EmojiDef): string => `/api/files/chat_emoji/${e.id}/${e.file}`;

// Inline size larger than Discord's 22px on purpose: our pack is anime faces, mush at 22px (unlike
// Fluent symbols).
export const EMOJI_SIZE = {
  inline: 28,
  jumbo: 56,
  reaction: 18,
  // Picker cell larger than Discord's for the same reason.
  picker: 40,
};

export const JUMBO_MAX = 3;

// Message reactions type lives here, not in shoutboxApi, so emoji components don't pull in
// PocketBase.
export type ReactionMap = Record<string, string[]>;

let all: EmojiDef[] = [];
let visible: EmojiDef[] = [];
let index = new Map<string, EmojiDef>();
let quickNames: string[] = [];
let version = 0;
let state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

// Pack for synchronous reads. Empty until loaded — shortcodes stay as text (safer than blank
// holes). Includes hidden ones: the index is for rendering, not the picker.
export const emojiIndex = (): Map<string, EmojiDef> => index;
// Grows when the pack arrives/changes; the feed's parse cache uses it to know when to re-parse.
export const emojiVersion = (): number => version;
export const emojiAll = (): EmojiDef[] => visible;
export const emojiEverything = (): EmojiDef[] => all;
export const emojiQuick = (): EmojiDef[] => quickNames
  .map((n) => index.get(n))
  .filter((e): e is EmojiDef => Boolean(e));

function apply(m: EmojiManifest): void {
  all = Array.isArray(m.emoji) ? m.emoji : [];
  visible = all.filter((e) => !e.hidden);
  index = new Map(all.map((e) => [e.name, e]));
  quickNames = Array.isArray(m.quick) ? m.quick : [];
  version += 1;
  state = 'ready';
}

function fetchPack(): Promise<void> {
  return fetch(EMOJI_API)
    .then((r) => {
      if (!r.ok) throw new Error(`pack ${r.status}`);
      return r.json() as Promise<EmojiManifest>;
    })
    .then(apply)
    .catch(() => {
      // The pack is decoration: if it fails, messages stay readable with shortcodes as text.
      if (state !== 'ready') state = 'failed';
    })
    .finally(() => {
      listeners.forEach((fn) => fn());
    });
}

export function loadEmojiPack(): Promise<void> {
  if (loadPromise) return loadPromise;
  state = 'loading';
  loadPromise = fetchPack();
  return loadPromise;
}

// Refetch after a panel edit — always hits the server (unlike loadEmojiPack), or the moderator
// wouldn't see their own edit.
export function reloadEmojiPack(): Promise<void> {
  loadPromise = fetchPack();
  return loadPromise;
}

export interface EmojiPack {
  ready: boolean;
  failed: boolean;
  all: EmojiDef[];
  everything: EmojiDef[];
  byName: Map<string, EmojiDef>;
  quick: EmojiDef[];
}

export function useEmojiPack(): EmojiPack {
  const [, bump] = useState(0);

  useEffect(() => {
    const fn = () => bump((v) => v + 1);
    listeners.add(fn);
    void loadEmojiPack();
    // The pack may have arrived between render and this effect — the broadcast passed us by;
    // without this check the feed stays without emoji.
    if (state !== 'loading') fn();
    return () => { listeners.delete(fn); };
  }, []);

  return {
    ready: state === 'ready',
    failed: state === 'failed',
    all: visible,
    everything: all,
    byName: index,
    quick: emojiQuick(),
  };
}
