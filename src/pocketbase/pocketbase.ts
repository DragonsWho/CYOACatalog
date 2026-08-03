// src/pocketbase/pocketbase.ts

import PocketBase, { RecordService, BaseAuthStore } from 'pocketbase';
import { createContext } from 'react';

export const pb = new PocketBase(window.location.origin);

pb.autoCancellation(false);

// ── Session integrity ──────────────────────────────────────────────────────
// A stored auth token can stop being accepted by the server: it lapses after
// `authToken.duration`, or is invalidated server-side. PocketBase's
// `authStore.isValid` only checks the JWT's LOCAL expiry — it never asks the
// server — so without this the app keeps rendering the user as signed-in while
// every authenticated write silently 401s. That is the "likes stopped working,
// re-login fixes it" report: the token is dead but the UI still looks logged in.
//
// Rule: the moment an authenticated request comes back 401, drop the token so
// the whole UI falls back to its logged-out state (the header shows "Login" and
// the user signs in again themselves). A 403 is usually a VALID token without
// permission (the username-change-once guard, moderator-only actions, editing
// someone else's comment) and must never sign the user out directly — but
// Cloudflare/WAF can also answer 403 to a dead token before PocketBase gets to
// say 401, so a 403 triggers a background probe of the canonical authRefresh
// endpoint instead: a live token survives it untouched, a dead one 401s there
// and gets cleared through this same path.
function invalidateStaleSession(status: number): void {
  if (!pb.authStore.token && !pb.authStore.model) return;
  if (status === 401) {
    // No isValid precondition here: a token can be LOCALLY expired (isValid
    // already false) while the persisted model still renders the user as
    // signed in — that 401 must clear the store too, otherwise the zombie
    // session survives every click.
    pb.authStore.clear();
  } else if (status === 403) {
    void probeSession();
  }
}

// ── Server overload notice ─────────────────────────────────────────────────
// The backend caps how many API requests it handles at once (see overload.go)
// and answers 503 for the rest instead of queueing them until the box swaps
// itself to death. That 503 is temporary and not the user's fault, so it must
// not surface as a generic "something went wrong": we raise one app-wide event
// and OverloadNotice turns it into a single "site is busy" snackbar.
//
// Cloudflare answers 503 too when the origin is unreachable — same story from
// the user's side ("come back in a minute"), so both are handled here.
export const OVERLOAD_EVENT = 'cyoa:overload';
const OVERLOAD_FALLBACK_MESSAGE =
  'The site is under heavy load right now. Please try again in a minute.';
// One notice per half-minute: during an overload a page can fire a dozen failing
// requests at once, and a dozen identical snackbars help nobody.
const OVERLOAD_NOTICE_COOLDOWN_MS = 30_000;
let lastOverloadNotice = 0;

function noteServerOverload(status: number, data?: unknown): void {
  if (status !== 503) return;
  const now = Date.now();
  if (now - lastOverloadNotice < OVERLOAD_NOTICE_COOLDOWN_MS) return;
  lastOverloadNotice = now;
  const fromServer =
    data && typeof (data as { message?: unknown }).message === 'string'
      ? ((data as { message: string }).message || '').trim()
      : '';
  window.dispatchEvent(
    new CustomEvent<string>(OVERLOAD_EVENT, {
      detail: fromServer || OVERLOAD_FALLBACK_MESSAGE,
    }),
  );
}

// Re-entrancy latch for the 403 probe: while the probe's own authRefresh is in
// flight, its response also passes through afterSend → invalidateStaleSession,
// and a CF-shaped 403 there must not spawn another probe.
let probingSession = false;

async function probeSession(): Promise<void> {
  if (probingSession) return;
  probingSession = true;
  try {
    await refreshAuth();
  } finally {
    probingSession = false;
  }
}

// Covers every request made through the SDK (pb.collection(...).create/update/…).
pb.afterSend = (response, data) => {
  invalidateStaleSession(response?.status ?? 0);
  noteServerOverload(response?.status ?? 0, data);
  return data;
};

// Wrapper for the custom Go endpoints we call with raw fetch (tag votes, game
// upvotes, comments) — the SDK's afterSend never sees those. Attaches the auth
// token and applies the same 401 → logged-out fallback.
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  // FormData bodies must keep the browser-generated multipart boundary —
  // forcing a Content-Type here would break server-side multipart parsing.
  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  // A locally-expired token is dead weight — sending it only earns a 401.
  // Clear it up front so the UI flips to logged-out immediately.
  if (pb.authStore.token && !pb.authStore.isValid) pb.authStore.clear();
  if (pb.authStore.token) headers.set('Authorization', `Bearer ${pb.authStore.token}`);
  const res = await fetch(input, { ...init, headers });
  invalidateStaleSession(res.status);
  // The body stays untouched for the caller — the generic message is enough.
  noteServerOverload(res.status);
  return res;
}

// Proactively reissue the token while it is still valid, so an active user's
// session is continually renewed and effectively never reaches its expiry.
// Called on app load and when the tab regains focus. A token that is already
// dead 401s here → afterSend clears it → the UI flips to logged-out. No-op when
// signed out; transient/network errors leave the current token untouched.
export async function refreshAuth(): Promise<void> {
  if (!pb.authStore.token) return;
  if (!pb.authStore.isValid) {
    // Locally expired: the server would reject an authRefresh anyway. Clear
    // instead of returning silently — a bare return leaves the persisted model
    // rendering the user as signed in with no path back to reality (the app
    // load / tab focus that called us was exactly the self-heal opportunity).
    pb.authStore.clear();
    return;
  }
  try {
    await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
  } catch {
    /* 401 handled by afterSend; other errors keep the current token */
  }
}

// ── Forum SSO cookie ───────────────────────────────────────────────────────
// The OAuth2 authorize endpoint (cyoa.cafe/oauth2/auth) is reached by a plain
// top-level redirect from forum.cyoa.cafe, so it cannot read our localStorage
// token. Mirror the token into a cookie scoped to /oauth2 — the Go plugin
// adopts it and issues the code silently, making the whole forum hop a chain
// of invisible redirects with no login page. Kept in sync on every auth
// change (login, proactive refresh, logout/401-invalidation).
function syncSsoCookie(): void {
  const base = 'pb_auth=; Path=/oauth2; Secure; SameSite=Lax';
  if (pb.authStore.isValid && pb.authStore.token) {
    // Max-Age matches the 30d prod token duration; the token inside expires
    // on its own schedule and the server re-validates it every time.
    document.cookie = `pb_auth=${pb.authStore.token}; Path=/oauth2; Max-Age=2592000; Secure; SameSite=Lax`;
  } else {
    document.cookie = `${base}; Max-Age=0`;
  }
}
pb.authStore.onChange(syncSsoCookie);
syncSsoCookie();

// Anonymous client for PUBLIC read-only catalog lists (games/tags/authors/
// tag_categories). The authed `pb` attaches an Authorization header to every
// request, which makes Cloudflare mark the response `cf-cache-status: DYNAMIC`
// and bypass the edge cache entirely — so a logged-in user NEVER hits the
// cache. These lists are publicly readable (anonymous already reads them), so
// sending them without a token lets them land in the existing Cloudflare cache
// rules (R4a tags/authors/categories = 1 day, R4b games list = 5 min). This is
// the single biggest win for logged-in load times.
//
// CRITICAL: a bare `new PocketBase(url)` defaults to LocalAuthStore, which reads
// the SAME localStorage key (`pocketbase_auth`) as the authed `pb`. So a "public"
// client built that way still picks up the logged-in token and sends
// Authorization → DYNAMIC (the bug that made this whole optimization a no-op for
// logged-in users). Pass an isolated in-memory BaseAuthStore so it starts empty
// and NEVER touches localStorage — guaranteeing token-free, cacheable requests.
export const pbPublic = new PocketBase(window.location.origin, new BaseAuthStore());

pbPublic.autoCancellation(false);

type RecordModel = {
  id: string;
  created: string;
  updated: string;
  collectionId: string;
  collectionName: string;
};

export type User = RecordModel & {
  username: string;
  email: string;
  name: string;
  avatar: string;
  isModerator: boolean;
  username_locked?: boolean;
  blocked_tags?: string[];
  blocked_tags_customized?: boolean;
  // Персональный «блеклист» игр: relation → games. Игры из списка тихо скрыты
  // у этого юзера в каталоге и любом поиске (фильтруются на клиенте, чтобы не
  // ломать анонимный кэш каталога). Приходит как массив id без expand.
  blocked_games?: string[];
} & {
  expand?: {
    blocked_tags?: Tag[];
  };
};

export const usersCollection = pb.collection('users') as RecordService<User>;

export type Tag = RecordModel & {
  name: string;
  games: string[];
  description: string;
  aliases?: string; // синонимы через \n (см. utils/fuzzy)
} & {
  expand?: {
    tag_categories_via_tags?: [TagCategory];
  };
};

export const tagsCollection = pb.collection('tags') as RecordService<Tag>;
export const tagsCollectionPublic = pbPublic.collection('tags') as RecordService<Tag>;

export type GameTagVote = RecordModel & {
  gameId: string;
  tagId: string;
  votes: number;
  upVoters: string[];
  downVoters: string[];
};

export const gameTagVotesCollection = pb.collection('game_tag_votes') as RecordService<GameTagVote>;

export type TagCategory = RecordModel & {
  name: string;
  allow_new_tags: boolean;
  min_tags: number;
  max_tags: number;
  tags: string[];
  description: string;
} & {
  expand?: {
    tags?: Tag[];
  };
};

export const tagCategoriesCollection = pb.collection('tag_categories') as RecordService<TagCategory>;
export const tagCategoriesCollectionPublic = pbPublic.collection('tag_categories') as RecordService<TagCategory>;

export type Game = RecordModel & {
  title: string;
  // Human-readable URL key derived from title (see PB/slugify.py — the Go/Python
  // slugifiers MUST stay byte-identical). Empty on collisions/hidden games, which
  // keep resolving by record id. The canonical /game/<slug> URL; old ids and
  // retired slugs redirect to it (see resolveGameByParam + game_slug_aliases).
  slug?: string;
  description: string;
  image: string;
  cyoa_pages_preview: string[];
  tags: string[];
  aliases?: string; // альт-названия через \n (см. utils/fuzzy)
  img_or_link: 'img' | 'link';
  iframe_url: string;
  cyoa_pages: string[];
  upvotes: string[]; 
  upvotes_count?: number; 
  comments: string[];
  comments_count?: number;
  uploader: string;
  image_base64?: string;
  authors?: string[];
  // Denormalized ids of this game's "gold" tags (accepted, score >= 15, eligible
  // category). Maintained server-side so the catalog can flag them without loading
  // per-tag vote scores. See main.go tag-vote handler + PB/backfill_gold_tags.py.
  gold_tags?: string[];
  // Язык оригинала, что лежит inline в этой записи (гибрид-модель мультиязычности).
  // Пусто → трактуем как 'en'. Переводы/иные версии — в коллекции game_variants.
  language?: string;
  original_link?: string;
  release_date?: string;
  created?: string;
  // Сортировочный ключ каталога («new» = -bumped_at,-created): сеется = created
  // при создании, двигается вперёд бампом владельца/модера (см. game_edits.go).
  bumped_at?: string;
  hidden?: boolean;
  // «Свежий авторский релиз» (галка «I'm the author» на /create). Пин на главной и
  // бейдж «New» считаются как original_release && created within PINNED_ORIGINAL_DAYS —
  // оба сами гаснут. Раньше сигнал был тегом Original (вечным); теперь чистое поле.
  original_release?: boolean;
} & {
  expand?: {
    tags?: Tag[];
    authors?: Author[];
    upvotes?: User[];
    comments?: Comment[];
  };
};

export const gamesCollection = pb.collection('games') as RecordService<Game>;
export const gamesCollectionPublic = pbPublic.collection('games') as RecordService<Game>;

// Персональный дисмисс закрепа: (user, game) = «этот юзер уже смотрел этот
// свежий релиз, больше не закреплять». Залогинен → строка на сервере (синк меж
// устройств, правила user = @request.auth.id); аноним → localStorage. См.
// markPinnedSeen/loadPinnedSeen ниже, коллекция pinned_seen (unique(user,game)).
export type PinnedSeen = RecordModel & { user: string; game: string };
export const pinnedSeenCollection = pb.collection('pinned_seen') as RecordService<PinnedSeen>;

// Whitelist of the only fields a catalog GameCard renders. Pass as the `fields`
// query param on every game-list query so PocketBase doesn't ship the heavy
// relation ARRAYS on each card — `upvotes` (every upvoter's id), `comments`,
// `cyoa_pages`/`cyoa_pages_preview` (page filenames, dozens on image CYOAs) —
// plus unused scalars (iframe_url, original_link, uploader, files, dates). Cards
// show counts only, never the arrays. `image_base64` is kept on purpose (the
// blur-up placeholder). Per-user "did I upvote" state lives on the detail page.
// Свежий авторский релиз: закреп на главной И бейдж «New» живут N дней от created,
// затем сами гаснут. Единый источник для GameCard (бейдж) и SearchPage (пин-запрос).
export const PINNED_ORIGINAL_DAYS = 5;

export function isFreshOriginal(game: Pick<Game, 'original_release' | 'created'>): boolean {
  if (!game.original_release || !game.created) return false;
  const createdMs = new Date(game.created).getTime();
  if (Number.isNaN(createdMs)) return false;
  return Date.now() - createdMs <= PINNED_ORIGINAL_DAYS * 24 * 60 * 60 * 1000;
}

// «Bump!» — карточка недавно выиграла бамп-рулетку (bump_roulette.go: winner.Set
// ("bumped_at", now()) при розыгрыше). bumped_at сеется = created при создании
// игры и двигается вперёд только реальным бампом (авто-розыгрыш или ручной bump
// владельца/модера) — поэтому "bumped_at заметно позже created" достаточно, чтобы
// отличить бамп от свежесозданной игры, без похода в bump_draws/bump_votes.
export const BUMP_FRESH_DAYS = 7;
const BUMP_VS_CREATED_SLACK_MS = 60 * 1000; // защита от миллисекундного дребезга при сидировании

export function isFreshBump(game: Pick<Game, 'bumped_at' | 'created'>): boolean {
  if (!game.bumped_at || !game.created) return false;
  const bumpedMs = new Date(game.bumped_at).getTime();
  const createdMs = new Date(game.created).getTime();
  if (Number.isNaN(bumpedMs) || Number.isNaN(createdMs)) return false;
  if (bumpedMs - createdMs <= BUMP_VS_CREATED_SLACK_MS) return false;
  return Date.now() - bumpedMs <= BUMP_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

// --- Персональный дисмисс закрепа («посмотрел релиз → открепился») ---
// Аноним хранит просмотренные локально; список короткий (только свежие пины
// вообще имеют значение), но подрезаем на всякий, чтобы не пух.
const PINNED_SEEN_LS_KEY = 'pinned_seen_ids';
function readLocalPinnedSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_SEEN_LS_KEY) || '[]')); }
  catch { return new Set(); }
}
function writeLocalPinnedSeen(ids: Set<string>) {
  try { localStorage.setItem(PINNED_SEEN_LS_KEY, JSON.stringify([...ids].slice(-500))); }
  catch { /* приватный режим / переполнение — не критично */ }
}

// Отметить свежий релиз просмотренным (открепить у этого юзера). Идемпотентно:
// unique(user,game) отвергает дубль — глотаем. Ошибка отметки НЕ должна ломать
// открытие игры, поэтому всё в try/catch и fire-and-forget.
export async function markPinnedSeen(gameId: string): Promise<void> {
  const uid = pb.authStore.model?.id;
  if (pb.authStore.isValid && uid) {
    try { await pinnedSeenCollection.create({ user: uid, game: gameId }); }
    catch { /* дубль (unique) или сеть — не важно */ }
  } else {
    const s = readLocalPinnedSeen(); s.add(gameId); writeLocalPinnedSeen(s);
  }
}

// Прочитать «уже просмотренные» среди кандидатов (обычно ≤10 закреплённых id),
// чтобы серверный ответ был ограничен независимо от истории юзера.
export async function loadPinnedSeen(candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const uid = pb.authStore.model?.id;
  if (pb.authStore.isValid && uid) {
    try {
      const inClause = candidateIds.map((id) => `game = "${id}"`).join(' || ');
      const rows = await pinnedSeenCollection.getFullList({
        filter: `user = "${uid}" && (${inClause})`, fields: 'game',
      });
      return new Set(rows.map((r) => r.game));
    } catch { return new Set(); }
  }
  return readLocalPinnedSeen();
}

export const CATALOG_GAME_FIELDS = [
  'id', 'collectionId', 'slug', 'title', 'description', 'image', 'image_base64',
  'upvotes_count', 'comments_count', 'gold_tags',
  // created + original_release: пин на главной и бейдж «New» (см. GameCard/SearchPage).
  // bumped_at: бейдж «Bump!» (isFreshBump). Все три — копеечные скаляры,
  // заменяют скан expand.tags на тег Original.
  'created', 'original_release', 'bumped_at',
  'expand.authors.id', 'expand.authors.name',
  'expand.tags.id', 'expand.tags.name',
].join(',');
// NOTE: the nested `expand.tags.expand.tag_categories_via_tags.*` back-relation is
// deliberately NOT requested here. It was an N+1 over the taxonomy (the category of
// every tag of every game) computed on EVERY catalog request (~0.3-0.4s origin). The
// tag→category mapping is GLOBAL and identical for all games, so it's loaded once
// app-wide and shared via TagCategoryContext (see below); GameCard resolves a tag's
// category from that map by tag id instead of a per-game expand.

// Whitelist for the single-game detail page (GameDetails.getOne). Without it the
// getOne ships the WHOLE record: the `upvotes` array (every upvoter's id — 5 KB on
// a popular game), the `comments` array, and — the big one — the full
// `tag_categories_via_tags` back-relation, which re-expands every tag of every
// category (~33 KB). Same taxonomy bloat as the catalog. Measured on prod: full
// getOne 46 KB → trimmed 6.5 KB (−86%). The page needs only the upvote COUNT
// (`upvotes_count`); "did I upvote" is a separate id-only per-user query in
// GameAdditionalInfo. `cyoa_pages`/`cyoa_pages_preview` ARE needed here (static
// game images) — unlike the catalog. `comments` array is never read (Comments
// fetches its own list by game id).
export const GAME_DETAIL_FIELDS = [
  'id', 'collectionId', 'slug', 'title', 'description', 'image', 'image_base64',
  // aliases — альт-названия (по одному в строке): строкой над тегами и
  // префиллом модерской формы правки. Скаляр в пару сотен байт.
  'aliases',
  'img_or_link', 'iframe_url', 'cyoa_pages', 'cyoa_pages_preview',
  'language', 'upvotes_count',
  // Управление карточкой (владелец/модер): кто владелец, окно самоудаления (created),
  // кулдаун бампа и префилл формы правки. Всё лёгкие скаляры.
  'uploader', 'created', 'bumped_at', 'original_link', 'release_date',
  // original_release: чтобы деталка могла отметить свежий релиз просмотренным
  // (открепить у юзера, markPinnedSeen) и не рисовать «New» после срока.
  'original_release',
  'expand.authors.id', 'expand.authors.name',
  'expand.tags.id', 'expand.tags.name',
  'expand.tags.expand.tag_categories_via_tags.id',
  'expand.tags.expand.tag_categories_via_tags.name',
].join(',');

// Языковой/версионный вариант игры (мультиязычность, гибрид-модель — см.
// wiki/components/multilang-variants-spec.md). Канон-игра (games) держит
// лайки/комменты/теги/топ и контент ОРИГИНАЛА; game_variants хранит ТОЛЬКО
// альтернативные языки/версии. Файловые поля (image/cyoa_pages/*) резолвятся из
// СОБСТВЕННЫХ collectionId+id варианта: /api/files/{collectionId}/{id}/{file}.
export type GameVariant = RecordModel & {
  game: string;                 // relation → games (канон)
  language: string;             // ISO 639-1: ko, ja, ru...
  version_label?: string;       // v2 / Director's Cut / пусто = текущая
  title?: string;               // пусто → games.title
  description?: string;         // пусто → games.description
  img_or_link?: 'img' | 'link';
  iframe_url?: string;
  cyoa_pages?: string[];
  cyoa_pages_preview?: string[];
  image?: string;               // пусто → games.image
  image_base64?: string;
};

export const gameVariantsCollectionPublic =
  pbPublic.collection('game_variants') as RecordService<GameVariant>;

// Публичное чтение вариантов на странице игры: только поля для переключателя и
// подмены контента. rich_description (эмбеддинги) и служебное не тянем.
export const VARIANT_FIELDS = [
  'id', 'collectionId', 'language', 'version_label', 'title', 'description',
  'img_or_link', 'iframe_url', 'cyoa_pages', 'cyoa_pages_preview',
  'image', 'image_base64',
].join(',');

// ── Pretty game URLs: slug ↔ record-id resolution ────────────────────────────
// A game is addressed by /game/<slug>. Old links (/game/<record-id>) and retired
// slugs (title was edited) must keep working, so resolution has three tiers:
//   1. legacy record id  → getOne
//   2. current slug       → games.slug lookup
//   3. retired slug       → game_slug_aliases → canonical game
// Whichever tier hits, the caller compares the resolved game's canonical key
// (slug || id) against the URL param and client-side-redirects if they differ.

// A retired slug pointing at its current game. Written when a title (hence slug)
// changes, so every URL a game ever had keeps resolving. Read is public; writes
// are backend-only (admin/hooks). See PB/add_slug_and_aliases.py.
export type GameSlugAlias = RecordModel & { slug: string; game: string };
export const gameSlugAliasesCollectionPublic =
  pbPublic.collection('game_slug_aliases') as RecordService<GameSlugAlias>;

// A PocketBase record id is exactly 15 lowercase alphanumerics. Slugs are
// lowercase alphanumerics + hyphens; a hyphen (or any other length) is
// unambiguously a slug. A 15-char hyphenless string is *probably* a legacy id —
// we try it as an id first and fall back to a slug lookup if that 404s, so the
// rare single-word 15-char slug still resolves.
const LEGACY_ID_RE = /^[a-z0-9]{15}$/;

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { status?: number }).status === 404);
}

const GAME_RESOLVE_OPTS = {
  expand: 'tags.tag_categories_via_tags,authors',
  fields: GAME_DETAIL_FIELDS,
};

// Resolve a /game/:param URL segment (legacy id, current slug, or retired slug)
// to its canonical Game record. Throws (404) only when nothing matches any tier.
export async function resolveGameByParam(param: string): Promise<Game> {
  if (LEGACY_ID_RE.test(param)) {
    try {
      return await gamesCollection.getOne<Game>(param, GAME_RESOLVE_OPTS);
    } catch (err) {
      if (!isNotFound(err)) throw err; // real error, not "id-shaped slug" — surface it
      // else: not a real id, fall through and try it as a slug
    }
  }
  try {
    return await gamesCollection.getFirstListItem<Game>(
      pbPublic.filter('slug = {:slug}', { slug: param }),
      GAME_RESOLVE_OPTS,
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  // Retired slug → alias → canonical game (one extra hop, only for stale links).
  const alias = await gameSlugAliasesCollectionPublic.getFirstListItem<GameSlugAlias>(
    pbPublic.filter('slug = {:slug}', { slug: param }),
    { fields: 'game' },
  );
  return gamesCollection.getOne<Game>(alias.game, GAME_RESOLVE_OPTS);
}

// The canonical URL key for a game: its slug when set, else the record id
// (collisions / hidden games have no slug and stay on their id URL).
export function gameCanonicalKey(game: Pick<Game, 'id' | 'slug'>): string {
  return game.slug || game.id;
}

export type Comment = RecordModel & {
  content: string;
  author: string;
  children: string[];
  parent: string;
  game?: string;
  deleted?: boolean;
  pinned?: boolean;
  // 'changelog' = единственный закреплённый коммент-журнал бампов игры
  // (записи добавляет Go при бампе, свежие сверху).
  kind?: 'normal' | 'changelog';
  likes?: string[];
  likes_count?: number;
} & {
  expand?: {
    author?: User;
    children?: Comment[];
    game?: Game;  
  };
};

export const commentsCollection = pb.collection('comments') as RecordService<Comment>;

// Реестр билдов чит-компаньона: КАЖДЫЙ билд юзера (и публичный, и приватный)
// = запись здесь; публичный дополнительно живёт комментом-«витриной» в треде
// (лайки/реплаи/модерация бесплатно), id витрины — в `comment`. На реестр
// опираются гейт читов, значок «есть билд» в каталоге и блок "My builds".
// PB-правила: owner-only на всё — чужие/анонимы записей не видят вообще.
export type Build = RecordModel & {
  user: string;
  game: string;
  code: string;
  summary: {
    count: number;
    points?: { name: string; value: number }[];
    choices?: { id: string; title: string }[];
  };
  public: boolean;
  comment?: string;
};

export const buildsCollection = pb.collection('builds') as RecordService<Build>;

export type NotificationType =
  | 'comment_on_game' | 'reply' | 'mention' | 'mod_reply'
  | 'shout_mention' | 'shout_reply';

export type Notification = RecordModel & {
  recipient: string;
  type: NotificationType;
  actor?: string;
  comment?: string;
  game?: string;
  read: boolean;
} & {
  expand?: {
    actor?: User;
    game?: Game;
    comment?: Comment;
  };
};

export const notificationsCollection = pb.collection('notifications') as RecordService<Notification>;

export type ModRequestKind =
  | 'wrong_author'
  | 'dead_link'
  | 'missing_images'
  | 'change_tag'
  | 'update_version'
  | 'relation'
  | 'duplicate'
  | 'illegal'
  | 'other';
export type ModRequestStatus = 'open' | 'in_progress' | 'resolved' | 'trash';

export type ModRequest = RecordModel & {
  comment: string;
  game?: string;
  requester?: string;
  kind: ModRequestKind;
  status: ModRequestStatus;
  assignee?: string;
  internal_note?: string;
} & {
  expand?: {
    comment?: Comment;
    game?: Game;
    requester?: User;
    assignee?: User;
  };
};

export const modRequestsCollection = pb.collection('mod_requests') as RecordService<ModRequest>;

export type Author = RecordModel & {
  name: string;
  description: string;
  games: string[];
  aliases?: string; // синонимы через \n (см. utils/fuzzy)
} & {
  expand?: {
    games?: Game[];
  };
};

export const authorsCollection = pb.collection('authors') as RecordService<Author>;
export const authorsCollectionPublic = pbPublic.collection('authors') as RecordService<Author>;

export type Announcement = RecordModel & {
  title: string;
  body: string;
};

export const announcementsCollectionPublic =
  pbPublic.collection('announcements') as RecordService<Announcement>;

export type GameRelationship = RecordModel & {
  source_game: string;
  target_game: string;
  relationship_type: 'Translation' | 'Expansion' | 'Sequel' | 'Interactive Port' | 'Static Port' | 'DLC' | 'Inspired By';
  order_in_series?: number;
  source_language?: string;
  target_language?: string;
  description_source?: string;
  description_target?: string;
} & {
  expand?: {
    source_game?: Game;
    target_game?: Game;
  };
};

export const gameRelationshipsCollection = pb.collection('game_relationships') as RecordService<GameRelationship>;

export const AuthContext = createContext({
  signedIn: false,
  user: null as User | null,
  isModerator: false,
  blockedTags: [] as Tag[],
  // Id игр, которые юзер спрятал от себя (см. User.blocked_games). Хватает id —
  // фильтрация каталога/поиска идёт по этому набору на клиенте.
  blockedGameIds: [] as string[],
});

// Ids of the games the logged-in user has a build for (public or private) —
// one id-only query on the `builds` registry, loaded app-wide so GameCard can
// show the "you built this" die badge. Kept OUT of the catalog payload on
// purpose: per-user state must never ride on the anonymous cacheable lists.
export const MyBuiltGamesContext = createContext<Set<string>>(new Set());

// Global `tagId → categoryName` map, loaded once from `tag_categories` (its
// taxonomy is identical for every game) and shared app-wide. Replaces the per-game
// `tags.tag_categories_via_tags` expand on catalog queries — GameCard reads a tag's
// category from this map by id. Default empty map = no category (chip falls back to
// the neutral color, same as a tag without a category today).
export const TagCategoryContext = createContext<Map<string, string>>(new Map());