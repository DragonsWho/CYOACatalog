// Browser-side web push: SW registration, PushManager subscription, sync with /api/custom/push/*.
// One module because permission is asked once per install lifetime; asking at the wrong time loses
// it forever (browser remembers "Block"). So NO automatic prompts here — only on explicit user
// click.

import { pb, pbPublic } from '../pocketbase/pocketbase';

// Mode: ring on everything or only on addressed (reply / @mention).
export type PushMode = 'mentions' | 'all';

export type PushState = {
  // Push possible at all: browser supports it + server has VAPID keys.
  available: boolean;
  // Browser permission. 'denied' → toggle useless, user must change site settings.
  permission: NotificationPermission;
  subscribed: boolean;
  mode: PushMode;
};

const SW_URL = '/sw.js';
const MODE_KEY = 'push_mode';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// base64url VAPID key → Uint8Array as PushManager wants.
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let keyCache: string | null | undefined;

// Public VAPID key from the server. null = push disabled (no keys).
async function fetchPublicKey(): Promise<string | null> {
  if (keyCache !== undefined) return keyCache;
  try {
    const res = await pbPublic.send('/api/custom/push/key', { method: 'GET' });
    keyCache = res?.enabled && res?.public_key ? (res.public_key as string) : null;
  } catch {
    // Don't cache network failures: one failed try used to disable push until tab reload. Cache
    // null only when the server explicitly said push is off.
    return null;
  }
  return keyCache;
}

// Register SW lazily — only when push is actually needed; otherwise every guest carries a worker
// they never use.
async function ensureSW(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(SW_URL);
    if (existing) return existing;
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    return null;
  }
}

export function pushMode(): PushMode {
  return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'mentions';
}

// This device's push endpoint (or null). Sent in the presence ping so the server knows THIS device
// is watching and doesn't wake it. Per-person would be wrong — an open laptop tab would mute the
// phone in your pocket.
export async function pushEndpoint(): Promise<string | null> {
  if (!supported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

// Current state for UI. Asks nothing, subscribes nothing.
export async function pushState(): Promise<PushState> {
  const mode = pushMode();
  if (!supported()) {
    return { available: false, permission: 'denied', subscribed: false, mode };
  }
  const key = await fetchPublicKey();
  if (!key) return { available: false, permission: Notification.permission, subscribed: false, mode };

  let subscribed = false;
  // Granted permission isn't enough: the subscription may have been removed from another device or
  // expired. Ask PushManager itself.
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (reg) subscribed = !!(await reg.pushManager.getSubscription());

  return { available: true, permission: Notification.permission, subscribed, mode };
}

// Enable push on this device. Returns failure reason or null. Call ONLY from a click handler, or
// the browser won't show the prompt.
export async function pushSubscribe(mode: PushMode = pushMode()): Promise<string | null> {
  if (!supported()) return 'This browser does not support notifications.';
  if (!pb.authStore.isValid) return 'Notifications are for signed-in users only.';

  const key = await fetchPublicKey();
  if (!key) return 'Notifications are not configured on the server.';

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return perm === 'denied'
      ? 'Notifications are blocked in the site settings — you can only re-enable them there.'
      : 'Permission was not granted.';
  }

  const reg = await ensureSW();
  if (!reg) return 'Could not start the service worker.';
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,  // browsers forbid "silent" pushes
        applicationServerKey: urlB64ToUint8Array(key) as BufferSource,
      });
    } catch {
      return 'The browser refused the subscription.';
    }
  }

  const json = sub.toJSON();
  try {
    await pb.send('/api/custom/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        mode,
      },
    });
  } catch {
    return 'The server rejected the subscription.';
  }
  localStorage.setItem(MODE_KEY, mode);
  return null;
}

// Disable on this device: unsubscribe in browser AND on server (server-only leaves the browser
// subscribed). Returns true if server removal surely succeeded — formerly void and swallowed both
// errors, so UI showed OFF while the server kept pushing to a live subscription. Signature stays
// await-compatible (PushBell doesn't read the result yet).
export async function pushUnsubscribe(): Promise<boolean> {
  if (!supported()) return true;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return true;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch { }
  try {
    await pb.send('/api/custom/push/unsubscribe', { method: 'POST', body: { endpoint } });
    return true;
  } catch {
    // the server drops a dead subscription on its own at first send
    return false;
  }
}

// Change mode on an already subscribed device (re-subscribe = upsert). Returns null on success or a
// user message on server failure, like pushSubscribe. Formerly localStorage silently diverged from
// the server on failure (PushBell doesn't check the result yet).
export async function pushSetMode(mode: PushMode): Promise<string | null> {
  localStorage.setItem(MODE_KEY, mode);
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return null;
  const json = sub.toJSON();
  try {
    await pb.send('/api/custom/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        mode,
      },
    });
    return null;
  } catch {
    return 'Mode saved on this device, but the server update failed — it will sync on next subscribe.';
  }
}

// Room mode as read. '' = "as device" (no server row).
export type RoomPushMode = '' | 'all' | 'mentions' | 'mute';

// Settable values. The server converts a timed mute into 'mute' and lifts it on expiry — from
// outside timed and permanent mutes are indistinguishable, on purpose: chat only cares "silent now
// or not".
export type RoomPushSet = RoomPushMode | 'mute1h' | 'mute24h';

const ROOM_PREFS_KEY = 'chat_room_prefs';

// Last known prefs snapshot — synchronous and free. The chat screen needs it to not play its own
// sound in a muted room (server already handles push). Fetching per chat entry isn't worth it; the
// server is authoritative, "as last time" suffices here.
export function roomPushPrefsCached(): Record<string, RoomPushMode> {
  try {
    return JSON.parse(localStorage.getItem(ROOM_PREFS_KEY) || '{}');
  } catch {
    return {};
  }
}

function cacheRoomPrefs(p: Record<string, RoomPushMode>) {
  try {
    localStorage.setItem(ROOM_PREFS_KEY, JSON.stringify(p));
  } catch {
  }
}

// Per-room prefs {channelId: mode}, only those the user touched. Fetched lazily on bell-menu open,
// not on chat entry: most users have none, and a request per entry would spend the server on an
// empty answer.
export async function roomPushPrefs(): Promise<Record<string, RoomPushMode>> {
  if (!pb.authStore.isValid) return {};
  try {
    const res = await pb.send('/api/custom/shoutbox/notify-prefs', { method: 'GET' });
    const prefs = (res?.prefs ?? {}) as Record<string, RoomPushMode>;
    cacheRoomPrefs(prefs);
    return prefs;
  } catch {
    return roomPushPrefsCached();
  }
}

// Set room mode; '' = remove override (back to device setting).
export async function roomPushSetMode(channel: string, mode: RoomPushSet): Promise<void> {
  // Trust the response, not the request: the server computes the mute expiry, and the cache must
  // hold what it actually stored ('mute1h' → 'mute'), or the menu shows a mode that isn't in the
  // DB.
  const res = (await pb.send('/api/custom/shoutbox/notify-prefs', {
    method: 'POST',
    body: { channel, mode },
  })) as { mode?: RoomPushMode } | null;
  const stored = (res && typeof res.mode === 'string' ? res.mode : mode) as RoomPushMode;
  const next = roomPushPrefsCached();
  if (stored) next[channel] = stored;
  else delete next[channel];
  cacheRoomPrefs(next);
}

// Close only notifications covered by this conversation read.
export async function dismissChatNotifications(channel: string, through: number): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.getNotifications) return;
    const list = await reg.getNotifications();
    for (const n of list) {
      if (n.data?.channel === channel && Date.parse((n.data.created || '').replace(' ', 'T')) <= through) n.close();
    }
  } catch {
  // non-critical: a lingering notification is minor next to crashing the chat
  }
}

// Send a test push to yourself — "does it arrive at all".
export async function pushTest(): Promise<void> {
  await pb.send('/api/custom/push/test', { method: 'POST' });
}
