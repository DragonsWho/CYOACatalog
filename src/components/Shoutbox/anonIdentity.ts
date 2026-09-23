// Anonymous display name ("Anon Fox", "Anon Yuki"). Spec: wiki/components/shoutbox-v2-spec.md §7.
// Before: the name was derived ONLY from anon_key (hash of IP+salt+window, from the backend),
// window = a week. Good: anons can't be tracked beyond a week. Bad: the name changed by itself —
// yesterday's Anon Otter became a stranger today.
// Now (decision 2026-09-16): the person picks a mask, stored in the browser (anonMask.ts)
// indefinitely and sent with each message as anon_mask. The anon_key derivation remains a fallback
// for old messages and people who never touched it.
// The mask does NOT change: mutes, rate limits and the right to delete own messages still hang on
// anon_key computed by the server from IP. A signature is just a signature.

// Name words: animals plus common Japanese names ("Yuki", "Haru", "Sora"). Mixed on purpose: thirty
// animals were too few for a live chat ("Anon Fox" twice in one thread). Rule: one short word,
// readable in Latin script, nothing offensive or service-like (see the stoplist in
// shoutbox_anon.go).
const ANIMALS = [
  'Fox', 'Crow', 'Owl', 'Lynx', 'Wolf', 'Hare', 'Bat', 'Toad', 'Moth', 'Stag',
  'Bear', 'Mole', 'Wren', 'Pike', 'Newt', 'Swan', 'Crab', 'Dove', 'Seal', 'Elk',
  'Vole', 'Kite', 'Carp', 'Finch', 'Otter', 'Ibis', 'Gecko', 'Heron', 'Shrew', 'Stoat',
  'Koi', 'Tanuki', 'Kitsune', 'Tengu', 'Ferret', 'Raven', 'Magpie', 'Marten', 'Badger',
  'Beaver', 'Weasel', 'Puffin', 'Grebe', 'Egret', 'Osprey', 'Falcon', 'Viper', 'Skink',
  'Axolotl', 'Cicada', 'Mantis', 'Firefly', 'Urchin', 'Squid', 'Manta', 'Perch',
];

const NAMES = [
  'Yuki', 'Haru', 'Sora', 'Ren', 'Rin', 'Aoi', 'Kaze', 'Hoshi', 'Tsuki', 'Mizu',
  'Kumo', 'Yume', 'Nami', 'Kaede', 'Sakura', 'Momo', 'Kiri', 'Hana', 'Riku', 'Kai',
  'Akira', 'Hikari', 'Shiro', 'Kuro', 'Midori', 'Ao', 'Natsu', 'Fuyu', 'Aki', 'Hoshiko',
];

// Source for random masks on first visit and the "another" button (anonMask.ts) — same list as the
// fallback derivation, so generated names can't be told from derived ones.
export const ANON_WORDS = [...ANIMALS, ...NAMES];

// Muted but distinguishable on dark. No red on purpose: a red name in chat means exactly one thing
// — moderator. Pink is fine (too different from moderator red). Eighteen, not "more": colors are
// assigned by hash, collisions in a room of five happen anyway (birthday paradox), and adding
// shades the eye can't distinguish defeats recognition. Hash distribution is even: across 140k
// random ids color skew ≤ 1.3%.
const COLORS = [
  '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#64b5f6', '#90caf9',
  '#4fc3f7', '#4dd0e1', '#4db6ac', '#80cbc4', '#81c784', '#aed581', '#dce775',
  '#ffd54f', '#ffb74d', '#ff8a65', '#a1887f', '#b0bec5',
];

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// nickColor by any stable key: anons by anon_key, registered users by record id — not by name
// (names change; the color people recognize shouldn't). One dark theme, one palette tuned for dark;
// a light theme would need its own computation.
export function nickColor(seed: string): string {
  return COLORS[Math.floor(djb2(seed || '?') / 31) % COLORS.length];
}

// Anonymous signature. `mask` = the chosen mask (anon_mask field) without the "Anon" prefix —
// always added here so everyone has the same "Anon" and nobody signs as just "Fox". With a mask the
// color derives FROM THE MASK, not the key — a deliberate trade-off: the key changes weekly and
// color would jump while the name stays ("same Anon Fox, but blue yesterday"). The cost: two people
// under one mask look identical — they already share the name.
export function anonIdentity(anonKey: string, mask?: string): { name: string; color: string } {
  const m = (mask || '').trim();
  if (m) return { name: `Anon ${m}`, color: nickColor(`mask:${m.toLowerCase()}`) };
  const h = djb2(anonKey || '?');
  return {
    name: `Anon ${ANON_WORDS[h % ANON_WORDS.length]}`,
    color: nickColor(anonKey),
  };
}
