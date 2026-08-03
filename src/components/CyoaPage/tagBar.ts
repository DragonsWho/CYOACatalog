// Pure tag-vote scoring + progress-bar geometry. No React/MUI here so it stays
// unit-testable in isolation (see tagBar.test.ts).
//
// Two scales share game_tag_votes.votes (see Go /api/custom/tag-vote in main.go):
//   • Proposed tag — a suggestion not yet on the game, encoded in a reserved low
//     band: votes = PROPOSED_BASE + miniScore. votes <= PROPOSED_BAND_MAX ⇒
//     proposed. miniScore is a small −5..+5 ballot; +PROMOTE_AT promotes it to an
//     accepted tag at 0, −PROMOTE_AT (or losing all support) drops it.
//   • Accepted tag — already on the game. votes = up − down directly.
//
// Accepted-tag negative side is a TWO-PHASE ballot so the deletion vote reads as
// a fresh progress bar rather than a single scale pegged full:
//   0 → FADED_MAX (−5)     "fade" ballot — at −5 the tag fades and is hidden
//                          from the public/resting view.
//   FADED_MAX → DELETE_AT  "delete" ballot — restarts at 0% and fills toward the
//   (−5 → −15)             server-enforced removal at −15 (main.go deleteAt).

// Proposed band -----------------------------------------------------------------
export const PROPOSED_BASE = -1000;
export const PROPOSED_BAND_MAX = -500;
export const PROMOTE_AT = 5;
export const isProposedVotes = (v: number) => v <= PROPOSED_BAND_MAX;
export const proposedMiniScore = (v: number) => v - PROPOSED_BASE;

// Accepted-tag thresholds. Keep DELETE_AT / GOLD_THRESHOLD in sync with the Go
// endpoint (main.go: deleteAt = -15, goldThreshold = 15).
export const FADED_MAX = -5; // score <= -5 → faded (hidden from public), delete ballot begins
export const DELETE_AT = -15; // score <= -15 → tag removed from game (server-side)
export const GOLD_THRESHOLD = 15; // score >= 15 in an eligible category → gold
export const PROPOSED_SATURATION = 5; // proposed ballot is -5..+5
// Retained for any external reference; accepted-bar geometry no longer uses it
// (each phase has its own denominator below).
export const ACCEPTED_SATURATION = 10;

export type BarPhase = 'up' | 'fade' | 'delete';
export type BarDir = 'pos' | 'neg' | null;
export interface Bar {
  dir: BarDir;
  /** Fill width 0..100 (%). */
  w: number;
  phase: BarPhase;
}

const clampPct = (x: number) => Math.max(0, Math.min(1, x)) * 100;

/**
 * Progress geometry for an ACCEPTED tag (votes = up − down).
 *   score > 0            → up   : fills toward gold (+GOLD_THRESHOLD).
 *   FADED_MAX < score< 0 → fade : fills toward the fade point (−5).
 *   score <= FADED_MAX   → delete: fresh bar from the fade point toward −15.
 */
export function acceptedBar(score: number): Bar {
  if (score > 0) {
    return { dir: 'pos', phase: 'up', w: clampPct(score / GOLD_THRESHOLD) };
  }
  if (score === 0) {
    return { dir: null, phase: 'up', w: 0 };
  }
  if (score > FADED_MAX) {
    // -5 < score < 0
    return { dir: 'neg', phase: 'fade', w: clampPct(Math.abs(score) / Math.abs(FADED_MAX)) };
  }
  // score <= -5 : delete ballot, rebased so -5→-15 maps 0%→100%.
  const span = Math.abs(DELETE_AT) - Math.abs(FADED_MAX); // 10
  return {
    dir: 'neg',
    phase: 'delete',
    w: clampPct((Math.abs(score) - Math.abs(FADED_MAX)) / span),
  };
}

/** Progress geometry for a PROPOSED tag's −5..+5 mini-ballot. */
export function proposedBar(miniScore: number): Bar {
  const dir: BarDir = miniScore > 0 ? 'pos' : miniScore < 0 ? 'neg' : null;
  return { dir, phase: dir === 'pos' ? 'up' : 'fade', w: clampPct(Math.abs(miniScore) / PROPOSED_SATURATION) };
}
