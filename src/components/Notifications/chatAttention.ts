import { pb, notificationsCollection } from '../../pocketbase/pocketbase';
import { createLease } from '../Shoutbox/tabLeader';

export type AttentionChannel = { latest: number; dm: boolean };
export type AttentionSummary = {
  count: number;
  channels: Record<string, AttentionChannel>;
  reads: Record<string, number>;
  notifications: Record<string, number>;
};
type PendingRead = { id: string; at: number };
const empty = (): AttentionSummary => ({ count: 0, channels: {}, reads: {}, notifications: {} });
let state = empty();
let uid = '';
let revision = 0;
let liveVersions: Record<string, number> = {};
let notificationVersions: Record<string, string> = {};
let pending: Record<string, PendingRead> = {};
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
let chatOpen = false;
let lastSync = 0;
const listeners = new Set<() => void>();
export const subscribeAttention = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getAttention = () => state;
export const attentionRevision = () => revision;
export const setAttentionChatOpen = (open: boolean) => { chatOpen = open; if (!open) scheduleFlush(0); };
export const unreadAttention = (id: string) => (state.channels[id]?.latest ?? 0) > (state.reads[id] ?? 0);
const key = () => `chat-attention:${uid}`;

function publish(broadcast = true) {
  revision++;
  for (const fn of listeners) fn();
  if (broadcast && uid) {
    try { localStorage.setItem(key(), JSON.stringify({ state, pending, notificationVersions, at: Date.now() })); } catch { }
  }
}

export function applyAttention(next: AttentionSummary, expectedRevision = revision, broadcast = true) {
  const reads = { ...state.reads };
  for (const [id, at] of Object.entries(next.reads)) reads[id] = Math.max(reads[id] ?? 0, at);
  const channels = { ...next.channels };
  for (const [id, value] of Object.entries(state.channels)) {
    if (!broadcast || (liveVersions[id] ?? 0) > expectedRevision) {
      channels[id] = { latest: Math.max(channels[id]?.latest ?? 0, value.latest), dm: value.dm || !!channels[id]?.dm };
    }
  }
  let count = expectedRevision === revision ? next.count : state.count;
  const notifications = expectedRevision === revision ? { ...next.notifications } : { ...state.notifications };
  for (const id of Object.keys(notifications)) {
    if (reads[id] && channels[id] && channels[id].latest <= reads[id]) {
      count -= notifications[id]; delete notifications[id];
    }
  }
  state = { count: Math.max(0, count), notifications, channels, reads };
  lastSync = Date.now();
  publish(broadcast);
}

export function noteAttention(channel: string, created: string, dm: boolean) {
  const at = Date.parse(created.replace(' ', 'T'));
  if (!uid || !channel || !Number.isFinite(at)) return;
  const prev = state.channels[channel];
  if (prev && prev.latest >= at && (prev.dm || !dm)) return;
  liveVersions[channel] = revision + 1;
  state = { ...state, channels: { ...state.channels, [channel]: { latest: Math.max(prev?.latest ?? 0, at), dm: dm || !!prev?.dm } } };
  publish();
}

export function readAttention(channel: string, id: string, created: string) {
  const at = Date.parse(created.replace(' ', 'T'));
  if (!uid || !id || !Number.isFinite(at) || at <= (state.reads[channel] ?? 0)) return;
  const switching = Object.keys(pending).some((id) => id !== channel);
  pending[channel] = { id, at };
  const notifications = { ...state.notifications };
  const caughtUp = (state.channels[channel]?.latest ?? 0) <= at;
  const count = Math.max(0, state.count - (caughtUp ? notifications[channel] ?? 0 : 0));
  if (caughtUp) delete notifications[channel];
  state = { ...state, count, notifications, reads: { ...state.reads, [channel]: at } };
  publish();
  scheduleFlush(switching ? 500 : 2000);
  navigator.serviceWorker?.controller?.postMessage({ type: 'cyoa-chat-read', channel, at });
}

export function listenAttentionNotifications() {
  let disposed = false;
  let stop: (() => void) | undefined;
  const owner = pb.authStore.record?.id;
  void notificationsCollection.subscribe('*', (event) => {
    if (disposed || uid !== owner || !['create', 'update'].includes(event.action) || event.record.read) return;
    const n = event.record;
    const version = String(n.shout_message || n.id);
    if (notificationVersions[n.id] === version) return;
    notificationVersions[n.id] = version;
    notificationVersions = Object.fromEntries(Object.entries(notificationVersions).slice(-200));
    const ch = n.shout_channel as string;
    const message = (n.expand as { shout_message?: { created?: string } } | undefined)?.shout_message;
    const at = message?.created ? Date.parse(message.created.replace(' ', 'T')) : 0;
    if (ch && at && at <= (state.reads[ch] ?? 0)) return;
    if (ch && message?.created) noteAttention(ch, message.created, n.type === 'shout_dm');
    if (event.action === 'update' && (!ch || state.notifications[ch])) return;
    state = { ...state, count: state.count + 1, notifications: ch
      ? { ...state.notifications, [ch]: (state.notifications[ch] ?? 0) + 1 } : state.notifications };
    publish();
  }, { expand: 'shout_message', fields: 'id,type,read,shout_channel,shout_message,expand.shout_message.created' }).then((fn) => {
    if (disposed) fn(); else stop = fn;
  }).catch(() => {});
  return () => { disposed = true; stop?.(); };
}

export function readNotificationTray(
  items: { read: boolean; shout_channel?: string }[],
  markedCount = items.length,
) {
  const notifications = { ...state.notifications };
  const unread = items.filter((n) => !n.read);
  for (const n of unread) {
    if (n.shout_channel && notifications[n.shout_channel]) {
      notifications[n.shout_channel]--;
      if (notifications[n.shout_channel] <= 0) delete notifications[n.shout_channel];
    }
  }
  state = { ...state, count: Math.max(0, state.count - markedCount), notifications };
  publish();
}

export function pendingAttentionReads() {
  return Object.fromEntries(Object.entries(pending).slice(0, 100).map(([ch, p]) => [ch, p.id]));
}
export function acknowledgeAttentionReads(batch: Record<string, string>) {
  for (const [ch, id] of Object.entries(batch)) if (pending[ch]?.id === id) delete pending[ch];
  publish();
}

function scheduleFlush(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void flushReads(); }, delay);
}

async function flushReads() {
  if (flushing || !uid || !Object.keys(pending).length) return;
  const owner = uid;
  const batch = Object.fromEntries(Object.entries(pending).slice(0, 100));
  flushing = true;
  let delay = 500;
  try {
    await pb.send('/api/custom/shoutbox/read', { method: 'POST', body: { messages: Object.fromEntries(Object.entries(batch).map(([ch, p]) => [ch, p.id])) }, requestKey: null });
    if (uid !== owner) return;
    for (const [ch, p] of Object.entries(batch)) if (pending[ch]?.at === p.at) delete pending[ch];
    publish();
  } catch { delay = 10_000; }
  finally {
    flushing = false;
    if (uid && Object.keys(pending).length) scheduleFlush(delay);
  }
}

export function startAttention(userId: string) {
  uid = userId;
  state = empty(); pending = {}; liveVersions = {}; notificationVersions = {}; lastSync = 0;
  publish(false);
  if (!uid) return () => {};
  const owner = uid;
  const adopt = (raw: string | null) => {
    if (!raw || uid !== owner) return;
    try {
      const value = JSON.parse(raw) as { state: AttentionSummary; pending: Record<string, PendingRead>; notificationVersions?: Record<string, string>; at: number };
      for (const [ch, p] of Object.entries(value.pending)) if (p.at > (pending[ch]?.at ?? 0)) pending[ch] = p;
      notificationVersions = { ...notificationVersions, ...value.notificationVersions };
      applyAttention(value.state, revision, false);
      lastSync = value.at;
      if (Object.keys(pending).length) scheduleFlush(500);
    } catch { }
  };
  try { adopt(localStorage.getItem(key())); } catch { }
  let busy = false;
  const refresh = async () => {
    if (busy || document.visibilityState !== 'visible' || Date.now() - lastSync < (chatOpen ? 90_000 : 55_000)) return;
    busy = true;
    const version = revision;
    try {
      const data = await pb.send<AttentionSummary>('/api/custom/shoutbox/attention', { method: 'GET', requestKey: null });
      if (uid === owner) applyAttention(data, version);
    } catch { }
    finally { busy = false; }
  };
  const lease = createLease(`chat-attention-leader:${uid}`, () => { void refresh(); });
  const tick = () => {
    if (document.visibilityState !== 'visible') { lease.release(); return; }
    if (lease.hold()) void refresh();
    if (Object.keys(pending).length) scheduleFlush(500);
  };
  const wake = () => { lastSync = 0; tick(); };
  const storage = (e: StorageEvent) => { if (e.key === key()) adopt(e.newValue); };
  const push = (e: MessageEvent) => {
    const p = e.data;
    if (p?.type !== 'cyoa-chat-push' || p.recipient !== uid || !p.channel || !p.created) return;
    noteAttention(p.channel, p.created, !!p.dm);
  };
  window.addEventListener('storage', storage);
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  navigator.serviceWorker?.addEventListener('message', push);
  const interval = setInterval(tick, 60_000);
  tick();
  return () => {
    lease.release(); clearInterval(interval); if (timer) clearTimeout(timer);
    window.removeEventListener('storage', storage);
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
    navigator.serviceWorker?.removeEventListener('message', push);
    uid = ''; state = empty(); pending = {}; publish(false);
  };
}
