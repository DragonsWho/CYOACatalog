// Helpers for the built-in cheat/saver companion. The Go backend injects a shim into hosted game
// HTML when the iframe URL has a flag (hosting.go): ?__save=1 — saver mode ("post a build" +
// point-bar utilities), added to every hosted-game iframe, normal cache headers (distinct URL =
// distinct edge-cache entry); ?__cheat=1 — full cheat mode from load (/cheat-lab), no-store. On the
// game page cheats turn on WITHOUT reload: the bridge sends the loaded saver shim a mode message
// (useCheatBridge). Direct subdomain visits (no flag) stay byte-identical.

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

export function withCheatFlag(url: string): string {
  return withFlag(url, '__cheat');
}

export function withSaveFlag(url: string): string {
  return withFlag(url, '__save');
}

// Only our own hosting (author.cyoa.cafe) injects the shim; external servers ignore the flag, so
// don't append it.
export function isHostedGameUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)cyoa\.cafe$/i.test(h) || /^(localhost|127\.0\.0\.1)$/i.test(h);
  } catch {
    return false;
  }
}

// Fired after a build is posted (as a comment) so the open thread refetches without a page reload.
export const BUILD_POSTED_EVENT = 'cyoa-build-posted';

export function announceBuildPosted(gameId: string): void {
  window.dispatchEvent(new CustomEvent(BUILD_POSTED_EVENT, { detail: { gameId } }));
}

// Fired by a build card's "Load" button. GameDetails (only listener, one per page) turns cheats on
// and hands the build string to the shim to reproduce the selection. Event carries only the code —
// the page is already scoped to one game.
export const LOAD_BUILD_EVENT = 'cyoa-load-build';

export function requestLoadBuild(code: string): void {
  window.dispatchEvent(new CustomEvent(LOAD_BUILD_EVENT, { detail: { code } }));
}
