// src/utils/gameViews.ts
//
// First-party per-game view counter (see view_counter.go). Separate from GA on
// purpose: this same-origin ping is not blocked by ad-blockers (which matter a
// lot on an NSFW audience) and its numbers are ours to show on the site.
//
// The counts are recorded for every visitor, but currently surfaced ONLY on the
// moderator panel while we calibrate — nothing here renders in the public UI.

/**
 * Record one view of a game. Deduped per browser session so a refresh / back-
 * and-forth doesn't inflate the count. Fire-and-forget: never throws, never
 * blocks the page.
 */
export function recordGameView(gameId: string | undefined): void {
  if (!gameId) return;
  const key = `gv:${gameId}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    /* private mode / storage disabled — fall through and still count once */
  }
  void fetch(`/api/custom/games/${encodeURIComponent(gameId)}/view`, {
    method: 'POST',
    keepalive: true,
  }).catch(() => {
    /* offline / blocked — a missed view is fine */
  });
}

export interface GameViewStat {
  game_id: string;
  slug?: string; // pretty-URL key; link via slug||game_id
  title: string;
  count: number;
  updated: string;
}

/** Moderator-only: top games by first-party view count. */
export async function fetchGameViewStats(
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>,
  limit = 200,
): Promise<GameViewStat[]> {
  const res = await authedFetch(`/api/custom/mod/game-views?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load view stats (${res.status})`);
  const body = await res.json();
  return Array.isArray(body.stats) ? (body.stats as GameViewStat[]) : [];
}
