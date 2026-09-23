import { applyAttention, attentionRevision, pendingAttentionReads, acknowledgeAttentionReads, type AttentionSummary } from '../Notifications/chatAttention';

// Shoutbox API. Reads: standard PB list + realtime subscription (public listRule; payload trimmed
// by fields whitelist — payload discipline). Writes/moderation/presence: only Go endpoints
// /api/custom/shoutbox/*.
import { pb, pbPublic } from '../../pocketbase/pocketbase';
import { PING_KEY, claimShared, writeShared, type SharedPing } from './tabLeader';
import {
  chatAliasOf, loadChatNotes, applyChatNote, applyChatPins, currentChatPins, type ChatNote,
} from './chatNotes';
import type { ReactionMap } from '../Emoji/registry';
import { anonMask } from './anonMask';

export type ShoutGameRef = { id: string; title: string; author: string };
export type ShoutEvent =
  | { type: 'new_game'; games: ShoutGameRef[] }
  | { type: 'announcement'; title: string };

// Denormalized parent snapshot for reply quotes (written by the backend).
export type ShoutReply = {
  id: string; name: string; anon_key: string; text: string;
  // Parent author frozen in the snapshot with the name — shows the reply was to ME even when the
  // parent left the feed window. Empty for messages predating the field (fallback: search the
  // window) and for anonymous parents (their signature is `anon_key`).
  user?: string;
  // Anonymous mask at reply time, frozen with the snapshot — otherwise a mask change would
  // retroactively re-sign all old quotes.
  anon_mask?: string;
};

export type { ReactionMap };

export type ShoutMessage = {
  id: string;
  text: string;
  user: string;
  anon_key: string;
  // Chosen anonymous signature without "Anon" (anonMask.ts). Empty for older messages and people
  // who never set one: then derived from anon_key the old way.
  anon_mask?: string;
  kind: 'user' | 'system';
  event: ShoutEvent | null;
  reply: ShoutReply | null;
  created: string;
  // v2 channel id. Empty for old and system messages.
  channel?: string;
  // Pinned by a moderator: hangs as a strip above its room's feed.
  pinned?: boolean;
  // Author edited after sending. Own field, not updated≠created (as comments do): `updated` also
  // changes on pin, and the feed would mark untouched messages "edited".
  edited?: boolean;
  // v2 image filename (empty = plain text message).
  image?: string;
  // Reactions: emoji name → ids of reactors. Stored in the record, not a separate collection: count
  // and "mine" are needed per feed message, and a collection would mean dozens of requests per
  // load. Updates also arrive via the same realtime subscription as text edits.
  reactions?: ReactionMap;
  expand?: { user?: { id: string; name: string; username?: string; avatar: string; isModerator?: boolean } };
};

export type MentionUser = { id: string; name: string; username: string; avatar: string };

const COL = 'shoutbox_messages';
const FIELDS =
  'id,text,user,anon_key,anon_mask,kind,event,reply,created,channel,pinned,edited,image,reactions,' +
  'expand.user.id,expand.user.name,expand.user.username,expand.user.avatar,expand.user.isModerator';

export const SHOUT_PAGE = 50;

// Avatar URL for the light expand user object. No collectionName (trimmed by the fields whitelist),
// so build the users-collection URL by hand. undefined → anon/no avatar, draw initial.
export function avatarUrlOf(u?: { id: string; avatar?: string }): string | undefined {
  if (!u?.avatar) return undefined;
  return pb.files.getURL({ id: u.id, collectionName: 'users' } as never, u.avatar, { thumb: '100x100' });
}

// Message page, old → new. Without `before` — newest; with `before` (a message's created) — the
// page older than it (history scroll-up). Fewer than SHOUT_PAGE = no more.
export async function fetchMessages(
  before?: string,
  channelId?: string,
  // Only the default (first) channel gets channel-less old messages: they predate rooms and belong
  // to the general hall. They used to show in EVERY room — all pre-channel history surfaced in
  // suggestions.
  withLegacy = false,
): Promise<ShoutMessage[]> {
  return fetchPage({ before, channelId, withLegacy });
}

// Read back an acknowledged send independently of realtime delivery.
export async function fetchMessage(id: string): Promise<ShoutMessage> {
  const client = pb.authStore.isValid ? pb : pbPublic;
  return client.collection(COL).getOne<ShoutMessage>(id, {
    expand: 'user', fields: FIELDS, requestKey: null,
  });
}

// Page NEWER than the cursor, old → new. For the memory window: after scrolling far into history
// the feed detaches from the live tail and returns downward by pages, not a full reload.
export async function fetchNewer(
  after: string,
  channelId?: string,
  withLegacy = false,
): Promise<ShoutMessage[]> {
  return fetchPage({ after, channelId, withLegacy });
}

// "Which rooms this screen shows" filter pieces, shared by feed and pin list — they must not
// diverge (a pin from a room absent from the feed has nothing to show).
function channelScope(
  client: typeof pb,
  channelId?: string,
  withLegacy = false,
): string[] {
  // Separate-channels mode: only our channel. System events (new games, announcements) are stored
  // without channel, so they hit the same `channel = ""` condition as pre-channel history — ONLY in
  // the default room. They used to go everywhere (`kind = "system"` in the filter) and a themed
  // thread drowned in new-game posts.
  if (channelId) {
    return [client.filter(
      withLegacy ? '(channel = {:ch} || channel = "")' : 'channel = {:ch}',
      { ch: channelId },
    )];
  }
  // The merged feed is the SHARED hall; private content doesn't belong there. Without this the read
  // rule worked against us: it lets me into my own private rooms, and DMs spilled into the
  // home-page feed visible over the shoulder. Guests don't need it (the rule returns nothing
  // private anyway) and an extra filter piece would change the shared cacheable URL. `channel.owner
  // = ""` excludes user topics (thousands, created by people) — needed for guests too, so outside
  // the "logged in" branch; the guest URL remains shared and edge-cached. An anonymous topic has an
  // empty owner (author hidden) and is indistinguishable from a room by owner alone — hence the
  // second condition. Added ONLY when the server said the fields exist (ping, anon_threads): PB
  // rejects filters on nonexistent fields entirely — an empty feed rather than an extra topic.
  const notCommunity = anonThreadsReady
    ? 'channel.owner = "" && channel.anon_key = ""'
    : 'channel.owner = ""';
  return pb.authStore.isValid
    ? [`(channel = "" || (channel.is_private = false && ${notCommunity}))`]
    : [`(channel = "" || ${notCommunity})`];
}

async function fetchPage(opts: {
  before?: string;
  after?: string;
  channelId?: string;
  withLegacy?: boolean;
}): Promise<ShoutMessage[]> {
  const { before, after, channelId, withLegacy = false } = opts;
  // Guests read with the anonymous client (shared response, edge-cached); logged-in users with
  // their own: the collection read rule admits private rooms by membership, visible only via token.
  // The feed used to always go anonymous, so even DM participants couldn't read their DM.
  const client = pb.authStore.isValid ? pb : pbPublic;
  const parts: string[] = [];
  if (before) parts.push(client.filter('created < {:before}', { before }));
  if (after) parts.push(client.filter('created > {:after}', { after }));
  parts.push(...channelScope(client, channelId, withLegacy));
  // Walk outward from the cursor: up = newest of the older, down = oldest of the newer, so sort
  // direction depends on side; the feed always gets old → new.
  const res = await client.collection(COL).getList<ShoutMessage>(1, SHOUT_PAGE, {
    sort: after ? 'created' : '-created',
    filter: parts.join(' && '),
    expand: 'user',
    fields: FIELDS,
    requestKey: null,
  });
  return after ? res.items : res.items.reverse();
}

// Does this record belong in the current feed — same rules as the fetchMessages filter for one
// record. One realtime subscription covers the whole collection; messages from other rooms must be
// filtered here, or standing in suggestions you see fresh general messages fall in.
export function messageInChannel(m: ShoutMessage, channelId?: string, withLegacy = false): boolean {
  // Merged feed = everything EXCEPT private (same exclusion as fetchPage). The filter only fixes
  // the initial load; a live message from my own DM arrives via subscription and would land in the
  // shared feed on my home page.
  if (!channelId) return !isPrivateChannel(m.channel) && !isCommunityChannel(m.channel);
  if (m.channel === channelId) return true;
  // System (no channel) like pre-channel history: default room only.
  return withLegacy && !m.channel;
}

// Realtime only while the drawer is open; the returned callback closes the subscription.
export async function subscribeMessages(
  onEvent: (action: string, record: ShoutMessage) => void,
): Promise<() => void> {
  return pb.collection(COL).subscribe<ShoutMessage>(
    '*',
    (e) => onEvent(e.action, e.record),
    { expand: 'user', fields: FIELDS },
  );
}

export async function postMessage(text: string, replyTo?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox', {
    method: 'POST',
    body: replyTo ? { text, reply_to: replyTo } : { text },
  });
}

// v2: channels, anon toggle, delete password, images, who's here. Spec:
// wiki/components/shoutbox-v2-spec.md
export type ShoutChannel = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  is_private?: boolean;
  // DM: a private channel for exactly two, titled by the peer's name — the record holds a "Direct
  // message" placeholder.
  is_dm?: boolean;
  // Private room owner; empty for public rooms and DMs.
  owner?: string;
  // Private channel member ids; not sent for public ones.
  members?: string[];
  // User topic (shoutbox_community.go). NEVER comes from /channels — the topics section
  // (/chat/threads) sets this flag when mixing topics into the room list, so the rest of the
  // machinery (feed, composer, header, realtime) works unchanged and the left list knows where to
  // put them.
  community?: boolean;
  tags?: string[];
  // "My topic" — only for anonymous topics: no author in the record (owner empty), no other way to
  // recognize one's own.
  mine?: boolean;
};

// Private channel member cards come with the channel list — without them DMs can't be titled (the
// channel holds only ids).
export type ShoutMemberCard = { id: string; name: string; avatar?: string };

// "Who's here" member: only those whose ping came with visible. The chat screen sets it for
// logged-in users itself (2026-08-04): the list exists to DM people and is useless empty. Hidden
// users count in the total but give no card; guests and header pings never send visible.
export type ShoutWho = { id: string; name: string; avatar?: string; mod?: boolean };

export type ShoutPostOptions = {
  replyTo?: string;
  // Channel slug; empty = default (first public).
  channel?: string;
  // Post anonymously while logged in.
  anon?: boolean;
  // Password to delete this message later from any device.
  delPass?: string;
  // Image, ≤8 MB, logged-in only.
  image?: File | null;
};

// The room list changes monthly but is requested on every chat open, and the header stays empty
// until the response. Keep the last response in the module: reopening draws rooms immediately.
// Cache keyed by caller identity: private rooms differ per user; after login/logout the list must
// be refetched.
const CHANNELS_TTL_MS = 5 * 60_000;
let channelsCache: { at: number; who: string; list: ShoutChannel[] } | null = null;

let memberCards: Record<string, ShoutMemberCard> = {};

// Last message time per channel (unix seconds) from the same response, so DMs sort by recency. The
// channel has no "last written" field and shouldn't — it's a counter, not a room property.
let channelLast: Record<string, number> = {};

export function channelLastAt(id: string): number {
  return channelLast[id] ?? 0;
}

export function memberCard(id: string): ShoutMemberCard | undefined {
  return memberCards[id];
}

// Private channel ids from the last /channels response — the merged feed filters foreign content by
// them. A Set: queried per live message.
let privateIds = new Set<string>();

// Unknown id is treated as PUBLIC on purpose: private rooms come in the same response as public
// ones, so "unknown" means "list not fetched yet", and the reverse would blank the whole feed until
// then. The read rule still won't return anything foreign.
export function isPrivateChannel(id?: string): boolean {
  return Boolean(id) && privateIds.has(id as string);
}

// User topic ids seen by the frontend (communityApi fills them from every list response). The
// merged feed is the author's shared hall; user topics don't merge into it, or one chatty thread
// drowns all pinned rooms. The query excludes them too (`channel.owner = ""`), but live messages
// bypass the query via subscription — second line of defense.
let communityIds = new Set<string>();

// Max topics named in a ping. Mirror of shoutWatchMax on the server and must STAY a mirror: the
// server cap was raised to 48 (column + full index page) while this stayed at 20 — some shown
// topics stayed silent about new messages and the frontend read silence as "nothing there".
export const PING_WATCH_MAX = 48;

export function noteCommunityChannels(ids: string[]) {
  if (ids.length === 0) return;
  // Copy, not mutation: memoized feed rows read the set.
  const next = new Set(communityIds);
  ids.forEach((id) => next.add(id));
  communityIds = next;
}

// Is the anonymous-topics schema applied on the server? Arrives with the ping; assume no until then
// — an extra topic in the feed for a few seconds beats a rejected request.
let anonThreadsReady = false;

export function isCommunityChannel(id?: string): boolean {
  return Boolean(id) && communityIds.has(id as string);
}

export function dmPeer(ch: ShoutChannel, meId?: string): string {
  if (!ch.is_dm) return '';
  return (ch.members ?? []).find((id) => id !== meId) ?? '';
}

// Menu title: for DMs the peer's name (the record holds a placeholder because names change).
// Assigned name (note) beats the real one.
export function channelTitle(ch: ShoutChannel, meId?: string): string {
  if (!ch.is_dm) return ch.title;
  const peer = dmPeer(ch, meId);
  return chatAliasOf(peer) || (peer && memberCards[peer]?.name) || 'Direct message';
}

export type ShoutUserState = {
  notes?: Record<string, ChatNote>;
  pins?: string[];
  // channel id → read-until time (unix seconds) on other devices.
  reads?: Record<string, number>;
};

// Read marks from the last /channels response; ChatView merges them with local ones on open.
let serverReads: Record<string, number> = {};

export function readMarks(): Record<string, number> {
  return serverReads;
}

// Channels available to the caller; the server filters private ones. `force` bypasses the cache
// (e.g. after joining a private room).
export async function fetchChannels(force = false): Promise<ShoutChannel[]> {
  const who = pb.authStore.record?.id ?? '';
  if (!force && channelsCache
    && channelsCache.who === who
    && Date.now() - channelsCache.at < CHANNELS_TTL_MS) {
    return channelsCache.list;
  }
  try {
    const res = await pb.send('/api/custom/shoutbox/channels', { method: 'GET' });
    const list = (res?.channels ?? []) as ShoutChannel[];
    memberCards = (res?.users ?? {}) as Record<string, ShoutMemberCard>;
    channelLast = (res?.last ?? {}) as Record<string, number>;
    privateIds = new Set(list.filter((c) => c.is_private).map((c) => c.id));
    // Personal state (notes, pins, read marks) rides the same response. Guests don't get it — then
    // clear, or after logout the previous user's names stay on screen.
    const st = (res?.state ?? {}) as ShoutUserState;
    loadChatNotes(st);
    serverReads = st.reads ?? {};
    channelsCache = { at: Date.now(), who, list };
    return list;
  } catch {
    // Network failed — show the previous list rather than an empty header.
    return channelsCache?.who === who ? channelsCache.list : [];
  }
}

// Image dimensions go INTO THE FILENAME: `640x480.jpg` is stored by PocketBase as
// `640x480_a1b2c3.jpg`, so every feed reader knows the proportions from the name alone before the
// image loads. Not separate fields because the prod schema isn't touched, and without sizes the
// feed jerked (messages appeared empty and grew a second later). The filename already rides in the
// feed (`image`): zero extra bytes and requests. Cost: the original filename is lost (never shown
// in chat; PB appended a suffix on download anyway).
export async function nameWithSize(file: File): Promise<File> {
  const size = await measureImage(file);
  if (!size) return file;
  const dot = file.name.lastIndexOf('.');
  const ext = dot > 0 ? file.name.slice(dot) : '';
  return new File([file], `${size.w}x${size.h}${ext}`, { type: file.type });
}

// Natural dimensions; null = not an image or broken → send without sizes.
function measureImage(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (v: { w: number; h: number } | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    img.onload = () => done({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => done(null);
    img.src = url;
  });
}

// Dimensions from the filename (`640x480_a1b2c3.jpg`), separate from messages: topic OP images use
// the same naming and parser.
export function imageNameSize(name?: string): { w: number; h: number } | undefined {
  const mt = /^(\d{1,5})x(\d{1,5})[_.]/.exec(name || '');
  if (!mt) return undefined;
  const w = Number(mt[1]);
  const h = Number(mt[2]);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

// Message image size if encoded; old messages have none and the feed adapts on load.
export function messageImageSize(m: ShoutMessage): { w: number; h: number } | undefined {
  return imageNameSize(m.image);
}

// Own just-sent image is already in tab memory: waiting for it to come back through R2 and
// Cloudflare (plus PocketBase generating a thumbnail on first request) is a second of empty space.
// Keep the last few; blob URLs must be revoked manually or memory grows per sent image.
const localImages = new Map<string, string>();
const LOCAL_IMAGES_MAX = 8;

function rememberLocalImage(id: string, file: File): void {
  if (!id) return;
  localImages.set(id, URL.createObjectURL(file));
  while (localImages.size > LOCAL_IMAGES_MAX) {
    const oldest = localImages.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    URL.revokeObjectURL(localImages.get(oldest)!);
    localImages.delete(oldest);
  }
}

export function localImageUrl(id: string): string | undefined {
  return localImages.get(id);
}

// Send v2: multipart with an image, plain JSON without. Returns the created message id to bind the
// guest delete password immediately. Empty string = the server dropped the send as a duplicate
// (double Enter): no record, nothing to bind.
export async function postMessageV2(text: string, opts: ShoutPostOptions = {}): Promise<string> {
  const { replyTo, channel, anon, delPass, image } = opts;
  const mask = anonMask();
  let res: { id?: string; duplicate?: boolean };

  if (!image) {
    const body: Record<string, unknown> = { text };
    if (replyTo) body.reply_to = replyTo;
    if (channel) body.channel = channel;
    if (anon) body.anon = true;
    // Mask is always sent, not only with `anon`: one is anonymous simply by not being logged in.
    // The server decides — it checks whether the record kept an author and silently drops the mask
    // on named messages.
    if (mask) body.mask = mask;
    if (delPass) body.del_pass = delPass;
    res = await pb.send('/api/custom/shoutbox', { method: 'POST', body });
  } else {
    const fd = new FormData();
    fd.append('text', text);
    if (replyTo) fd.append('reply_to', replyTo);
    if (channel) fd.append('channel', channel);
    if (anon) fd.append('anon', '1');
    if (mask) fd.append('mask', mask);
    if (delPass) fd.append('del_pass', delPass);
    fd.append('image', await nameWithSize(image));
    res = await pb.send('/api/custom/shoutbox', { method: 'POST', body: fd });
    if (res?.id) rememberLocalImage(res.id, image);
  }
  return res?.id ?? '';
}

// Delete OWN message by account authorship or random secret. The server deliberately answers the
// same 403 for "not yours" and "wrong password".
export async function deleteOwnMessage(id: string, delPass?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/delete-own', {
    method: 'POST',
    body: delPass ? { id, del_pass: delPass } : { id },
  });
}

// Who's not listed: anonymous guests, hidden accounts and, when present users exceed the list cap,
// the truncated tail. The last is normally zero but must not be silent: silent truncation looked
// like "chat doesn't see half the people". Old binaries don't send the field → 0.
export type ShoutRest = { guests: number; hidden: number; cut: number };

// Online count + visible list + breakdown of the rest. Called ONCE when the members panel appears;
// afterwards the list rides the ping (`roster`), no own polling.
export async function fetchWho(): Promise<{ online: number; who: ShoutWho[] } & ShoutRest> {
  try {
    const res = await pb.send('/api/custom/shoutbox/who', { method: 'GET' });
    return {
      online: res?.online ?? 0,
      who: (res?.who ?? []) as ShoutWho[],
      guests: res?.guests ?? 0,
      hidden: res?.hidden ?? 0,
      cut: res?.cut ?? 0,
    };
  } catch {
    return { online: 0, who: [], guests: 0, hidden: 0, cut: 0 };
  }
}

// Message image URL: thumb '360x0' for the feed, none for full view.
export function messageImageUrl(m: ShoutMessage, thumb?: string): string | undefined {
  if (!m.image) return undefined;
  return pb.files.getURL(
    { id: m.id, collectionName: COL } as never,
    m.image,
    thumb ? { thumb } : {},
  );
}

// @mention suggestion cache per session: people type and backspace, returning to already asked
// prefixes ("@dr" → "@dra" → "@dr" = three identical requests); debounce doesn't help.
const MENTION_CACHE = new Map<string, MentionUser[]>();
const MENTION_CACHE_MAX = 100;

export async function searchMentionUsers(q: string): Promise<MentionUser[]> {
  const key = q.trim().toLowerCase();
  if (!key) return [];
  const hit = MENTION_CACHE.get(key);
  if (hit) return hit;
  try {
    const res = await pb.send(`/api/custom/shoutbox/users?q=${encodeURIComponent(q)}`, { method: 'GET' });
    const users = (res?.users ?? []) as MentionUser[];
    if (MENTION_CACHE.size >= MENTION_CACHE_MAX) MENTION_CACHE.clear();
    MENTION_CACHE.set(key, users);
    return users;
  } catch {
    return [];  // don't cache errors: the next letter must retry
  }
}

export async function deleteMessage(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/delete', { method: 'POST', body: { id } });
}

// Profile card fields: site profiles are sparse for now; the card is the future home for favorite
// games and builds.
export type ShoutProfile = {
  id: string;
  name?: string;
  username?: string;
  avatar?: string;
  created: string;
  isModerator?: boolean;
};

// Edit own message; image untouched (replacing it is effectively another message — delete and
// resend).
export async function editOwnMessage(id: string, text: string, delPass?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/edit', {
    method: 'POST',
    body: delPass ? { id, text, del_pass: delPass } : { id, text },
  });
}

// Reaction toggle; the server counts and rewrites the whole record, so it returns the full map, not
// a delta.
export async function reactToMessage(id: string, emoji: string): Promise<ReactionMap> {
  const res = await pb.send('/api/custom/shoutbox/react', {
    method: 'POST',
    body: { id, emoji },
  }) as { reactions?: ReactionMap };
  return res?.reactions ?? {};
}

// Pin/unpin (moderator): pinned messages hang above their room.
export async function pinMessage(id: string, pinned: boolean): Promise<void> {
  await pb.send('/api/custom/shoutbox/pin', { method: 'POST', body: { id, pinned } });
}

// Pins kept in view: there are only a few; the list is "what's pinned here", not history.
export const PINS_MAX = 30;

// Pins of visible rooms, newest first, via a separate request, not from the feed: pins are almost
// always older than the memory window — otherwise the strip would be empty exactly when needed, in
// an old conversation.
export async function fetchPinned(
  channelId?: string,
  withLegacy = false,
): Promise<ShoutMessage[]> {
  const client = pb.authStore.isValid ? pb : pbPublic;
  const parts = ['pinned = true', ...channelScope(client, channelId, withLegacy)];
  const res = await client.collection(COL).getList<ShoutMessage>(1, PINS_MAX, {
    sort: '-created',
    filter: parts.join(' && '),
    expand: 'user',
    fields: FIELDS,
    requestKey: null,
  });
  return res.items;
}

// Profile for the name-click card fetched SEPARATELY and only on click: adding these fields to the
// feed would cost every reader on every message for a rare click.
export async function fetchProfile(id: string): Promise<ShoutProfile | null> {
  try {
    const r = await pb.collection('users').getOne(id, {
      fields: 'id,name,username,avatar,created,isModerator',
    });
    return r as unknown as ShoutProfile;
  } catch {
    return null;
  }
}

export async function muteMessageSource(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/mute', { method: 'POST', body: { id } });
}

export async function unmuteMessageSource(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/unmute', { method: 'POST', body: { id } });
}

// Ping options, all optional: an empty ping = "I'm on the site", as sent by the header icon.
export type PingOpts = {
  // Ping from OPEN chat: the server also returns room highlights. Not requested from the header —
  // that response goes from every page of every visitor; each extra byte multiplies by site
  // traffic.
  chat?: boolean;
  // Room being read right now: mentions in it are cleared.
  channel?: string;
  // Members panel on screen → send the list as ping payload. No own polling: on wide screens the
  // panel is always open and a 30 s poll would double chat traffic per user.
  roster?: boolean;
  // THIS device's push subscription endpoint: the server learns chat is being watched here and
  // won't wake this device with a push. Send ONLY from open chat — from the header it would mean
  // "I'm in chat" for someone browsing the catalog, and they'd stop getting notifications entirely.
  endpoint?: string;
  // Per-room read marks (unix seconds) as ping payload. No separate "sync read" request on purpose
  // (it would cost as much as the rest of chat). The server only moves marks forward and writes the
  // DB only when they grew.
  seen?: Record<string, number>;
  // User topics currently on screen: the server returns highlights for them too. The frontend sends
  // exactly what's on screen: rooms are a dozen and all come at once, but topics are thousands —
  // "all at once" would be a megabyte per ping per tab. Nothing beyond the horizon (page 2,
  // yesterday's topics), so the ping costs the same however many topics exist. Cap 20; the server
  // silently truncates extras.
  watch?: string[];
};

export type PingResult = {
  online: number;
  // Own anon_key — to show anons their own pseudonym.
  anonKey: string;
  // Does the server support anonymous topics (schema fields)? The ping response sets the flag
  // above.
  anonThreads: boolean;
  // Server read mark: "read on laptop → cleared on phone".
  lastSeen: string;
  channels: Record<string, number>;
  mentions: string[];
  // New message counts in topics watched by the topic screen: id → number. Computed by the server
  // (rooms are counted by the browser from the pulse, but topics aren't in the pulse). Never-opened
  // topics are excluded (no mark to count from). Cap 50.
  newCounts: Record<string, number>;
  // Member list only with `roster`. `undefined` = not asked.
  who?: ShoutWho[];
  rest?: ShoutRest;
  // Who's in the OPEN topic/room, only with `roster` and `channel`. `undefined` = not asked, [] =
  // asked and nobody — so the screen doesn't blank a shown list for nothing.
  here?: ShoutWho[];
  hereMore?: number;
  // Read marks from OTHER devices, only when they read further than us; otherwise the server stays
  // silent.
  reads?: Record<string, number>;
};

// The presence ping is the ONLY place calling `/ping`. There used to be two (header icon for
// presence, chat screen for highlights), unaware of each other — on the chat page two equivalent
// requests in a row. Now any ping marks the shared cross-tab `PING_KEY`, and the header icon skips
// its own when the mark is fresh. The merge relies on the fact "this browser already reported", not
// on anyone knowing about chat.
export async function pingPresence(opts: PingOpts = {}): Promise<PingResult> {
  // Claim BEFORE the request, synchronously: while the ping flies there's no mark yet and a sibling
  // tab left with a second one. On failure roll back, or the browser goes silent for the whole
  // interval over one network blip.
  const rollback = claimShared(PING_KEY);
  const q = new URLSearchParams();
  if (opts.chat) q.set('chat', '1');
  if (opts.channel) q.set('ch', opts.channel);
  if (opts.roster) q.set('roster', '1');
  const attentionSync = opts.chat && opts.seen !== undefined;
  if (attentionSync) q.set('attention', '1');
  const qs = q.toString();

  let res: {
    online?: number; anon_key?: string; anon_threads?: boolean; last_seen?: string;
    channels?: Record<string, number>; mentions?: string[];
    new?: Record<string, number>;
    who?: ShoutWho[]; guests?: number; hidden?: number; cut?: number;
    here?: ShoutWho[]; here_more?: number;
    reads?: Record<string, number>;
    attention?: AttentionSummary;
    read_ack?: boolean;
  };
  const version = attentionRevision();
  const attentionUser = pb.authStore.record?.id;
  const readMessages = attentionSync && attentionUser ? pendingAttentionReads() : {};
  const body: {
    read_messages?: Record<string, string>;
    endpoint?: string;
    seen?: Record<string, number>;
    watch?: string[];
  } = {};
  if (Object.keys(readMessages).length) body.read_messages = readMessages;
  if (opts.endpoint) body.endpoint = opts.endpoint;
  // Trim here, not only on the server: don't ship what the other side drops.
  if (opts.watch?.length) body.watch = opts.watch.slice(0, PING_WATCH_MAX);
  // Don't send an empty map: the header ping goes from every page and an extra key multiplies by
  // all traffic.
  if (opts.seen && Object.keys(opts.seen).length) body.seen = Object.fromEntries(Object.entries(opts.seen).map(([id, at]) => [id, Math.floor(at)]));
  try {
    res = await pb.send(`/api/custom/shoutbox/ping${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      body,
    });
  } catch (e) {
    rollback();
    throw e;
  }

  const out: PingResult = {
    online: res?.online ?? 0,
    anonKey: res?.anon_key ?? '',
    anonThreads: Boolean(res?.anon_threads),
    lastSeen: res?.last_seen ?? '',
    channels: (res?.channels ?? {}) as Record<string, number>,
    mentions: (res?.mentions ?? []) as string[],
    newCounts: (res?.new ?? {}) as Record<string, number>,
    // No list when not requested — NOT the same as "nobody here": undefined means "not asked" and
    // the screen keeps the previous one.
    who: res?.who,
    rest: res?.guests === undefined
      ? undefined
      : { guests: res.guests, hidden: res.hidden ?? 0, cut: res.cut ?? 0 },
    here: res?.here,
    hereMore: res?.here_more,
    reads: res?.reads,
  };
  if (res.attention && attentionUser === pb.authStore.record?.id) {
    applyAttention(res.attention, version);
    if (res.read_ack) acknowledgeAttentionReads(readMessages);
  }
  if (out.anonThreads) anonThreadsReady = true;
  if (out.reads) serverReads = { ...serverReads, ...out.reads };
  writeShared(PING_KEY, {
    uid: pb.authStore.record?.id ?? '',
    anonKey: out.anonKey,
    lastSeen: out.lastSeen,
  } satisfies SharedPing);
  return out;
}

// "Pulse": the only request of a page with chat closed.
// Last message times per public channel (unix seconds, newest first) + online count. Key "" =
// channel-less messages.
export type ShoutPulse = { online: number; t: Record<string, number[]> };

// Read the pulse with a BARE fetch without any auth header — on purpose: the response is identical
// for everyone and only anonymous requests are served from the Cloudflare edge cache. Sending a
// token would route every logged-in user to our server for the same numbers.
export async function fetchPulse(): Promise<ShoutPulse | 'disabled' | null> {
  try {
    const res = await fetch('/api/custom/shoutbox/pulse', { credentials: 'omit' });
    // A disabled feature flag is indistinguishable from a nonexistent route — 404 for the whole
    // /shoutbox group. We learn it here instead of spending a separate (uncacheable!) request on
    // the flag: the pulse is the first thing the page does anyway.
    if (res.status === 404) return 'disabled';
    if (!res.ok) return null;
    const j = await res.json();
    return { online: j?.online ?? 0, t: (j?.t ?? {}) as Record<string, number[]> };
  } catch {
    return null;  // offline — keep the previous counter value
  }
}

// Count pulse messages newer than the read mark in the browser: comparing ~50 numbers is cheaper
// than asking the server for a personal number.
export function countPulseUnread(
  pulse: ShoutPulse,
  sinceISO: string,
  onlyChannels?: string[],
): number {
  const since = sinceISO ? new Date(sinceISO).getTime() : 0;
  if (!since || Number.isNaN(since)) return 0;
  let n = 0;
  for (const [ch, list] of Object.entries(pulse.t)) {
    if (onlyChannels && !onlyChannels.includes(ch)) continue;
    // Lists sorted newest first — stop at the first old one.
    for (const ts of list) {
      if (ts * 1000 <= since) break;
      n += 1;
    }
  }
  return n;
}

// Mark chat read ON THE SERVER (users.shoutbox_last_seen = now). Logged-in only — syncs the badge
// across devices. Anons: no-op (their read state lives in localStorage). Best effort: the next ping
// fixes the badge anyway.
export async function markSeenServer(): Promise<void> {
  if (!pb.authStore.isValid) return;
  try {
    await pb.send('/api/custom/shoutbox/seen', { method: 'POST' });
  } catch { }
}

// Open a DM: the server finds or creates it. Idempotent — the frontend stores no conversation ids.
export async function openDM(userId: string): Promise<ShoutChannel> {
  const res = await pb.send('/api/custom/shoutbox/dm', {
    method: 'POST', body: { user: userId },
  });
  channelsCache = null;  // a new channel appeared in the menu
  return res.channel as ShoutChannel;
}

// Create a private room. Invitees join immediately without confirmation (see handler comment);
// leaving is one button.
export async function createRoom(title: string, members: string[] = []): Promise<ShoutChannel> {
  const res = await pb.send('/api/custom/shoutbox/rooms', {
    method: 'POST', body: { title, members },
  });
  channelsCache = null;
  return res.channel as ShoutChannel;
}

// Invite/kick: owner only; DMs can't be edited this way.
export async function updateRoomMembers(
  channel: string, add: string[] = [], remove: string[] = [],
): Promise<ShoutChannel> {
  const res = await pb.send('/api/custom/shoutbox/rooms/members', {
    method: 'POST', body: { channel, add, remove },
  });
  channelsCache = null;
  return res.channel as ShoutChannel;
}

// Leave a private room; leaving a DM is refused by the server.
export async function leaveRoom(channel: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/rooms/leave', {
    method: 'POST', body: { channel },
  });
  channelsCache = null;
}

// Room in the moderator panel. Not ShoutChannel: that's "what to show in the menu"; this is "what I
// can manage", incl. hidden (enabled=false).
export interface AdminRoom {
  id: string;
  slug: string;
  title: string;
  description: string;
  sort: number;
  enabled: boolean;
  is_private: boolean;
  // Private room owner: the server lets only them invite/kick.
  owner: string;
  members: string[];
}

// Staff room slug — same as shoutbox_staff.go. The panel recognizes it by slug; there's no schema
// flag and none will be added.
export const STAFF_ROOM_SLUG = 'staff';

// Every edit returns the whole list: order and "how many more fit" are computed server-side;
// assembling from partial responses would duplicate those rules on the frontend.
async function adminRooms(path: string, body?: unknown): Promise<AdminRoom[]> {
  const res = await pb.send(`/api/custom/shoutbox/rooms/admin${path}`,
    body === undefined ? { method: 'GET' } : { method: 'POST', body });
  channelsCache = null;  // room menu changed — refetch
  return (res?.rooms ?? []) as AdminRoom[];
}

export const fetchAdminRooms = (): Promise<AdminRoom[]> => adminRooms('');

export const createPublicRoom = (title: string, description = ''): Promise<AdminRoom[]> =>
  adminRooms('', { title, description });

// Send only changed fields: the server distinguishes "don't touch" from "set empty" by key absence,
// and an extra title would overwrite someone else's edit.
export const updateAdminRoom = (
  channel: string,
  patch: { title?: string; description?: string; enabled?: boolean; is_private?: boolean },
): Promise<AdminRoom[]> => adminRooms('/update', { channel, ...patch });

export const moveAdminRoom = (channel: string, dir: 'up' | 'down'): Promise<AdminRoom[]> =>
  adminRooms('/move', { channel, dir });

// Create the staff room or resync its members — one endpoint for "the room exists and contains all
// moderators" (shoutbox_staff.go).
export const syncStaffRoom = (): Promise<AdminRoom[]> => adminRooms('/staff', {});

// Staff colors (owner red, moderators blue). Errors swallowed: a name color isn't worth an error
// message.
export async function fetchChatAdmins(): Promise<string[]> {
  try {
    const res = await pb.send('/api/custom/shoutbox/staff', { method: 'GET' });
    return (res?.admins ?? []) as string[];
  } catch {
    return [];
  }
}

// My block list, ids only (names come with the feed). Error (guest, network) → empty list: blocking
// isn't critical for showing chat.
export async function fetchBlocks(): Promise<string[]> {
  if (!pb.authStore.isValid) return [];
  try {
    const res = await pb.send('/api/custom/shoutbox/blocks', { method: 'GET' });
    return (res?.blocked ?? []) as string[];
  } catch {
    return [];
  }
}

// Block: hide their messages locally; the server closes the DM (both ways) and mutes their
// notifications. Idempotent.
export async function blockUser(userId: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/block', { method: 'POST', body: { user: userId } });
  channelsCache = null;  // the DM with them disappears from the list — refetch
}

export async function unblockUser(userId: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/unblock', { method: 'POST', body: { user: userId } });
  channelsCache = null;
}

// Assign a name and/or note. Both empty → note deleted. The server trims length and strips control
// chars, so store what came back, not what was sent.
export async function saveChatNote(
  userId: string,
  alias: string,
  note: string,
): Promise<ChatNote> {
  const res = await pb.send('/api/custom/shoutbox/note', {
    method: 'POST',
    body: { user: userId, alias, note },
  });
  const saved: ChatNote = { a: res?.alias || undefined, n: res?.note || undefined };
  applyChatNote(userId, saved);
  return saved;
}

// Pinned DM order as a whole: pin, unpin and reorder are one "here's the new list" operation, so
// there's never a state where the server knows about a pin but not its position.
export async function saveChatPins(pins: string[]): Promise<string[]> {
  const before = currentChatPins();
  applyChatPins(pins);  // reorder the screen immediately, without waiting for the response
  try {
    const res = await pb.send('/api/custom/shoutbox/pins', {
      method: 'POST',
      body: { pins },
    });
    const out = (res?.pins ?? []) as string[];
    applyChatPins(out);
    return out;
  } catch (e) {
    // Rejected → revert the screen and say so. Rejections used to look like success: the pin stayed
    // until F5 and never existed on the server.
    applyChatPins(before);
    channelsCache = null;
    throw e;
  }
}
