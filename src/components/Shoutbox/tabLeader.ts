// One browser, one job: "leader" tab election and a shared cross-tab cache. The chat icon sits in
// EVERY page header and people keep a dozen tabs (CYOAs opened in batches, revisited for days).
// Pulse and presence ping are per-BROWSER work: the server collapses all tabs of one person into
// one presence key (shoutPresenceKey), so ten requests from ten tabs differ from one only in logs
// and traffic. So the leader goes to the network and writes to localStorage; others read. The write
// wakes siblings via the `storage` event (no own channel needed; works without BroadcastChannel).
// Only a VISIBLE tab can lead: hidden → yields, else a minimized window on a second monitor would
// hold the queue while the browser throttles its timers — and nobody would ping.

// Lease lifetime without renewal: longer than the tick (60 s) since the leader renews every tick; a
// shorter cap would let siblings steal leadership from a live leader. Fallback path only — with Web
// Locks no lease expiry is needed.
const LEASE_TTL_MS = 150_000;

type LeaseRec = { id: string; at: number };

export type Lease = {
  // Take leadership if free (or renew). Returns current state; leadership may also arrive later via
  // onGain.
  hold(): boolean;
  // Release leadership: tab hidden or unmounted.
  release(): void;
  is(): boolean;
};

// Leadership lease under `key`. With Web Locks (all live browsers) take an exclusive lock: released
// honestly when the tab closes or is killed, and the next in queue gets it instantly without
// waiting for expiry. Otherwise a localStorage record with an expiry. onGain fires when leadership
// arrives ASYNCHRONOUSLY after hold() returned (Web Locks path); when hold() returns true
// immediately, onGain isn't called.
export function createLease(key: string, onGain: () => void): Lease {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const hasLocks = typeof navigator !== 'undefined' && 'locks' in navigator;
  let leader = false;
  let unlock: (() => void) | null = null;
  let pending: AbortController | null = null;

  const readRec = (): LeaseRec | null => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as LeaseRec) : null;
    } catch {
      return null;
    }
  };
  const writeRec = (rec: LeaseRec | null) => {
    try {
      if (rec) localStorage.setItem(key, JSON.stringify(rec));
      else localStorage.removeItem(key);
    } catch { }
  };

  const holdViaLocks = (): boolean => {
    if (leader || pending) return leader;  // already leading or already queued
    const ac = new AbortController();
    pending = ac;
    navigator.locks.request(key, { mode: 'exclusive', signal: ac.signal }, () => (
      // Keep the promise unresolved — while alive, the lock is ours.
      new Promise<void>((done) => {
        pending = null;
        leader = true;
        unlock = done;
        onGain();
      })
    )).catch(() => { })  // abort or refusal — simply not leading
      .finally(() => {
        if (pending === ac) pending = null;
        leader = false;
        unlock = null;
      });
    return leader;
  };

  const holdViaStorage = (): boolean => {
    const rec = readRec();
    const now = Date.now();
    if (rec && rec.id !== id && now - rec.at < LEASE_TTL_MS) {
      leader = false;
      return false;
    }
    writeRec({ id, at: now });
    // Re-read: if a sibling competed, the last write won and it may not be ours. Unreadable storage
    // (private mode) → assume we're the only tab: an extra ping beats a mute chat.
    const after = readRec();
    leader = after === null || after.id === id;
    // No onGain here on purpose: on this path leadership arrives SYNCHRONOUSLY inside hold(),
    // signaled by the returned true. Calling it would do the work twice.
    return leader;
  };

  return {
    hold: () => (hasLocks ? holdViaLocks() : holdViaStorage()),
    is: () => leader,
    release: () => {
      leader = false;
      if (unlock) { const f = unlock; unlock = null; f(); }
      if (pending) { pending.abort(); pending = null; }
      if (!hasLocks && readRec()?.id === id) writeRec(null);
    },
  };
}

type Shared<T> = { at: number; v: T };

// Read what the leader fetched last. `maxAgeMs` = max age still counted as an answer.
export function readShared<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const s = JSON.parse(raw) as Shared<T>;
    if (!s || typeof s.at !== 'number') return null;
    return Date.now() - s.at > maxAgeMs ? null : s.v;
  } catch {
    return null;
  }
}

// Store for siblings; the write itself wakes them (`storage` fires in all tabs EXCEPT the writer).
export function writeShared<T>(key: string, v: T): void {
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), v } satisfies Shared<T>));
  } catch { }
}

// Claim a slot: mark the key fresh RIGHT NOW (keeping the previous value) and return a rollback.
// The "this browser already reported" mark is set on request SUCCESS but decided on BEFORE it:
// while the request flies, a sibling doesn't see the mark and sends the same request — on chat page
// open that produced two pings in a row. The synchronous claim closes the window. Rollback is
// mandatory: a claim is a promise, not a fact; if the request fails and the mark stays, the browser
// goes silent for the interval and drops out of the online counter for nothing.
export function claimShared(key: string): () => void {
  let prev: string | null = null;
  try {
    prev = localStorage.getItem(key);
    // The previous value survives the claim: it holds already fetched data (anon_key, read mark);
    // zeroing it for a timestamp would lose exactly what siblings rely on.
    const v = prev ? (JSON.parse(prev) as Shared<unknown>).v : null;
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), v } satisfies Shared<unknown>));
  } catch { }  // private mode / corrupt value — the claim just won't work

  return () => {
    try {
      if (prev === null) localStorage.removeItem(key);
      else localStorage.setItem(key, prev);
    } catch { }
  };
}

// Shared cache keys declared HERE, not at use sites: the header icon writes and the chat screen
// reads (and writes); diverging string literals in two files silently break the exchange, visible
// only as extra requests.
export const LEADER_KEY = 'shoutbox_leader';
export const PULSE_KEY = 'shoutbox_pulse';
export const PING_KEY = 'shoutbox_ping';

// What this BROWSER's last ping brought and when. `uid` so a tab logged into another account (or
// logged out) doesn't pick up a foreign anon_key and read mark.
export type SharedPing = { uid: string; anonKey: string; lastSeen: string };

// Value from the `storage` event (already holds the new content — no extra localStorage read).
export function parseShared<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Shared<T>;
    return s && typeof s.at === 'number' ? s.v : null;
  } catch {
    return null;
  }
}
