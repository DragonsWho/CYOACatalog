import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../../src/components/Home/randomPicks.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
const { drawDeck, refreshDeck, loadDeck, saveDeck } = await import(moduleUrl);
const ids = Array.from({ length: 1000 }, (_, i) => String(i).padStart(15, '0'));
const cards = async (batch) => batch.map(id => ({ id }));
const reload = async () => ids;

test('full collection is covered exactly once before repeating, including IDs beyond 200', async () => {
  let deck = refreshDeck(null, ids);
  const seen = new Set();
  for (let roll = 0; roll < 50; roll++) {
    const result = await drawDeck(deck, 20, cards, reload);
    assert.equal(result.cards.length, 20);
    for (const card of result.cards) {
      assert.ok(!seen.has(card.id));
      seen.add(card.id);
    }
    deck = result.deck;
  }
  assert.equal(seen.size, 1000);
  const recent = new Set(deck.recent.flat());
  const next = await drawDeck(deck, 20, cards, reload);
  assert.ok(next.cards.every(card => !recent.has(card.id)));
});

test('cycle boundary has no duplicates and small pools minimize adjacent overlap', async () => {
  let deck = refreshDeck(null, ids.slice(0, 25));
  const first = await drawDeck(deck, 20, cards, reload);
  const next = await drawDeck(first.deck, 20, cards, reload);
  assert.equal(new Set(next.cards.map(g => g.id)).size, 20);
  const previous = new Set(first.cards.map(g => g.id));
  assert.equal(next.cards.filter(g => previous.has(g.id)).length, 15);
  for (const size of [0, 1, 7, 20, 21, 39]) {
    deck = refreshDeck(null, ids.slice(0, size));
    for (let i = 0; i < 5; i++) {
      const result = await drawDeck(deck, 20, cards, reload);
      assert.equal(result.cards.length, Math.min(size, 20));
      assert.equal(new Set(result.cards.map(g => g.id)).size, result.cards.length);
      deck = result.deck;
    }
  }
});

test('refresh preserves consumed IDs, remaining order, and introduces new games', async () => {
  const initial = refreshDeck(null, ids.slice(0, 100));
  const { deck } = await drawDeck(initial, 20, cards, reload);
  const removed = new Set([deck.ids[0], deck.ids[30]]);
  const updated = refreshDeck(deck, ids.slice(0, 110).filter(id => !removed.has(id)), 123);
  assert.equal(updated.cursor, 19);
  assert.equal(updated.refreshedAt, 123);
  assert.deepEqual(updated.ids.slice(updated.cursor).filter(id => !ids.slice(100, 110).includes(id)), deck.ids.slice(20).filter(id => !removed.has(id)));
  assert.ok(ids.slice(100, 110).every(id => updated.ids.slice(updated.cursor).includes(id)));
  assert.ok(updated.ids.every(id => !removed.has(id)));
});

test('stale cards are replenished after a single ID refresh', async () => {
  const deck = { ids, cursor: 0, recent: [], refreshedAt: 1 };
  let refreshes = 0, requests = 0;
  const valid = new Set(ids.slice(900));
  const result = await drawDeck(deck, 20, async batch => {
    requests++;
    return batch.filter(id => valid.has(id)).map(id => ({ id }));
  }, async () => { refreshes++; return [...valid]; });
  assert.equal(result.cards.length, 20);
  assert.ok(result.cards.every(g => valid.has(g.id)));
  assert.equal(refreshes, 1);
  assert.equal(requests, 2);
  assert.equal(deck.cursor, 0);
});

test('failed requests cannot advance the original deck', async () => {
  const deck = refreshDeck(null, ids);
  const before = structuredClone(deck);
  await assert.rejects(drawDeck(deck, 20, async () => { throw new Error('offline'); }, reload));
  assert.deepEqual(deck, before);
});

test('persistent progress survives a fresh module and is isolated by account/filter', async () => {
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const { deck } = await drawDeck(refreshDeck(null, ids), 20, cards, reload);
  saveDeck('account-a/all', deck);
  const fresh = await import(moduleUrl + '#fresh');
  assert.deepEqual(fresh.loadDeck('account-a/all'), deck);
  assert.equal(fresh.loadDeck('account-b/all'), null);
  assert.equal(fresh.loadDeck('account-a/sfw'), null);
  const resumed = await fresh.drawDeck(fresh.loadDeck('account-a/all'), 20, cards, reload);
  assert.ok(resumed.cards.every(card => !deck.ids.slice(0, 20).includes(card.id)));
  for (let i = 0; i < 10; i++) saveDeck(`filter-${i}`, deck);
  assert.equal(loadDeck('account-a/all'), null);
  assert.deepEqual(loadDeck('filter-9'), deck);
  storage.set('catalog-random-decks-v2', JSON.stringify([{ key: 'bad', deck: { ids: ['unsafe"'], cursor: -1 } }]));
  assert.equal(loadDeck('bad'), null);
});

test('storage quota errors retain progress in memory', async () => {
  const deck = refreshDeck(null, ids);
  globalThis.localStorage = { getItem: () => '[]', setItem: () => { throw new Error('quota'); } };
  saveDeck('fallback', deck);
  assert.deepEqual(loadDeck('fallback'), deck);
});
