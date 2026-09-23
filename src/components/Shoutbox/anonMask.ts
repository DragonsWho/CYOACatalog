// Anonymous mask: the signature used without a name ("Anon Fox", "Anon Yuki"). In the browser
// because the name used to derive from anon_key (weekly window) and changed itself weekly; the
// author asked for a long-lived, self-chosen mask (decision 2026-09-16). There's nowhere
// server-side to store it (anons have no record). The browser already holds all "how chat looks for
// me" (chatPrefs.ts); the mask is one localStorage key surviving reload and IP change.
// The mask is NOT identity: mutes, send limits and the right to delete own messages hang on
// anon_key computed by the server from IP. Clearing localStorage loses the signature, not rights;
// copying someone's mask copies a signature, not history. By design (shoutbox_anon.go).

import { useSyncExternalStore } from 'react';

import { ANON_WORDS } from './anonIdentity';

const KEY = 'chatlab_anon_mask';

// The server holds the cap (shoutAnonMaskMax in shoutbox_anon.go); same number here so the input
// refuses immediately.
export const ANON_MASK_MAX = 16;
export const ANON_MASK_MIN = 2;

// Random mask on first visit, not an empty string: empty would mean "derive from the key", i.e. the
// weekly shuffle we're moving away from.
function randomMask(): string {
  const i = Math.floor(Math.random() * ANON_WORDS.length);
  return ANON_WORDS[i];
}

function load(): string {
  try {
    const raw = (localStorage.getItem(KEY) || '').trim();
    if (raw) return raw.slice(0, ANON_MASK_MAX);
  } catch { }  // private mode — the mask lives until reload
  const made = randomMask();
  save(made);
  return made;
}

function save(v: string) {
  try {
    localStorage.setItem(KEY, v);
  } catch { }
}

let mask = '';
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Snapshot must stay the same value while unchanged (strings compare by value, so free here).
function snapshot(): string {
  if (!mask) mask = load();
  return mask;
}

// Mask without "Anon" — exactly what goes to the server in `mask`; anonIdentity adds the prefix for
// everyone.
export function anonMask(): string {
  return snapshot();
}

// Error or empty string if valid. Same rules as the server (shoutAnonMaskClean): letters, digits,
// space, hyphen, apostrophe — repeated so the user learns in the field, not by a refusal on send.
export function anonMaskProblem(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return 'Pick a name.';
  if ([...s].length < ANON_MASK_MIN) return `At least ${ANON_MASK_MIN} characters.`;
  if ([...s].length > ANON_MASK_MAX) return `At most ${ANON_MASK_MAX} characters.`;
  if (!/^[\p{L}\p{N} '-]+$/u.test(s)) return "Letters, digits, spaces, - and ' only.";
  return '';
}

// Empty string resets to random: "no mask" never exists, or the signature would start changing
// itself again.
export function setAnonMask(raw: string) {
  const next = (raw.trim().replace(/\s+/g, ' ') || randomMask()).slice(0, ANON_MASK_MAX);
  if (next === mask) return;
  mask = next;
  save(mask);
  for (const fn of listeners) fn();
}

// A DIFFERENT random mask: re-roll if the same came out, or the click looks broken.
export function rerollAnonMask(): string {
  let next = randomMask();
  for (let i = 0; i < 8 && next === mask; i++) next = randomMask();
  setAnonMask(next);
  return next;
}

export function useAnonMask(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '');
}
