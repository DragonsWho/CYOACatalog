// Thin client for the bump-roulette Go endpoints (see bump_roulette.go).
// The whole vote lifecycle is server-authoritative — the frontend only reads
// aggregates and posts intent; every rule (cooldown, caps, lockout) lives in Go.

import { authedFetch } from './pocketbase';

export interface BumpStatus {
  tickets: number; // this game's current ticket total ("votes already cast")
  pool_tickets: number; // tickets across the whole roulette
  eligible: boolean; // may this game be voted for at all right now
  reason: string; // '', 'too_new', 'won_recently', 'unavailable'
  next_draw_at?: string;
  locked_until?: string; // set when reason === 'won_recently'
  // Personal fields (present only for signed-in callers):
  my_tickets?: number;
  max_tickets?: number;
  next_vote_at?: string; // set when the caller is on the global 1/day cooldown
  withdrawable_until?: string; // set when the caller's last ticket is still retractable
  can_vote?: boolean;
}

export interface BumpStanding {
  id: string;
  slug: string; // pretty-URL key; link via gameCanonicalKey (slug||id)
  title: string;
  image: string;
  nsfw: boolean;
  tickets: number;
}

export interface BumpWinner {
  id: string;
  slug: string; // pretty-URL key; link via gameCanonicalKey (slug||id)
  title: string;
  image: string;
  drawn_at: string;
  ticket_count: number;
  total_tickets: number;
}

export interface BumpStats {
  enabled: boolean;
  pool_tickets: number;
  next_draw_at?: string;
  standings: BumpStanding[];
  winners: BumpWinner[];
}

export interface BumpSettings {
  enabled: boolean;
  interval_hours: number;
  min_age_days: number;
  win_lockout_days: number;
  max_tickets_per_game: number;
  vote_cooldown_hours: number;
  withdraw_window_hours: number;
  next_draw_at?: string;
  last_draw_at?: string;
}

export interface BumpAdmin {
  settings: BumpSettings;
  pool_tickets: number;
  voters: number;
  standings: BumpStanding[];
  winners: BumpWinner[];
}

export interface BumpApiError extends Error {
  status: number;
  data: Record<string, unknown>;
}

async function jsonOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.message || 'Request failed') as BumpApiError;
    err.status = res.status;
    // PocketBase ApiError puts the metadata we attached (next_vote_at, …) under `data`.
    err.data = (data?.data as Record<string, unknown>) ?? {};
    throw err;
  }
  return data;
}

export const getBumpStatus = (gameId: string): Promise<BumpStatus> =>
  authedFetch(`/api/custom/bump/${gameId}`).then(jsonOrThrow);

export const castBumpVote = (gameId: string): Promise<BumpStatus> =>
  authedFetch(`/api/custom/bump/${gameId}/vote`, { method: 'POST' }).then(jsonOrThrow);

export const withdrawBumpVote = (gameId: string): Promise<BumpStatus> =>
  authedFetch(`/api/custom/bump/${gameId}/withdraw`, { method: 'POST' }).then(jsonOrThrow);

// Public, cache-friendly — no auth needed.
export const getBumpStats = (): Promise<BumpStats> =>
  fetch('/api/custom/bump/stats').then(jsonOrThrow);

export const getBumpAdmin = (): Promise<BumpAdmin> =>
  authedFetch('/api/custom/bump/admin').then(jsonOrThrow);

export const updateBumpSettings = (
  patch: Partial<BumpSettings> & { reset_next_draw?: boolean },
): Promise<{ settings: BumpSettings }> =>
  authedFetch('/api/custom/bump/admin', { method: 'POST', body: JSON.stringify(patch) }).then(jsonOrThrow);

export const runBumpDrawNow = (): Promise<{ winner: string }> =>
  authedFetch('/api/custom/bump/admin/draw', { method: 'POST' }).then(jsonOrThrow);
