// src/utils/useGamePlaytime.ts
//
// Measures REAL time spent playing a game and reports it to GA as game_play +
// game_heartbeat events (see analytics.ts).
//
// Why this exists: interactive CYOAs run inside an iframe. For our own hosted
// games it's same-site, for external ones it's cross-origin — either way, once
// the player clicks INTO the game, their clicks/scrolls stay inside the frame
// and never reach GA's built-in engagement timer. That's why every /game/* page
// reports ~15s in GA no matter how long people actually play. We reconstruct the
// real number ourselves.
//
// "Playing" = the tab is visible AND the browser window has focus. The key
// insight: document.hasFocus() stays TRUE when focus is inside a (even
// cross-origin) child iframe, and flips to FALSE only when the user switches to
// another tab or app. So this one predicate cleanly separates "sitting in the
// game" from "left the game", without needing any cooperation from the iframe.
//
// We sample every few seconds rather than react to focus/blur events, because a
// click into a cross-origin iframe fires the parent window's `blur` while
// hasFocus() is still true — sampling sidesteps that ambiguity entirely.

import { useEffect } from 'react';
import { analytics } from './analytics';

const SAMPLE_MS = 5_000;   // how often we check "are they engaged right now?"
const FLUSH_EVERY = 3;     // emit a heartbeat every 3 samples (~15s of engaged time)

/**
 * @param gameId  catalog id of the game being viewed
 * @param enabled only true for interactive iframe games (the blind spot); image
 *                games render in the parent doc and GA measures them fine
 * @param hosted  our hosting vs an external site (kept as an event dimension)
 */
export function useGamePlaytime(gameId: string | undefined, enabled: boolean, hosted: boolean): void {
  useEffect(() => {
    if (!enabled || !gameId) return;

    const isEngaged = (): boolean =>
      document.visibilityState === 'visible' && document.hasFocus();

    let engagedSec = 0; // engaged seconds accumulated but not yet emitted
    let samples = 0;
    let played = false;

    const emit = (): void => {
      if (engagedSec >= 1) {
        analytics.gameHeartbeat({ game_id: gameId, seconds: Math.round(engagedSec), hosted });
        engagedSec = 0;
      }
    };

    const interval = window.setInterval(() => {
      if (isEngaged()) {
        engagedSec += SAMPLE_MS / 1000;
        if (!played) {
          played = true;
          analytics.gamePlay({ game_id: gameId, hosted });
        }
      }
      if (++samples % FLUSH_EVERY === 0) emit();
    }, SAMPLE_MS);

    // Flush promptly when the tab is hidden (page hide, tab switch) so the last
    // slice isn't lost — GA's gtag flushes via sendBeacon, which survives unload.
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') emit();
    };
    document.addEventListener('visibilitychange', onHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onHide);
      emit(); // final partial slice when leaving the game page
    };
  }, [gameId, enabled, hosted]);
}
