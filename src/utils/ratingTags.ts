// Ids of the NSFW and Extreme tags — to cut adult cards IN THE QUERY, not after. Feeds (HomePage)
// take them from the full tagMap they already load; where the dictionary isn't needed (Similar
// games strip) fetching hundreds of tags for two ids is wasteful, and post-filtering yields
// incomplete results (in sfw mode almost all top-popular candidates are adult). Cached for a week.
// NOT a filtering guarantee: callers MUST keep the tag-name check on loaded records (isRestricted
// in SimilarGamesStrip), so a failed request or stale cache can't let an adult card through in sfw
// mode — never silently disable the filter (the stale-tagMap trap).

import { tagsCollectionPublic } from '../pocketbase/pocketbase';
import { inlineRatingTagIds } from './tagDictionary';

export interface RatingTagIds {
  nsfw: string | null;
  extreme: string | null;
}

const KEY = 'ratingTagIds_v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const EMPTY: RatingTagIds = { nsfw: null, extreme: null };

let inflight: Promise<RatingTagIds> | null = null;

function readCache(): RatingTagIds | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; ids?: RatingTagIds };
    if (!parsed.at || Date.now() - parsed.at > TTL_MS) return null;
    return parsed.ids ?? null;
  } catch {
    // Private window, blocked cookies, broken JSON — just go to network.
    return null;
  }
}

function writeCache(ids: RatingTagIds) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), ids }));
  } catch {
  }
}

// NSFW/Extreme tag ids. Never throws: on any failure returns an empty pair and the caller relies on
// the name filter.
export function getRatingTagIds(): Promise<RatingTagIds> {
  // Inlined into the HTML by Go (tag_dictionary.go) — no request at all.
  const inline = inlineRatingTagIds();
  if (inline) return Promise.resolve(inline);
  const cached = readCache();
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;

  inflight = tagsCollectionPublic
    .getFullList({ filter: 'name = "NSFW" || name = "Extreme"', fields: 'id,name' })
    .then((items) => {
      const ids: RatingTagIds = { nsfw: null, extreme: null };
      for (const t of items) {
        const n = (t.name ?? '').toLowerCase();
        if (n === 'nsfw') ids.nsfw = t.id;
        if (n === 'extreme') ids.extreme = t.id;
      }
      // Don't cache an empty answer — looks like a failure, not "no tags".
      if (ids.nsfw || ids.extreme) writeCache(ids);
      return ids;
    })
    .catch(() => EMPTY)
    .finally(() => {
      inflight = null;
    });

  return inflight;
}
