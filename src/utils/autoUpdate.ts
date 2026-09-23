// Silent self-update of open tabs. /api/app-build returns the hashed entry-bundle name of the
// current frontend (buildAppBuild in main.go) — changes ONLY when the frontend changed; Go-only
// deploys touch nobody. Reload only when invisible: 1) next internal link click — swap SPA routing
// for a real browser navigation; 2) tab went to background — user returns to a fresh one. Never
// touch a page the user is looking at. NEVER touch /game/* (playthrough progress lives in the
// iframe). Respect holds (appReload.ts).

import { activeHolds, reloadOnce } from './appReload';

const POLL_MS = 5 * 60_000;
// Delay before background reload: cf-purge in `make ship` runs AFTER restart; a tab reloading in
// that gap would get the stale index.html from CF cache.
const SETTLE_MS = 30_000;
// Don't reload a deeply scrolled feed in background: the user would come back to the top of the
// list — exactly the visible disruption we avoid.
const SCROLL_LIMIT_PX = 1200;

let baseline: string | null = null;
let pending = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

async function checkBuild(): Promise<void> {
  try {
    const res = await fetch('/api/app-build', { cache: 'no-store' });
    if (!res.ok) return;
    const { build } = (await res.json()) as { build?: string };
    if (!build) return;  // dev mode: no marker, do nothing
    if (baseline === null) {
      baseline = build;
      return;
    }
    if (build !== baseline) pending = true;
  } catch {
  // Network blip or restart in progress — try next time.
  }
}

function onGamePage(pathname = location.pathname): boolean {
  return pathname.startsWith('/game/');
}

function safeToReload(): boolean {
  const holds = activeHolds();
  if (holds.length > 0) {
    console.info(`[autoUpdate] update postponed, holds: ${holds.join(', ')}`);
    return false;
  }
  return !onGamePage();
}

function cancelSettle(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    // Returned before the reload happened — cancel: reloading under the user's eyes is exactly the
    // flicker to avoid.
    cancelSettle();
    void checkBuild();
    return;
  }
  if (!pending || !safeToReload() || window.scrollY > SCROLL_LIMIT_PX) return;
  cancelSettle();
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (document.visibilityState === 'hidden') reloadOnce('new build, tab in background');
  }, SETTLE_MS);
}

// Internal link click with an update ready → real browser navigation instead of client routing.
// Captured before react-router. Only <a> clicks; programmatic navigate() bypasses this and is
// covered by the background reload. Deliberate trade-off: one file instead of edits across all
// routing.
function onClickCapture(e: MouseEvent): void {
  if (!pending || e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

  const a = (e.target as HTMLElement | null)?.closest?.('a');
  if (!a) return;
  if (a.target && a.target !== '_self') return;
  if (a.hasAttribute('download')) return;
  if (a.origin !== location.origin) return;
  // Same-page anchor is not navigation.
  if (a.pathname === location.pathname && a.hash) return;
  // Entering a game is never turned into a full reload.
  if (onGamePage(a.pathname)) return;
  if (!safeToReload()) return;

  e.preventDefault();
  console.info('[autoUpdate] new build: navigating with a full load');
  location.assign(a.href);
}

export function initAutoUpdate(): void {
  void checkBuild();
  setInterval(() => void checkBuild(), POLL_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('click', onClickCapture, true);
}
