// Personal notes about people and DM contact order. Unlike chatPrefs (per device, localStorage)
// this is the person's state: an assigned name must show on phone and laptop alike. Stored
// server-side in shoutbox_user_state, delivered inside the /channels response (no separate
// request). Own useSyncExternalStore subscription: names render in feed rows, members list, DM
// header and channel list (four tree branches); prop-drilling would re-render the whole feed after
// one edit.

import { useSyncExternalStore } from 'react';

// Short keys: the whole map rides in every /channels response; `alias`/`note` × 200 entries is an
// extra kilobyte.
export type ChatNote = {
  // Assigned name, shown INSTEAD of the real one (like Discord).
  a?: string;
  // Free note, visible only in the profile card.
  n?: string;
};

export interface ChatNotesState {
  notes: Record<string, ChatNote>;
  // Pinned DM channel ids in display order.
  pins: string[];
}

const EMPTY: ChatNotesState = { notes: {}, pins: [] };

let state: ChatNotesState = EMPTY;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Snapshot must keep its reference while unchanged, or useSyncExternalStore re-renders forever.
const snapshot = () => state;

function emit(next: ChatNotesState) {
  state = next;
  for (const fn of listeners) fn();
}

// Fill from the server (/channels response); guests get empty.
export function loadChatNotes(raw?: { notes?: Record<string, ChatNote>; pins?: string[] }) {
  emit({
    notes: raw?.notes ?? {},
    pins: Array.isArray(raw?.pins) ? raw.pins : [],
  });
}

// Apply a saved note locally without waiting for a channel list reload. Empty (no name, no note) =
// remove.
export function applyChatNote(userId: string, note: ChatNote) {
  const next = { ...state.notes };
  if (!note.a && !note.n) delete next[userId];
  else next[userId] = note;
  emit({ ...state, notes: next });
}

// Current pin order outside React — needed for rollback of optimistic updates the server rejects.
export function currentChatPins(): string[] {
  return state.pins;
}

export function applyChatPins(pins: string[]) {
  emit({ ...state, pins });
}

// Assigned name outside React (shoutboxApi builds DM titles). Empty = not assigned, render the real
// name.
export function chatAliasOf(userId?: string): string {
  return (userId && state.notes[userId]?.a) || '';
}

export function useChatNotes(): ChatNotesState {
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
