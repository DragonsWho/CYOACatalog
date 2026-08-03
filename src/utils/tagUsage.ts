// src/utils/tagUsage.ts
//
// Множество РЕАЛЬНО используемых тегов (есть хотя бы в одной игре). Нужно, чтобы
// автокомплит/подсказки поиска НЕ показывали пустые (0 игр) теги — частая жалоба.
//
// Почему агрегируем из games, а не берём tags.games: на проде back-relation
// `tags.games` НЕ заполняется, пустоту тега можно узнать только со стороны
// games.tags. Тянем только поле tags (компактно), кэшируем на сутки.

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
    /* ignore */
  }
  return null;
}

// Возвращает Set id используемых тегов. Кэш localStorage 24ч; параллельные
// вызовы разделяют один запрос. При сбое сети — пустой Set (не режем опции).
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
        /* quota — не критично */
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
