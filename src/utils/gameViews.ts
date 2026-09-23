// First-party per-game view counter (view_counter.go). Separate from GA on purpose: same-origin
// ping isn't blocked by ad-blockers (significant on an NSFW audience) and the numbers are ours to
// show. Recorded for every visitor but currently surfaced ONLY on the moderator panel while
// calibrating.

// Record one view; deduped per browser session so refresh/back-and-forth doesn't inflate.
// Fire-and-forget, never throws.
export function recordGameView(gameId: string | undefined): void {
  if (!gameId) return;
  const key = `gv:${gameId}`;
  try {
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
  // private mode / storage disabled — still count once
  }
  void fetch(`/api/custom/games/${encodeURIComponent(gameId)}/view`, {
    method: 'POST',
    keepalive: true,
  }).catch(() => {
  // offline / blocked — a missed view is fine
  });
}

export interface GameViewStat {
  game_id: string;
  slug?: string;  // pretty-URL key; link via slug||game_id
  title: string;
  count: number;
  updated: string;
}

// Moderator-only: top games by first-party view count.
export async function fetchGameViewStats(
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>,
  limit = 200,
): Promise<GameViewStat[]> {
  const res = await authedFetch(`/api/custom/mod/game-views?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load view stats (${res.status})`);
  const body = await res.json();
  return Array.isArray(body.stats) ? (body.stats as GameViewStat[]) : [];
}
