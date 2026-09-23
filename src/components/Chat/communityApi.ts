// User topics: /api/custom/shoutbox/community/*. Separate from shoutboxApi.ts for the same reason
// as server-side shoutbox_community.go: a lab feature, removable as a whole.

import { pb, pbPublic } from '../../pocketbase/pocketbase';
import {
  imageNameSize,
  nameWithSize,
  noteCommunityChannels,
  type ShoutMemberCard,
} from '../Shoutbox/shoutboxApi';
import type { CommunityTag } from './communityTags';
import type { ReactionMap } from '../Emoji/registry';
import { anonIdentity } from '../Shoutbox/anonIdentity';

export type CommunityRoom = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  // Owner id; names come in a separate `users` map. EMPTY for a masked topic: no author in the
  // record at all — identity is `anon_key` + `mask` (like a message).
  owner: string;
  anon?: boolean;
  anon_key?: string;
  mask?: string;
  // "My topic". Visible via owner for named topics; for anonymous ones only via this flag (the real
  // author is never exposed). Only from our server, absent in shared cached lists.
  mine?: boolean;
  tags: string[];
  created: number;
  msgs: number;
  last_at: number;
  likes: number;
  liked?: boolean;
  // OP lives on the room itself, not as the first feed message (a message can be deleted, displaced
  // by a pin or preceded by a reply).
  op_text?: string;
  // Filename of the FIRST OP image — kept for tabs opened before the list existed; new code reads
  // op_images.
  op_image?: string;
  // OP image filenames IN ORDER, up to five; positions marked `[img1]`…`[img5]` in text
  // (opImages/splitOpText).
  op_images?: string[];
  // Site pin: 0/absent = normal, >0 = pinned for everyone (higher = higher). Moderator-only.
  // Personal pins live separately.
  site_pin?: number;
  // Hidden by moderator. Present only where hidden topics are visible at all (/community/room,
  // /community/moderate for moderators).
  hidden?: boolean;
  // Top OP reactions (up to four, server-sorted), sent EVERYWHERE incl. lists. Short field names
  // (`n`/`c`/`m`) mirror shoutCommunityReact: 30 topics × 4 entries per page.
  op_top?: CommunityReact[];
  // Full OP reaction map (`{"fire": ["uid1",...]}`) — ONLY in single responses (/community/room,
  // /community/react); in lists it would cost ~100 ids per row for four numbers.
  op_reactions?: ReactionMap;
};

// Mirror of shoutCommunityTopReactsMax.
export const OP_TOP_REACTS_MAX = 4;

// Same top computation as the server (shoutCommunityTopReacts). Needed because realtime events
// arrive as RAW DB records bypassing our server. Order must match exactly (count desc, then name
// asc) or badges reshuffle on every foreign like.
export function topReacts(map: ReactionMap | undefined, meId: string): CommunityReact[] {
  if (!map) return [];
  const out: CommunityReact[] = [];
  for (const [n, uids] of Object.entries(map)) {
    if (!Array.isArray(uids) || uids.length === 0) continue;
    out.push({ n, c: uids.length, m: Boolean(meId) && uids.includes(meId) });
  }
  out.sort((a, b) => (b.c - a.c) || a.n.localeCompare(b.n));
  return out.slice(0, OP_TOP_REACTS_MAX);
}

export type CommunityReact = {
  n: string;
  c: number;
  m?: boolean;
};

// Mirror of shoutCommunityOpMax and op_text max.
export const OP_TEXT_MAX = 4000;
// Topic title longer than a room name: a question/thesis must fit; lists truncate via CSS anyway.
export const COMMUNITY_TITLE_MAX = 100;

// Mirror of shoutCommunityOpImagesMax and op_images maxSelect.
export const OP_IMAGES_MAX = 5;

// Sort: `new` (DEFAULT — show what the user hasn't seen), `active` (last activity in a week:
// creation or reply; old conversations with fresh replies return on purpose), `top` (likes over
// `CommunitySpan`).
export type CommunitySort = 'new' | 'active' | 'top';
export type CommunitySpan = 'week' | 'month' | 'year';

export type CommunityPage = {
  rooms: CommunityRoom[];
  page: number;
  per: number;
  total: number;
  // Distinguish "no response" (network, 5xx) from empty: both look like an empty screen and users
  // read network failure as "no topics".
  failed?: true;
};

// Client chosen by token: authed `pb` sends the header and gets `liked`; guest `pbPublic` doesn't
// send a stale token and doesn't hit 401 (see authedFetch track).
function client() {
  return pb.authStore.isValid ? pb : pbPublic;
}

// Owner cards from the last /community/list response, module-level (like memberCards in
// shoutboxApi).
let ownerCards: Record<string, ShoutMemberCard> = {};

// Topic signature (account name or anon mask) in ONE function for all three places (left strip,
// list row, thread header): anonymous topics have no owner, and each place deciding alone showed
// "someone" — losing exactly the signature the mask exists for. `card` only for named topics.
export function communityAuthor(room: { owner: string; anon?: boolean; anon_key?: string; mask?: string }): {
  name: string; color?: string; anon: boolean; card?: ShoutMemberCard;
} {
  if (room.anon || (!room.owner && room.anon_key)) {
    const id = anonIdentity(room.anon_key ?? '', room.mask);
    return { name: id.name, color: id.color, anon: true };
  }
  const card = ownerCards[room.owner];
  return { name: card?.name || (room.owner ? 'someone' : 'staff'), anon: false, card };
}

// Short list for the left column: shared and edge-cached, hence no `liked` and no NSFW filter (both
// personal; the component filters).
export async function fetchCommunitySide(bust?: string): Promise<CommunityRoom[]> {
  try {
    // `bust` = id of a just-created/removed topic. This response is shared and edge-cached for 15
    // s, so right after an event we'd get the list WITHOUT the new topic. Using the id as cache
    // key: identical for everyone who got the event, so one request reaches the server and the rest
    // hit cache again.
    const q = bust ? `?v=${encodeURIComponent(bust)}` : '';
    const res = await client().send(`/api/custom/shoutbox/community/side${q}`, { method: 'GET' });
    const rooms = (res?.rooms ?? []) as CommunityRoom[];
    noteCommunityChannels(rooms.map((r) => r.id));
    return rooms;
  } catch {
    return [];
  }
}

// Safety mode from the header toggle: in chat it controls blur and warnings but no longer excludes
// topics from the list.
export type CommunityRating = 'sfw' | 'all' | 'nsfw';

// Rating deliberately not sent to the server: in chat all topics are available in any mode; only
// media display changes.
export async function fetchCommunityList(opts: {
  page: number;
  per?: number;
  sort?: CommunitySort;
  span?: CommunitySpan;
  tag?: string;
  rating?: CommunityRating;
  // Title search; the server ignores < 2 chars.
  q?: string;
  mine?: boolean;
}): Promise<CommunityPage> {
  const q = new URLSearchParams({ page: String(opts.page) });
  if (opts.per) q.set('per', String(opts.per));
  if (opts.sort) q.set('sort', opts.sort);
  if (opts.span) q.set('span', opts.span);
  if (opts.tag) q.set('tag', opts.tag);
  if (opts.q?.trim()) q.set('q', opts.q.trim());
  if (opts.mine) q.set('mine', '1');
  try {
    const res = await client().send(`/api/custom/shoutbox/community/list?${q}`, { method: 'GET' });
    ownerCards = { ...ownerCards, ...((res?.users ?? {}) as Record<string, ShoutMemberCard>) };
    const rooms = (res?.rooms ?? []) as CommunityRoom[];
    noteCommunityChannels(rooms.map((r) => r.id));
    return {
      rooms,
      page: res?.page ?? opts.page,
      per: res?.per ?? opts.per ?? 30,
      total: res?.total ?? 0,
    };
  } catch {
    return { rooms: [], page: opts.page, per: opts.per ?? 30, total: 0, failed: true };
  }
}

// Personal block under the list: pins + "where you posted recently". No topic subscriptions on
// purpose (topics are fast and disposable; a subscription list needs manual cleanup) — instead an
// LRU of own replies derived by the server. Guests can't call it (RequireAuth; `signedIn` is a
// condition, not courtesy). Empty response → the screen draws a guest placeholder (the block can't
// vanish or layout jumps across devices/accounts).
export type CommunityMine = {
  pins: CommunityRoom[];
  recent: CommunityRoom[];
  // Bare ids of topics where this user posted (up to 30, newest first) — for the "I was here" mark;
  // only yes/no per id is needed.
  posted: string[];
};

export async function fetchCommunityMine(): Promise<CommunityMine> {
  try {
    const res = await client().send('/api/custom/shoutbox/community/mine', { method: 'GET' });
    const pins = (res?.pins ?? []) as CommunityRoom[];
    const recent = (res?.recent ?? []) as CommunityRoom[];
    const posted = (res?.posted ?? []) as string[];
    noteCommunityChannels([...pins, ...recent].map((r) => r.id));
    return { pins, recent, posted };
  } catch {
    return { pins: [], recent: [], posted: [] };
  }
}

// Topic index URL in ONE place: read by ChatPage, written by ChatView. Lives here, not in ChatPage,
// so ChatView doesn't import its own importer.
export const CHAT_THREADS_PATH = '/chat/threads';

// Mirror of shoutCommunityPinsMax (the overall pin cap is higher and counts DMs too; this one is
// for topics).
export const COMMUNITY_PINS_MAX = 10;

// Fallback to the old single field: topics created before the schema change store their image only
// there; without it their headers would go empty.
export function opImages(room: CommunityRoom): string[] {
  if (room.op_images && room.op_images.length) return room.op_images;
  return room.op_image ? [room.op_image] : [];
}

export function opImageUrlAt(room: CommunityRoom, i: number, thumb?: string): string | undefined {
  const name = opImages(room)[i];
  if (!name) return undefined;
  return pb.files.getURL(
    { id: room.id, collectionName: 'shoutbox_channels' } as never,
    name,
    thumb ? { thumb } : {},
  );
}

// Strip image markers and markup for one-or-two-line OP previews (collapsed header, list row).
// Markup is PARSED, not left raw ("[c=blue]…[/c]" read as a typo), and not rendered
// (`renderRichText`): the list row is clamped to two lines and fully clickable, and a spoiler is
// its own button that eats the click and reveals what the author hid. So: flat text, markers
// removed, content kept, spoilers replaced with a bar. Grammar mirrors `richText.inline`: color
// brackets first, then wrappers from long to short markers (else `**` splits into two `*`). Nesting
// via several passes (like the renderer's `depth`), not recursion; four suffice for previews.
export function stripOpTokens(text: string): string {
  let out = text.replace(/\[img[1-9][0-9]?\]/g, ' ');

  for (let pass = 0; pass < 4; pass += 1) {
    const before = out;
    out = out
      .replace(/\[c=[a-z]{3,9}\]([^[]*?)\[\/c\]/g, '$1')
      .replace(/\|\|([^\n]*?)\|\|/g, '▒▒▒')
      .replace(/\*\*([^\n]*?)\*\*/g, '$1')
      .replace(/~~([^\n]*?)~~/g, '$1')
      .replace(/\*([^\n]*?)\*/g, '$1')
      .replace(/_([^\n]*?)_/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1');
    if (out === before) break;
  }

  // Quote markers too: in a one-line preview "> " lands mid-sentence and reads as a stray arrow.
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');

  return out.replace(/[ \t]{2,}/g, ' ');
}

export type OpChunk = { text: string } | { img: number };

// Split OP into chunks by `[imgN]` markers. Positional (image number), not filename (filenames
// change on re-upload). Images without markers are appended at the end — otherwise an image
// uploaded without a marker (or from an old topic) would vanish while still in the record.
export function splitOpText(text: string, count: number): OpChunk[] {
  const out: OpChunk[] = [];
  const used = new Set<number>();
  let last = 0;
  const re = /\[img([1-9][0-9]?)\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= count || used.has(i)) continue;  // marker pointing nowhere — silently skipped
    const chunk = text.slice(last, m.index);
    if (chunk.trim()) out.push({ text: chunk });
    out.push({ img: i });
    used.add(i);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  if (tail.trim()) out.push({ text: tail });
  for (let i = 0; i < count; i += 1) {
    if (!used.has(i)) out.push({ img: i });
  }
  return out;
}

// OP image aspect from its filename so the header doesn't jump while it loads (same trick as
// message images).
export function opImageSize(room: CommunityRoom, i = 0): { w: number; h: number } | undefined {
  return imageNameSize(opImages(room)[i]);
}

export type OpImageSlot = { name: string } | { file: File };

// Create/edit request body. No images → plain JSON (the server accepts both, shoutCommunityReadOp).
// The image list is sent WHOLE (`op_images_set=1` + `op_order`), not add/remove edits: images are
// positioned by `[imgN]` markers, and partial edits diverge from the text on the first race between
// two tabs. In `op_order` a name = "keep that file", `*` = "next file from op_images_new".
async function opBody(input: {
  room?: string;
  title?: string;
  tags?: CommunityTag[];
  opText: string;
  images?: OpImageSlot[];
  // The list is authoritative. Without this flag "no images" and "remove all" are indistinguishable
  // — opposite intents.
  imagesSet?: boolean;
  anon?: boolean;
  mask?: string;
}): Promise<FormData | Record<string, unknown>> {
  const slots = input.images ?? [];
  const files = slots.filter((s): s is { file: File } => 'file' in s);
  const order = slots.map((s) => ('file' in s ? '*' : s.name));

  if (!files.length) {
    return {
      room: input.room ?? '',
      title: input.title ?? '',
      tags: input.tags ?? [],
      op_text: input.opText,
      op_order: order,
      op_images_set: Boolean(input.imagesSet),
      // Legacy field: without it a server whose schema lacks op_images wouldn't know the single
      // image was removed.
      drop_image: Boolean(input.imagesSet) && !order.length,
      anon: Boolean(input.anon),
      mask: input.mask ?? '',
    };
  }
  const fd = new FormData();
  if (input.room) fd.append('room', input.room);
  if (input.title) fd.append('title', input.title);
  for (const t of input.tags ?? []) fd.append('tags', t);
  fd.append('op_text', input.opText);
  for (const o of order) fd.append('op_order', o);
  if (input.imagesSet) fd.append('op_images_set', '1');
  if (input.anon) fd.append('anon', '1');
  if (input.mask) fd.append('mask', input.mask);
  // Sizes are encoded in the filename (nameWithSize in shoutboxApi). One field for all files: a
  // server without op_images in the schema takes the first one anyway (shoutCommunityApplyImages);
  // sending the same bytes twice for the transition period isn't worth it.
  for (const f of files) fd.append('op_images_new', await nameWithSize(f.file));
  return fd;
}

export async function createCommunityRoom(input: {
  title: string;
  opText?: string;
  tags: CommunityTag[];
  images?: OpImageSlot[];
  // Masked only at creation: a topic already read under the author's name can't be recolored.
  anon?: boolean;
  mask?: string;
}): Promise<CommunityRoom> {
  const res = await client().send('/api/custom/shoutbox/community/rooms', {
    method: 'POST',
    body: await opBody({
      title: input.title,
      tags: input.tags,
      opText: input.opText ?? '',
      images: input.images,
      imagesSet: true,
      anon: input.anon,
      mask: input.mask,
    }),
  });
  const room = res.room as CommunityRoom;
  noteCommunityChannels([room.id]);
  return room;
}

// OP edit. Title and tags untouched (the topic was found and remembered by them). `images` = the
// ENTIRE future list in order; whatever is missing is removed.
export async function updateCommunityOp(input: {
  room: string;
  opText: string;
  images: OpImageSlot[];
}): Promise<CommunityRoom> {
  const res = await pb.send('/api/custom/shoutbox/community/op', {
    method: 'POST',
    body: await opBody({
      room: input.room,
      opText: input.opText,
      images: input.images,
      imagesSet: true,
    }),
  });
  return res.room as CommunityRoom;
}

// Topic moderation (title, tags, hide) — not for the author (see updateCommunityOp); moderators fix
// bait titles or hide without deleting the conversation. Send only what changes: empty title/tags
// mean "don't touch" on the server; `hidden` is distinguished from "not sent".
export async function moderateCommunityRoom(input: {
  room: string;
  title?: string;
  tags?: CommunityTag[];
  hidden?: boolean;
  // Site pin weight > 0 = pin for all, 0 = unpin. The server enforces the cap and errors if the
  // field isn't in the schema.
  sitePin?: number;
}): Promise<CommunityRoom> {
  const body: Record<string, unknown> = { room: input.room };
  if (input.title !== undefined) body.title = input.title;
  if (input.tags !== undefined) body.tags = input.tags;
  if (input.hidden !== undefined) body.hidden = input.hidden;
  if (input.sitePin !== undefined) body.site_pin = input.sitePin;
  const res = await pb.send('/api/custom/shoutbox/community/moderate', {
    method: 'POST',
    body,
  });
  return res.room as CommunityRoom;
}

// Shared pins, visible to guests too (a showcase). `enabled: false` = site_pin field not in the
// schema yet: the screen then renders neither the block nor the moderation toggle, instead of a
// forever-empty list and a refusing handler.
export async function fetchCommunitySitePins(): Promise<{
  rooms: CommunityRoom[];
  enabled: boolean;
}> {
  try {
    // The response also answers "is the field in the schema" — cached in the module so the
    // moderation dialog doesn't ask again.
    const res = await client().send('/api/custom/shoutbox/community/pinned', { method: 'GET' });
    ownerCards = { ...ownerCards, ...((res?.users ?? {}) as Record<string, ShoutMemberCard>) };
    const rooms = (res?.rooms ?? []) as CommunityRoom[];
    noteCommunityChannels(rooms.filter((r) => r.owner || r.anon).map((r) => r.id));
    sitePinsReady = Boolean(res?.enabled);
    return { rooms, enabled: sitePinsReady };
  } catch {
    return { rooms: [], enabled: false };
  }
}

// Schema-applied flag; `null` = not asked yet. One answer for the whole site, unchanged until
// deploy.
let sitePinsReady: boolean | null = null;
export function communitySitePinsReady(): boolean | null {
  return sitePinsReady;
}

// One topic by id or slug — for direct links when the list isn't in memory yet. null = not a topic.
export async function fetchCommunityRoom(key: string): Promise<CommunityRoom | null> {
  if (!key) return null;
  try {
    const res = await client().send(
      `/api/custom/shoutbox/community/room?room=${encodeURIComponent(key)}`,
      { method: 'GET' },
    );
    ownerCards = { ...ownerCards, ...((res?.users ?? {}) as Record<string, ShoutMemberCard>) };
    const room = (res?.room ?? null) as CommunityRoom | null;
    // Only topics, not permanent rooms: `noteCommunityChannels` removes the channel from the
    // channel menu, and a room must stay there. The difference: a topic has an owner (see
    // shoutCommunityFindPublic).
    if (room?.owner || room?.anon) noteCommunityChannels([room.id]);
    return room;
  } catch {
    return null;
  }
}

// Like is a toggle: one button, one request; the server returns post-click state so the counter
// doesn't guess.
export async function toggleCommunityLike(roomId: string): Promise<{ likes: number; liked: boolean }> {
  const res = await pb.send('/api/custom/shoutbox/community/like', {
    method: 'POST',
    body: { room: roomId },
  });
  return { likes: res.likes ?? 0, liked: Boolean(res.liked) };
}

// OP reaction is a toggle too. NOT /shoutbox/react (that edits a message's map; the OP lives in
// room fields). Returns the full map and recomputed top — assembling them from "one more" is how
// two devices of the same person diverge.
export async function toggleCommunityOpReaction(
  roomId: string,
  emoji: string,
): Promise<{ reactions: ReactionMap; top: CommunityReact[] }> {
  const res = await pb.send('/api/custom/shoutbox/community/react', {
    method: 'POST',
    body: { room: roomId, emoji },
  });
  return {
    reactions: (res.op_reactions ?? {}) as ReactionMap,
    top: (res.op_top ?? []) as CommunityReact[],
  };
}

// Short "5 min ago": ~1.5 cm for the date in the list column; exact date goes to the row title.
export function agoLabel(unixSec: number): string {
  if (!unixSec) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}

// Own anon_key (same as for messages), set from ChatView after the ping. Needed only to recognize
// OWN anonymous topics in realtime (no owner in the record). Empty = not asked yet; then the
// server's `mine` decides.
let myAnonKey = '';
export function setCommunityAnonKey(key: string) {
  myAnonKey = key || '';
}

// Raw topic record from realtime (straight from the DB). No computed fields (`msgs`, `last_at`):
// they're derived from the messages table.
type CommunityRecord = {
  id?: string;
  slug?: string;
  title?: string;
  description?: string;
  owner?: string;
  // Anonymous author identity (same as anon messages). The real author (author_ref) is never in
  // realtime: the field is hidden in the schema, else anonymity would be a sham.
  anon_key?: string;
  anon_mask?: string;
  tags?: string[];
  created?: string;
  likers?: string[];
  op_text?: string;
  op_image?: string;
  op_images?: string[];
  site_pin?: number;
  enabled?: boolean;
  is_private?: boolean;
  is_dm?: boolean;
  // OP reactions pulled via realtime ON PURPOSE (lists only carry the top): the list row is patched
  // from this event, and without the map it would lose badges on every foreign like; foreign
  // reactions also appear instantly.
  op_reactions?: ReactionMap;
};

export type CommunityRoomEvent = {
  action: string;
  room: CommunityRoom;
};

// Explicit field list for the subscription: neither `members` of private rooms nor the Discord
// bridge fields must reach the browser.
const ROOM_FIELDS = 'id,slug,title,description,owner,anon_key,anon_mask,tags,created,likers,'
  + 'op_text,op_image,op_images,op_reactions,site_pin,enabled,is_private,is_dm';

// DB record → topic as the rest of the screen knows it. `msgs`/`last_at` set to 0
// (server-computed); the receiver must take them from the already drawn row.
function communityFromRecord(rec: CommunityRecord): CommunityRoom {
  const likers = rec.likers ?? [];
  const me = pb.authStore.isValid ? (pb.authStore.model?.id ?? '') : '';
  const images = rec.op_images ?? (rec.op_image ? [rec.op_image] : []);
  return {
    id: rec.id ?? '',
    slug: rec.slug ?? '',
    title: rec.title ?? '',
    description: rec.description,
    owner: rec.owner ?? '',
    anon: !rec.owner && Boolean(rec.anon_key),
    anon_key: rec.anon_key,
    mask: rec.anon_mask,
    // Mine: by owner for named, by the same key people recognize their messages with (from the
    // ping) for anonymous.
    mine: (Boolean(me) && rec.owner === me)
      || (Boolean(rec.anon_key) && rec.anon_key === myAnonKey),
    tags: rec.tags ?? [],
    created: rec.created ? Math.floor(new Date(rec.created.replace(' ', 'T')).getTime() / 1000) : 0,
    msgs: 0,
    last_at: 0,
    likes: likers.length,
    liked: Boolean(me) && likers.includes(me),
    op_text: rec.op_text,
    op_image: images[0],
    op_images: images,
    op_top: topReacts(rec.op_reactions, me),
    // The map goes here too even though lists don't draw it: the event also patches the OPEN topic,
    // whose reaction row uses the map. Without it a foreign like arrived without op_reactions and
    // zeroed the row.
    op_reactions: rec.op_reactions ?? {},
    site_pin: rec.site_pin ?? 0,
    hidden: !rec.enabled,
  };
}

// Live topics without polling: subscription directly on the channels collection, bypassing our
// server. Nothing new needed: the access rule `is_private = false || members.id ?=
// @request.auth.id` has existed since the collection was created, and DMs/private rooms are created
// with `is_private = true`, so nothing foreign arrives. Author's permanent rooms (#general etc.)
// are filtered here: empty `owner`, while a topic always has one.
export async function subscribeCommunityRooms(
  onEvent: (e: CommunityRoomEvent) => void,
): Promise<() => void> {
  return pb.collection('shoutbox_channels').subscribe<CommunityRecord>(
    '*',
    (e) => {
      const rec = e.record;
      // A topic has an author: open (owner) or hidden (then anon_key). Permanent rooms have neither
      // — excluded.
      if (!rec?.id || (!rec.owner && !rec.anon_key) || rec.is_private || rec.is_dm) return;
      if (e.action === 'create') noteCommunityChannels([rec.id]);
      onEvent({ action: e.action, room: communityFromRecord(rec) });
    },
    { fields: ROOM_FIELDS },
  );
}
