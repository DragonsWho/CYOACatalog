// Shared helpers for the built-in cheat/saver companion.
//
// The companion UI is a shim the Go backend injects into a hosted game's HTML
// when the iframe is requested with a flag (see hosting.go):
//   ?__save=1  — saver mode: "post a build" + point-bar utilities. The site adds
//                this to every hosted-game iframe; the response keeps its normal
//                cache headers (a distinct URL = a distinct edge-cache entry).
//   ?__cheat=1 — full cheat mode from load (the /cheat-lab path), no-store.
// On the game page cheats are turned on WITHOUT a reload: the bridge sends the
// already-loaded saver shim a mode message (see useCheatBridge). Direct visits
// to a game subdomain (no flag) stay byte-identical.

function withFlag(url: string, flag: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(flag, '1');
    return u.toString();
  } catch {
    return url + (url.includes('?') ? '&' : '?') + flag + '=1';
  }
}

/** Add ?__cheat=1 to a hosted-game URL (full cheat mode from load — the lab). */
export function withCheatFlag(url: string): string {
  return withFlag(url, '__cheat');
}

/** Add ?__save=1 to a hosted-game URL (saver mode; upgraded via postMessage). */
export function withSaveFlag(url: string): string {
  return withFlag(url, '__save');
}

/** Only our own hosting (author.cyoa.cafe) injects the shim — an external
 *  game's server would just ignore the flag, so don't bother appending it. */
export function isHostedGameUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)cyoa\.cafe$/i.test(h) || /^(localhost|127\.0\.0\.1)$/i.test(h);
  } catch {
    return false;
  }
}

// Fired after a build is posted (as a comment) so the open comment thread can
// refetch and show it without a full page reload.
export const BUILD_POSTED_EVENT = 'cyoa-build-posted';

export function announceBuildPosted(gameId: string): void {
  window.dispatchEvent(new CustomEvent(BUILD_POSTED_EVENT, { detail: { gameId } }));
}

// Fired when a "Load" button on a build card is clicked. GameDetails (the only
// listener, one per game page) turns cheats on and hands the build string to the
// shim, which reproduces the selection in the game. The event carries just the
// code — the page is already scoped to a single game.
export const LOAD_BUILD_EVENT = 'cyoa-load-build';

export function requestLoadBuild(code: string): void {
  window.dispatchEvent(new CustomEvent(LOAD_BUILD_EVENT, { detail: { code } }));
}
