// User-topic tags and colors. One registry for two very different places: in the narrow left column
// a tag is a 3 px color bar with no text; in the expanded list it's a word. Colors must match, or
// the bar stops being a code (people learn "red = NSFW" only if red is labelled NSFW in the list).
// ⚠️ CLOSED set, mirrored on the server (shoutCommunityRating / shoutCommunityExtra in
// shoutbox_community.go). No user-defined tags on purpose: the catalog's custom tag registry
// already cost a day of CDN-cache debugging.

export type CommunityTag = 'sfw' | 'nsfw' | 'flood' | 'wip' | 'question';

// Content rating: exactly one per topic, required; the header SFW/NSFW filter hangs on it.
export const RATING_TAGS: CommunityTag[] = ['sfw', 'nsfw'];

export const EXTRA_TAGS: CommunityTag[] = ['flood', 'wip', 'question'];

export const ALL_TAGS: CommunityTag[] = [...RATING_TAGS, ...EXTRA_TAGS];

type TagInfo = { label: string; color: string; hint: string };

export const TAG_INFO: Record<CommunityTag, TagInfo> = {
  // Same red as the header toggle (nsfwColor in FilterSwitch.tsx): one idea on two screens.
  nsfw: { label: 'NSFW', color: '#d32f2f', hint: 'Adult content' },
  sfw: { label: 'SFW', color: '#2e7d32', hint: 'Safe for work' },
  // Light green next to dark-green SFW reads as a different color even peripherally (how the bars
  // are read).
  wip: { label: 'WIP CYOA', color: '#aeea00', hint: 'Work in progress — drafts and pages for feedback' },
  question: { label: 'Question', color: '#1e88e5', hint: 'Asking for help' },
  flood: { label: 'General', color: '#9e9e9e', hint: 'Anything else' },
};

export function isTag(v: string): v is CommunityTag {
  return (ALL_TAGS as string[]).includes(v);
}

// Known tags only, registry order. A DB topic may carry a removed tag — skip silently rather than
// draw a meaningless grey bar.
export function knownTags(tags?: string[]): CommunityTag[] {
  if (!tags) return [];
  return ALL_TAGS.filter((t) => tags.includes(t));
}

// Column bars always in the same order: rating first, then topic tags. No gaps: missing rating →
// SFW (the server defaults it anyway), no topic tags → grey General. Every topic has at least two
// bars and red NSFW is always first, so a lone bar can't be confused with position two.
export function stripeTags(tags?: string[]): CommunityTag[] {
  const known = knownTags(tags);
  const rating = RATING_TAGS.filter((t) => known.includes(t));
  const extra = EXTRA_TAGS.filter((t) => known.includes(t));
  return [
    ...(rating.length ? rating : (['sfw'] as CommunityTag[])),
    ...(extra.length ? extra : (['flood'] as CommunityTag[])),
  ];
}

export function hasNSFW(tags?: string[]): boolean {
  return Boolean(tags?.includes('nsfw'));
}
