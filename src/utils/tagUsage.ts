// Set of tags ACTUALLY used (in at least one game), so autocomplete/search suggestions hide empty
// tags (common complaint). Aggregated from games because on prod the `tags.games` back-relation is
// NOT populated — emptiness is only visible via games.tags. Fetch only the tags field; cache 24h.

import { gamesCollectionPublic } from '../pocketbase/pocketbase';

const CACHE_KEY = 'usedTagIds_v1';
const CACHE_TS_KEY = 'usedTagIds_v1_updated';
const TTL = 24 * 60 * 60 * 1000;

let inflight: Promise<Set<string>> | null = null;

function readCache(): Set<string> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const ts = localStorage.getItem(CACHE_TS_KEY);
    if (raw && ts && Date.now() - Number(ts) < TTL) {
      return new Set(JSON.parse(raw) as string[]);
    }
  } catch {
  }
  return null;
}

// Returns Set of used tag ids. localStorage 24h cache; concurrent calls share one request. On
// network failure → empty Set (don't cut options).
export async function getUsedTagIds(): Promise<Set<string>> {
  const cached = readCache();
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rows = await gamesCollectionPublic.getFullList({ fields: 'tags', batch: 500 });
      const used = new Set<string>();
      for (const r of rows as unknown as { tags?: string[] }[]) {
        for (const id of r.tags ?? []) used.add(id);
      }
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify([...used]));
        localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
      } catch {
      // quota — non-critical
      }
      return used;
    } catch (e) {
      console.error('getUsedTagIds failed', e);
      return new Set<string>();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
