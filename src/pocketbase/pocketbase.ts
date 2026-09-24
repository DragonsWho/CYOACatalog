import PocketBase, { RecordService, BaseAuthStore } from 'pocketbase';
import { createContext } from 'react';

export const pb = new PocketBase(window.location.origin);

pb.autoCancellation(false);

// ── Session integrity ── PocketBase's `authStore.isValid` checks only the JWT's LOCAL expiry and
// never asks the server. A token the server rejects (lapsed or invalidated) would leave the UI
// signed-in while every authed write silently 401s ("likes stopped working, re-login fixes it").
// Rule: any authed 401 → clear the token so the UI falls back to logged-out. A 403 is usually a
// VALID token lacking permission (username-change-once, mod-only, editing others' comments) and
// must never sign out directly — but Cloudflare/WAF may answer 403 to a dead token before PB can
// 401, so a 403 triggers a background authRefresh probe: a live token survives, a dead one 401s
// there and is cleared via this same path.
function invalidateStaleSession(status: number): void {
  if (!pb.authStore.token && !pb.authStore.model) return;
  if (status === 401) {
    // No isValid precondition: a token can be locally expired (isValid=false) while the persisted
    // model still renders the user signed-in — that 401 must clear the store too, or the zombie
    // session survives every click.
    pb.authStore.clear();
  } else if (status === 403) {
    void probeSession();
  }
}

// ── Server overload notice ── The backend caps concurrent API requests (overload.go) and answers
// 503 instead of queueing until the box swaps to death. Also Cloudflare 503s when origin is
// unreachable. Both are temporary, not the user's fault: raise one app-wide event, OverloadNotice
// shows a single "site is busy" snackbar.
export const OVERLOAD_EVENT = 'cyoa:overload';
const OVERLOAD_FALLBACK_MESSAGE =
  'The site is under heavy load right now. Please try again in a minute.';
// At most one notice per 30s — an overloaded page fires a dozen failing requests at once.
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

// Re-entrancy latch: the probe's own authRefresh response also passes through afterSend →
// invalidateStaleSession; a CF-shaped 403 there must not spawn another probe.
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

// Covers every SDK request (pb.collection(...).create/update/…).
pb.afterSend = (response, data) => {
  invalidateStaleSession(response?.status ?? 0);
  noteServerOverload(response?.status ?? 0, data);
  return data;
};

// Wrapper for custom Go endpoints called with raw fetch (tag votes, upvotes, comments) — the SDK's
// afterSend never sees those. Attaches the token and applies the same 401 → logged-out fallback.
export async function authedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  // FormData must keep the browser-generated multipart boundary — forcing Content-Type breaks
  // server-side parsing.
  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  // A locally-expired token only earns a 401; clear it up front so the UI flips to logged-out
  // immediately.
  if (pb.authStore.token && !pb.authStore.isValid) pb.authStore.clear();
  if (pb.authStore.token) headers.set('Authorization', `Bearer ${pb.authStore.token}`);
  const res = await fetch(input, { ...init, headers });
  invalidateStaleSession(res.status);
  noteServerOverload(res.status);
  return res;
}

// Proactively reissue the token while still valid (app load + tab focus) so an active session never
// reaches expiry. A dead token 401s → afterSend clears it. No-op when signed out; transient/network
// errors keep the current token.
export async function refreshAuth(): Promise<void> {
  if (!pb.authStore.token) return;
  if (!pb.authStore.isValid) {
    // Locally expired: clear instead of returning — a bare return leaves the persisted model
    // rendering a signed-in user with no path back (this call was the self-heal opportunity).
    pb.authStore.clear();
    return;
  }
  try {
    await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
  } catch {
  // 401 handled by afterSend; other errors keep the current token
  }
}

// ── Forum SSO cookie ── /oauth2/auth is reached by a top-level redirect from forum.cyoa.cafe and
// cannot read localStorage. Mirror the token into a cookie scoped to /oauth2; the Go plugin adopts
// it and issues the code silently, so the forum hop is invisible redirects with no login page. Kept
// in sync on every auth change (login, refresh, logout/401).
function syncSsoCookie(): void {
  const base = 'pb_auth=; Path=/oauth2; Secure; SameSite=Lax';
  if (pb.authStore.isValid && pb.authStore.token) {
    // Max-Age matches the 30d prod token duration; the server re-validates the token every time
    // anyway.
    document.cookie = `pb_auth=${pb.authStore.token}; Path=/oauth2; Max-Age=2592000; Secure; SameSite=Lax`;
  } else {
    document.cookie = `${base}; Max-Age=0`;
  }
}
pb.authStore.onChange(syncSsoCookie);
syncSsoCookie();

// Anonymous client for PUBLIC read-only catalog lists (games/tags/authors/tag_categories). Any
// Authorization header makes Cloudflare return `cf-cache-status: DYNAMIC` and bypass the edge
// cache, so logged-in users would never hit it. Token-free requests land in the CF cache rules (R4a
// tags/authors/categories = 1d, R4b games list = 5min) — biggest logged-in load-time win. CRITICAL:
// a bare `new PocketBase(url)` uses LocalAuthStore, which reads the SAME `pocketbase_auth`
// localStorage key as `pb` and still sends the token (the bug that once made this a no-op). Must
// use an isolated in-memory BaseAuthStore.
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
  // PB system field: email confirmed
  verified?: boolean;
  // "Hide me from chat member list". Default = shown, so empty = listed; edited in profile settings
  // and via the chat toggle.
  chat_hidden?: boolean;
  blocked_tags?: string[];
  blocked_tags_customized?: boolean;
  // Personal game blacklist: relation → games. Hidden for this user in catalog and all search —
  // filtered CLIENT-side so the anonymous catalog cache stays intact. Arrives as bare id array (no
  // expand).
  blocked_games?: string[];
  // Author blacklist: relation → authors. Filtered PB-side like blocked_tags. Bare id array; names
  // are fetched only in profile settings.
  blocked_authors?: string[];
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
  aliases?: string;  // synonyms, newline-separated (see utils/fuzzy)
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
  // URL key derived from title (PB/slugify.py — Go and Python slugifiers MUST stay byte-identical).
  // Empty on collisions/hidden games, which resolve by record id. Old ids and retired slugs
  // redirect to /game/<slug> (resolveGameByParam + game_slug_aliases).
  slug?: string;
  description: string;
  image: string;
  cyoa_pages_preview: string[];
  tags: string[];
  aliases?: string;  // alt titles, newline-separated (see utils/aliases)
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
  // Denormalized ids of this game's "gold" tags (accepted, score >= 15, eligible category),
  // maintained server-side so the catalog can flag them without per-tag scores. See main.go
  // tag-vote handler + PB/backfill_gold_tags.py.
  gold_tags?: string[];
  // Language of the original stored inline (hybrid multilang model). Empty → 'en'.
  // Translations/other versions live in game_variants.
  language?: string;
  original_link?: string;
  release_date?: string;
  created?: string;
  // Catalog sort key ("new" = -bumped_at,-created): seeded = created, moved forward by owner/mod
  // bump (game_edits.go).
  bumped_at?: string;
  hidden?: boolean;
  // "Fresh author release" (the "I'm the author" checkbox on /create). Home pin and "New" badge =
  // original_release && created within PINNED_ORIGINAL_DAYS — both expire on their own. Formerly
  // the (eternal) Original tag; now a plain field.
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

// Per-user pin dismiss: (user, game) = "already saw this fresh release, stop pinning". Logged in →
// server row (syncs across devices, rule user = @request.auth.id); anon → localStorage. Collection
// pinned_seen, unique(user,game).
export type PinnedSeen = RecordModel & { user: string; game: string };
export const pinnedSeenCollection = pb.collection('pinned_seen') as RecordService<PinnedSeen>;

// Whitelist of fields a catalog GameCard renders; pass as `fields` on every game-list query so PB
// doesn't ship heavy relation ARRAYS per card (`upvotes` = every upvoter id, `comments`,
// `cyoa_pages*`) or unused scalars. Cards show counts only. `image_base64` kept on purpose (blur-up
// placeholder). Per-user "did I upvote" lives on the detail page.
// Fresh-release pin and "New" badge live N days from created — single source for GameCard (badge)
// and SearchPage (pin query).
export { PINNED_ORIGINAL_DAYS, isFreshOriginal, BUMP_FRESH_DAYS, isFreshBump } from '../components/cardGeometry';

// --- Per-user pin dismiss --- Anon stores seen ids locally; only fresh pins matter, but trim
// anyway so it doesn't grow.
const PINNED_SEEN_LS_KEY = 'pinned_seen_ids';
function readLocalPinnedSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(PINNED_SEEN_LS_KEY) || '[]')); }
  catch { return new Set(); }
}
// Synchronous best guess of dismissed pins (the local mirror; logged-in users' server set is
// mirrored here too) — lets the home feed seed its first paint without a pin jump.
export function peekPinnedSeen(): Set<string> {
  return readLocalPinnedSeen();
}
function writeLocalPinnedSeen(ids: Set<string>) {
  try { localStorage.setItem(PINNED_SEEN_LS_KEY, JSON.stringify([...ids].slice(-500))); }
  catch { }
}

// Mark a fresh release seen (unpin for this user). Idempotent: unique(user,game) rejects duplicates
// — swallowed. Must never break opening the game: try/catch, fire-and-forget.
export async function markPinnedSeen(gameId: string): Promise<void> {
  const uid = pb.authStore.model?.id;
  const s = readLocalPinnedSeen(); s.add(gameId); writeLocalPinnedSeen(s);
  if (pb.authStore.isValid && uid) {
    try { await pinnedSeenCollection.create({ user: uid, game: gameId }); }
    catch { }
  }
}

// Query "already seen" only among candidates (usually ≤10 pinned ids) so the response is bounded
// regardless of user history.
export async function loadPinnedSeen(candidateIds: string[]): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const uid = pb.authStore.model?.id;
  if (pb.authStore.isValid && uid) {
    try {
      const inClause = candidateIds.map((id) => `game = "${id}"`).join(' || ');
      const rows = await pinnedSeenCollection.getFullList({
        filter: `user = "${uid}" && (${inClause})`, fields: 'game',
      });
      const seen = new Set<string>(rows.map((r) => r.game));
      if (seen.size) {
        const local = readLocalPinnedSeen();
        seen.forEach((id) => local.add(id));
        writeLocalPinnedSeen(local);
      }
      return seen;
    } catch { return new Set(); }
  }
  return readLocalPinnedSeen();
}

export const CATALOG_GAME_FIELDS = [
  'id', 'collectionId', 'slug', 'title', 'description', 'image', 'image_base64',
  'upvotes_count', 'comments_count', 'gold_tags',
  // created + original_release: home pin and "New" badge. bumped_at: "Bump!" badge (isFreshBump).
  // Cheap scalars replacing an expand.tags scan for the Original tag.
  'created', 'original_release', 'bumped_at',
  'expand.authors.id', 'expand.authors.name',
  'expand.tags.id', 'expand.tags.name',
].join(',');

// NOTE: `expand.tags.expand.tag_categories_via_tags.*` is deliberately NOT requested — it was an
// N+1 over the taxonomy on EVERY catalog request (~0.3-0.4s origin). tag→category is global, loaded
// once via TagCategoryContext; GameCard resolves by tag id.
// Whitelist for the detail page getOne. Without it PB ships the whole record: `upvotes` array (~5
// KB on popular games), `comments`, and the full `tag_categories_via_tags` back-relation (~33 KB).
// Measured on prod: 46 KB → 6.5 KB (−86%). Page needs only `upvotes_count`; "did I upvote" is a
// separate id-only query in GameAdditionalInfo. `cyoa_pages*` ARE needed here (static game images).
// `comments` is never read (Comments fetches by game id).
export const GAME_DETAIL_FIELDS = [
  'id', 'collectionId', 'slug', 'title', 'description', 'image', 'image_base64',
  // aliases: alt titles line above the tags + prefill of the mod edit form. A few hundred bytes.
  'aliases',
  'img_or_link', 'iframe_url', 'cyoa_pages', 'cyoa_pages_preview',
  'language', 'upvotes_count',
  // Card management (owner/mod): owner, self-delete window (created), bump cooldown, edit-form
  // prefill. All light scalars.
  'uploader', 'created', 'bumped_at', 'original_link', 'release_date',
  // original_release: lets the detail page mark the release seen (markPinnedSeen) and hide "New"
  // after expiry.
  'original_release',
  'expand.authors.id', 'expand.authors.name',
  'expand.tags.id', 'expand.tags.name',
  'expand.tags.expand.tag_categories_via_tags.id',
  'expand.tags.expand.tag_categories_via_tags.name',
].join(',');

// Language/version variant (hybrid multilang — wiki/components/multilang-variants-spec.md). The
// canonical `games` row holds likes/comments/tags/top and the ORIGINAL's content; game_variants
// holds ONLY alternative languages/versions. File fields resolve via the VARIANT's own
// collectionId+id: /api/files/{collectionId}/{id}/{file}.
export type GameVariant = RecordModel & {
  game: string;  // relation → games (canonical)
  language: string;  // ISO 639-1: ko, ja, ru...
  version_label?: string;  // v2 / Director's Cut / empty = current
  title?: string;  // empty → games.title
  description?: string;  // empty → games.description
  img_or_link?: 'img' | 'link';
  iframe_url?: string;
  cyoa_pages?: string[];
  cyoa_pages_preview?: string[];
  image?: string;  // empty → games.image
  image_base64?: string;
};

export const gameVariantsCollectionPublic =
  pbPublic.collection('game_variants') as RecordService<GameVariant>;

// Public read on the game page: only switcher + content-override fields. rich_description
// (embeddings) and internals are not fetched.
export const VARIANT_FIELDS = [
  'id', 'collectionId', 'language', 'version_label', 'title', 'description',
  'img_or_link', 'iframe_url', 'cyoa_pages', 'cyoa_pages_preview',
  'image', 'image_base64',
].join(',');

// ── Pretty game URLs ── A game lives at /game/<slug>. Old /game/<record-id> links and retired
// slugs must keep working, so resolution has three tiers: 1) legacy record id → getOne; 2) current
// slug → games.slug; 3) retired slug → game_slug_aliases → canonical game. The caller compares the
// canonical key (slug || id) with the URL param and client-side-redirects on mismatch.
// Retired slug → current game. Written when a title (hence slug) changes, so every URL a game ever
// had keeps resolving. Public read; writes backend-only. See PB/add_slug_and_aliases.py.
export type GameSlugAlias = RecordModel & { slug: string; game: string };
export const gameSlugAliasesCollectionPublic =
  pbPublic.collection('game_slug_aliases') as RecordService<GameSlugAlias>;

// PB record id = exactly 15 lowercase alphanumerics. A hyphen or other length means slug. A 15-char
// hyphenless string is PROBABLY an id: try getOne first, fall back to slug lookup on 404, so a rare
// single-word 15-char slug still resolves.
const LEGACY_ID_RE = /^[a-z0-9]{15}$/;

function isNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { status?: number }).status === 404);
}

const GAME_RESOLVE_OPTS = {
  expand: 'tags.tag_categories_via_tags,authors',
  fields: GAME_DETAIL_FIELDS,
};

// Public client first, authed only if public found nothing. Authed requests carry Authorization and
// Cloudflare won't cache them — on the site's hottest route that killed caching for every logged-in
// user. The second try only matters for records hidden from guests (a mod opening a hidden game).
async function publicFirst<T>(pub: () => Promise<T>, authed: () => Promise<T>): Promise<T> {
  try {
    return await pub();
  } catch (err) {
    if (!isNotFound(err) || !pb.authStore.isValid) throw err;
    return await authed();
  }
}

// Resolve a /game/:param segment (legacy id, current slug, retired slug) to the canonical Game.
// Throws (404) only when no tier matches.
export async function resolveGameByParam(param: string): Promise<Game> {
  if (LEGACY_ID_RE.test(param)) {
    try {
      return await publicFirst(
        () => gamesCollectionPublic.getOne<Game>(param, GAME_RESOLVE_OPTS),
        () => gamesCollection.getOne<Game>(param, GAME_RESOLVE_OPTS),
      );
    } catch (err) {
      if (!isNotFound(err)) throw err;  // real error, not an "id-shaped slug" — surface it
    // else: not a real id, fall through and try as slug
    }
  }
  const slugFilter = pbPublic.filter('slug = {:slug}', { slug: param });
  try {
    return await publicFirst(
      () => gamesCollectionPublic.getFirstListItem<Game>(slugFilter, GAME_RESOLVE_OPTS),
      () => gamesCollection.getFirstListItem<Game>(slugFilter, GAME_RESOLVE_OPTS),
    );
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  // Retired slug → alias → canonical game (one extra hop, stale links only).
  const alias = await gameSlugAliasesCollectionPublic.getFirstListItem<GameSlugAlias>(
    pbPublic.filter('slug = {:slug}', { slug: param }),
    { fields: 'game' },
  );
  return publicFirst(
    () => gamesCollectionPublic.getOne<Game>(alias.game, GAME_RESOLVE_OPTS),
    () => gamesCollection.getOne<Game>(alias.game, GAME_RESOLVE_OPTS),
  );
}

// Canonical URL key: slug when set, else record id (collisions/hidden games have no slug).
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
  // 'changelog' = the single pinned bump-log comment of a game (Go appends on bump, newest first).
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

// Cheat-companion build registry: EVERY build (public and private) is a row here; a public one also
// has a "showcase" comment in the thread (likes/replies/moderation for free), its id in `comment`.
// Drives the cheat gate, the "has build" catalog badge and "My builds". PB rules: owner-only on
// everything.
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
  | 'shout_mention' | 'shout_reply' | 'shout_dm';

export type Notification = RecordModel & {
  recipient: string;
  type: NotificationType;
  actor?: string;
  comment?: string;
  game?: string;
  // shout_reply/shout_mention/shout_dm: message id (shoutbox_messages) and its channel
  // (shoutbox_channels) — ChatView switches room and scrolls to it.
  shout_message?: string;
  shout_channel?: string;
  read: boolean;
} & {
  expand?: {
    actor?: User;
    game?: Game;
    comment?: Comment;
    // Room/thread where it happened — only for the name in the bell row ("replied in your thread
    // '…'"). Expand is optional: if channel rules don't allow it, the row falls back to generic
    // "replied to you in chat".
    shout_channel?: { id: string; title?: string; owner?: string };
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
  resolved_by?: string;  // set by Go on resolve, cleared on reopen
  resolved_at?: string;
} & {
  expand?: {
    comment?: Comment;
    game?: Game;
    requester?: User;
    assignee?: User;
    resolved_by?: User;
  };
};

export const modRequestsCollection = pb.collection('mod_requests') as RecordService<ModRequest>;

export type Author = RecordModel & {
  name: string;
  description: string;
  games: string[];
  aliases?: string;  // synonyms, newline-separated (see utils/fuzzy)
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
  relationship_type: 'Translation' | 'Expansion' | 'Sequel' | 'Interactive Port' | 'Static Port' | 'DLC' | 'Inspired By' | 'Version';
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
  // Moderator permissions (utils/modPerms.ts, mod_perms.go). Expanded key list — backend already
  // expanded "*". A moderator with no explicit perms gets all keys (legacy "isModerator =
  // everything").
  modPerms: [] as string[],
  // Does the current user have this moderator permission.
  hasModPerm: ((_key: string) => false) as (key: string) => boolean,
  blockedTags: [] as Tag[],
  // Ids of games the user hid from themselves (User.blocked_games); catalog/search filter by this
  // set client-side.
  blockedGameIds: [] as string[],
  // Blocked author ids (User.blocked_authors) — go into the catalog query filter (`authors.id !=
  // ...`) like blocked tags.
  blockedAuthorIds: [] as string[],
});

// Game ids the user has a build for (public or private): one id-only query on `builds`, app-wide,
// for the GameCard die badge. Kept OUT of the catalog payload on purpose: per-user state must never
// ride on anonymous cacheable lists.
export const MyBuiltGamesContext = createContext<Set<string>>(new Set());

// Global `tagId → categoryName` map, loaded once from `tag_categories` and shared app-wide;
// replaces the per-game `tags.tag_categories_via_tags` expand. Empty map = no category (chip uses
// neutral color).
export const TagCategoryContext = createContext<Map<string, string>>(new Map());