// Shared "safely reload the tab" machinery. Used by AppErrorBoundary (emergency: lazy chunk failed
// to load) and autoUpdate.ts (planned, silent: new build out). Also a registry of "holds" — live
// state a reload would destroy (unsent message, running upload). While any hold exists, silent
// reload is postponed; emergency reload is not (the page is already broken).

import { useEffect } from 'react';

const RELOAD_MARK = 'app:autoReloadAt';
const MIN_GAP_MS = 10 * 60_000;

let reloadedThisPageLoad = false;

// Loop-guarded reload: at most once per 10 min per tab and once per page load. If the source itself
// is broken the user sees the breakage, not endless flicker.
export function reloadOnce(reason: string): boolean {
  if (reloadedThisPageLoad) return false;
  try {
    const prev = Number(sessionStorage.getItem(RELOAD_MARK) || 0);
    if (Date.now() - prev < MIN_GAP_MS) {
      console.warn(`[appReload] suppressed (${reason}): reloaded recently`);
      return false;
    }
    sessionStorage.setItem(RELOAD_MARK, String(Date.now()));
  } catch {
  // Storage unavailable (site data blocked) — only the in-memory guard above remains.
  }
  reloadedThisPageLoad = true;
  console.info(`[appReload] reloading: ${reason}`);
  location.reload();
  return true;
}

// Module/chunk load error? Browsers word it differently, so match a set of signatures, not one
// string.
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return (
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg) ||
    /unable to preload css/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

const holds = new Set<string>();

export function holdReload(key: string): () => void {
  holds.add(key);
  return () => {
    holds.delete(key);
  };
}

export function useReloadHold(key: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return holdReload(key);
  }, [key, active]);
}

export function activeHolds(): string[] {
  return [...holds];
}

// Global module-load failures that never reach the ErrorBoundary: `vite:preloadError` (route chunk
// preload failed) and unhandledrejection from a failed `import()` outside render. Both mean the
// file is gone; cure is a reload.
export function initChunkErrorGuard(): void {
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();  // otherwise Vite rethrows the error
    reloadOnce('vite:preloadError');
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason)) {
      e.preventDefault();
      reloadOnce('unhandled chunk import rejection');
    }
  });
}
