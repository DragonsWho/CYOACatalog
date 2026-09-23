// Measures REAL playtime and reports GA game_play + game_heartbeat (analytics.ts). Interactive
// CYOAs run in an iframe; once the player clicks INTO it, interaction never reaches GA's engagement
// timer, so every /game/* page showed ~15s. "Playing" = tab visible AND document.hasFocus():
// hasFocus() stays TRUE when focus is inside a child iframe (even cross-origin) and flips FALSE
// only on switching tab/app — no iframe cooperation needed. Sample periodically instead of reacting
// to focus/blur, because clicking into a cross-origin iframe fires the parent's `blur` while
// hasFocus() is still true.

import { useEffect } from 'react';
import { analytics } from './analytics';

const SAMPLE_MS = 5_000;  // engagement sample interval
const FLUSH_EVERY = 3;  // heartbeat every 3 samples (~15s engaged)

// @param enabled only for interactive iframe games (the blind spot); image games render in the
// parent doc and GA measures them fine. @param hosted our hosting vs external (event dimension).
export function useGamePlaytime(gameId: string | undefined, enabled: boolean, hosted: boolean): void {
  useEffect(() => {
    if (!enabled || !gameId) return;

    const isEngaged = (): boolean =>
      document.visibilityState === 'visible' && document.hasFocus();

    let engagedSec = 0;  // engaged seconds accumulated but not yet emitted
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

    // Flush when the tab is hidden so the last slice isn't lost — gtag uses sendBeacon, which
    // survives unload.
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') emit();
    };
    document.addEventListener('visibilitychange', onHide);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onHide);
      emit();  // final partial slice when leaving the game page
    };
  }, [gameId, enabled, hosted]);
}
