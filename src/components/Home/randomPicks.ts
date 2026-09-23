// Persistent shuffle deck. All mutations are made on a private draw copy.
export interface RandomDeck {
  ids: string[];
  cursor: number;
  recent: string[][];
  refreshedAt: number;
}

export const DECK_REFRESH_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'catalog-random-decks-v2';
const MAX_DECKS = 8;
type Entry = { key: string; deck: RandomDeck };
let memory: Entry[] = [];
let storageFailed = false;

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function cycle(ids: string[], recent: string[][]): string[] {
  const lastSeen = new Map<string, number>();
  recent.forEach((batch, index) => batch.forEach((id) => lastSeen.set(id, index)));
  return shuffle([...ids]).sort((a, b) => (lastSeen.get(a) ?? -1) - (lastSeen.get(b) ?? -1));
}

// Keep progress and the relative order of remaining cards, insert new IDs at random.
export function refreshDeck(previous: RandomDeck | null, ids: string[], now = Date.now()): RandomDeck {
  const eligible = new Set(ids);
  if (!previous) return { ids: shuffle([...eligible]), cursor: 0, recent: [], refreshedAt: now };
  const seen = previous.ids.slice(0, previous.cursor).filter((id) => eligible.has(id));
  const remaining = previous.ids.slice(previous.cursor).filter((id) => eligible.has(id));
  const known = new Set(previous.ids);
  const added = shuffle([...eligible].filter((id) => !known.has(id)));
  // Random interleaving is linear, avoiding repeated array insertion for large catalogs.
  const merged: string[] = [];
  let a = 0, b = 0;
  while (a < remaining.length || b < added.length) {
    if (Math.random() * (remaining.length - a + added.length - b) < added.length - b) merged.push(added[b++]);
    else merged.push(remaining[a++]);
  }
  return { ids: [...seen, ...merged], cursor: seen.length, recent: previous.recent.map((batch) => [...batch]), refreshedAt: now };
}

// Verify each batch against current filters. Missing/deleted cards never occupy a slot.
export async function drawDeck<T extends { id: string }>(
  original: RandomDeck,
  count: number,
  loadCards: (ids: string[]) => Promise<T[]>,
  reloadIds: () => Promise<string[]>,
): Promise<{ deck: RandomDeck; cards: T[] }> {
  let deck = structuredClone(original);
  const cards: T[] = [];
  const attempted = new Set<string>();
  let refreshed = false;
  while (cards.length < count && deck.ids.some((id) => !attempted.has(id))) {
    if (deck.cursor >= deck.ids.length) {
      deck.ids = cycle(deck.ids, [...deck.recent, cards.map((card) => card.id)]);
      deck.cursor = 0;
    }
    const batch: string[] = [];
    while (deck.cursor < deck.ids.length && batch.length < count - cards.length) {
      const id = deck.ids[deck.cursor++];
      if (!attempted.has(id)) { attempted.add(id); batch.push(id); }
    }
    if (!batch.length) continue;
    const loaded = new Map((await loadCards(batch)).map((card) => [card.id, card]));
    for (const id of batch) {
      const card = loaded.get(id);
      if (card) cards.push(card);
    }
    if (batch.some((id) => !loaded.has(id))) {
      // A stale deck could otherwise require thousands of empty card requests.
      if (!refreshed) {
        deck = refreshDeck(deck, await reloadIds());
        refreshed = true;
      } else {
        deck = refreshDeck(deck, deck.ids.filter((id) => !batch.includes(id) || loaded.has(id)), deck.refreshedAt);
      }
    }
  }
  if (cards.length) deck.recent = [...deck.recent, cards.map((card) => card.id)].slice(-5);
  return { deck, cards };
}

function isDeck(value: unknown): value is RandomDeck {
  if (!value || typeof value !== 'object') return false;
  const d = value as RandomDeck;
  const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string' && /^[a-z0-9]{15}$/.test(id));
  return ids(d.ids) && new Set(d.ids).size === d.ids.length && Number.isInteger(d.cursor) && d.cursor >= 0 && d.cursor <= d.ids.length
    && Number.isFinite(d.refreshedAt) && Array.isArray(d.recent) && d.recent.length <= 5
    && d.recent.every((batch) => ids(batch) && batch.length <= 20);
}

function readEntries(): Entry[] {
  if (storageFailed) return memory;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      return parsed.filter((e): e is Entry => !!e && typeof e.key === 'string' && isDeck(e.deck)).slice(-MAX_DECKS);
    }
  } catch { }  // Restricted storage: fall back to memory.
  return memory;
}

export function loadDeck(key: string): RandomDeck | null {
  const deck = readEntries().find((entry) => entry.key === key)?.deck;
  return deck ? structuredClone(deck) : null;
}

export function saveDeck(key: string, deck: RandomDeck): void {
  memory = [...readEntries().filter((entry) => entry.key !== key), { key, deck: structuredClone(deck) }].slice(-MAX_DECKS);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); }
  catch { storageFailed = true; }  // Full/disabled storage must not prevent another roll.
}
