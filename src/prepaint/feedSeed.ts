// What the default home feed shows before any request: picked from the snapshot Go inlines into the
// HTML (main.go buildCatalogScriptTag). Shared by the pre-React pre-paint and HomePage's first
// render, so both show exactly the same cards in the same order and React only adds detail.
// Dependency-free (inlined into index.html).
//
// The HTML is one document for everyone (edge-cached); per-visitor differences are applied here:
// - filter mode: sfw → SFW arrays; all → ALL; nsfw → ALL filtered to NSFW/Extreme. Filtering an
//   ordered list keeps the order, so that is exactly the head of the real nsfw feed.
// - blocked tags/games/authors (logged-in users) and dismissed pins: filtered out, same reasoning.

export type FeedMode = 'sfw' | 'all' | 'nsfw';

export interface SeedTag {
  id: string;
  name: string;
  category?: string;
}

export interface SeedGame {
  id: string;
  title?: string;
  expand?: { tags?: SeedTag[]; authors?: { id: string; name: string }[] };
  [key: string]: unknown;
}

export interface SeedBlocks {
  tags: string[];
  games: string[];
  authors: string[];
}

export interface FeedSeed {
  pins: SeedGame[];
  games: SeedGame[];
}

const RATING = new Set(['nsfw', 'extreme']);

function arr(v: unknown): SeedGame[] | null {
  return Array.isArray(v) && v.length ? (v as SeedGame[]) : null;
}

export function pickFeedSeed(mode: FeedMode, blocks: SeedBlocks, seenPins: Set<string>): FeedSeed | null {
  const w = window as unknown as Record<string, unknown>;
  const sfw = mode === 'sfw';
  const feed = arr(w[sfw ? '__CATALOG__' : '__CATALOG_ALL__']);
  if (!feed) return null;
  const pins = arr(w[sfw ? '__CATALOG_PINS__' : '__CATALOG_PINS_ALL__']) ?? [];

  const blockedTags = new Set(blocks.tags);
  const blockedGames = new Set(blocks.games);
  const blockedAuthors = new Set(blocks.authors);
  const keep = (g: SeedGame) => {
    const tags = g.expand?.tags ?? [];
    if (mode === 'nsfw' && !tags.some((t) => RATING.has((t.name || '').toLowerCase()))) return false;
    if (tags.some((t) => blockedTags.has(t.id))) return false;
    if (blockedGames.has(g.id)) return false;
    if ((g.expand?.authors ?? []).some((a) => blockedAuthors.has(a.id))) return false;
    return true;
  };

  const shownPins = pins.filter((g) => keep(g) && !seenPins.has(g.id));
  const pinned = new Set(shownPins.map((g) => g.id));
  const games = feed.filter((g) => keep(g) && !pinned.has(g.id));
  if (!games.length && !shownPins.length) return null;
  return { pins: shownPins, games };
}
