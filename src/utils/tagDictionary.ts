// The whole tag taxonomy from one endpoint (tag_dictionary.go) instead of each module paging through
// tags / tag_categories / games.tags on its own (~13 requests on a cold visit, and the home feed
// waited for them). Go inlines `window.__TAGDICT__ = {v, nsfw, extreme}` into every HTML shell:
// - rating tag ids are known synchronously, so feeds filter NSFW/Extreme without any request;
// - a cached dictionary is trusted only while its version equals the inlined one, so it can't go
//   stale for a day (the stale-tagMap trap that silently disabled the NSFW filter).
// Dev (no inlining): cache trusted for TTL, then refetched.

import {
  gamesCollectionPublic,
  tagCategoriesCollectionPublic,
  tagsCollectionPublic,
} from '../pocketbase/pocketbase';
import type { Tag } from '../pocketbase/pocketbase';

export interface TagDictCategory {
  id: string;
  name: string;
  tags: string[];
}

export interface TagDictionary {
  v: string;
  tags: Tag[];
  categories: TagDictCategory[];
  used: string[];
  nsfw: string;
  extreme: string;
}

interface InlineMeta {
  v?: string;
  nsfw?: string;
  extreme?: string;
}

const KEY = 'tagDict_v1';
const TTL_MS = 24 * 60 * 60 * 1000;
// Retired per-module caches; cleared once so they don't sit in storage forever.
const LEGACY_KEYS = [
  'tagMap_v3', 'tagMap_v3_updated', 'tagCategoryMap_v1', 'tagCategoryMap_v1_updated',
  'usedTagIds_v1', 'usedTagIds_v1_updated',
];

function inlineMeta(): InlineMeta {
  return (window as unknown as { __TAGDICT__?: InlineMeta }).__TAGDICT__ ?? {};
}

// NSFW/Extreme ids known before any request (null in dev until the dictionary loads).
export function inlineRatingTagIds(): { nsfw: string | null; extreme: string | null } | null {
  const m = inlineMeta();
  if (!m.nsfw && !m.extreme) return null;
  return { nsfw: m.nsfw || null, extreme: m.extreme || null };
}

let memo: TagDictionary | null = null;

// Synchronous read of a still-valid cached dictionary (for initial state; no flash on warm visits).
export function peekTagDictionary(): TagDictionary | null {
  if (memo) return memo;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { at: number; dict: TagDictionary };
    const v = inlineMeta().v;
    const fresh = v ? cached.dict.v === v : Date.now() - cached.at < TTL_MS;
    if (!fresh) return null;
    memo = cached.dict;
    return memo;
  } catch {
    return null;
  }
}

let inflight: Promise<TagDictionary> | null = null;

// Endpoint unavailable (older server, `make dev` proxying to a prod without it, outage): assemble
// the same shape from the collections the old way. Slower, but the NSFW filter must never lose its
// ids because one endpoint failed.
async function buildFromCollections(): Promise<TagDictionary> {
  const [tags, categories, games] = await Promise.all([
    tagsCollectionPublic.getFullList<Tag>({ fields: 'id,name,aliases', sort: 'name', batch: 1000 }),
    tagCategoriesCollectionPublic.getFullList({ fields: 'id,name,tags', batch: 1000 }),
    gamesCollectionPublic.getFullList({ fields: 'tags', batch: 1000 }),
  ]);
  const used = new Set<string>();
  for (const g of games as unknown as { tags?: string[] }[]) for (const id of g.tags ?? []) used.add(id);
  const idOf = (n: string) => tags.find((t) => t.name.toLowerCase() === n)?.id ?? '';
  return {
    v: '',
    tags,
    categories: categories.map((c) => ({ id: c.id, name: c.name as string, tags: (c.tags as string[]) ?? [] })),
    used: [...used],
    nsfw: idOf('nsfw'),
    extreme: idOf('extreme'),
  };
}

// Never resolves to a partial object: on network failure falls back to any cached copy (even an old
// version), else rejects — callers keep their rating-id fallbacks.
export function loadTagDictionary(): Promise<TagDictionary> {
  const hit = peekTagDictionary();
  if (hit) return Promise.resolve(hit);
  if (inflight) return inflight;
  const v = inlineMeta().v;
  inflight = fetch(`/api/custom/tag-dictionary${v ? `?v=${encodeURIComponent(v)}` : ''}`)
    .then((r) => {
      if (!r.ok) throw new Error(`tag dictionary: HTTP ${r.status}`);
      return r.json() as Promise<TagDictionary>;
    })
    .catch((e) => {
      console.warn('tag dictionary endpoint failed, falling back to collections', e);
      return buildFromCollections();
    })
    .then((dict) => {
      memo = dict;
      try {
        localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), dict }));
        for (const k of LEGACY_KEYS) localStorage.removeItem(k);
      } catch {
        // quota / private mode — memory copy still serves this page
      }
      return dict;
    })
    .catch((e) => {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) return (JSON.parse(raw) as { dict: TagDictionary }).dict;
      } catch { /* fall through */ }
      throw e;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function tagMapOf(dict: TagDictionary): Map<string, Tag> {
  return new Map(dict.tags.map((t) => [t.id, t]));
}

export function tagCategoryMapOf(dict: TagDictionary): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of dict.categories) for (const id of c.tags) m.set(id, c.name);
  return m;
}
