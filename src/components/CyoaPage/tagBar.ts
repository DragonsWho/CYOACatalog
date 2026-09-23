// Pure tag-vote scoring + progress-bar geometry, no React/MUI (unit-tested in tagBar.test.ts). Two
// scales share game_tag_votes.votes (Go /api/custom/tag-vote in main.go):
// - Proposed: votes = PROPOSED_BASE + miniScore; votes <= PROPOSED_BAND_MAX ⇒ proposed. miniScore
// −5..+5; +PROMOTE_AT promotes at 0, −PROMOTE_AT (or losing all support) drops it.
// - Accepted: votes = up − down. Negative side is TWO-PHASE so deletion reads as a fresh bar: 0 →
// FADED_MAX (−5) "fade" (hidden from public at −5); FADED_MAX → DELETE_AT (−5 → −15) "delete",
// restarting at 0% toward server-enforced removal at −15 (main.go deleteAt).

export const PROPOSED_BASE = -1000;
export const PROPOSED_BAND_MAX = -500;
export const PROMOTE_AT = 5;
export const isProposedVotes = (v: number) => v <= PROPOSED_BAND_MAX;
export const proposedMiniScore = (v: number) => v - PROPOSED_BASE;

// Keep DELETE_AT / GOLD_THRESHOLD in sync with Go (main.go: deleteAt = -15, goldThreshold = 15).
export const FADED_MAX = -5;  // score <= -5 → faded (hidden from public), delete ballot begins
export const DELETE_AT = -15;  // score <= -15 → tag removed from game (server-side)
export const GOLD_THRESHOLD = 15;  // score >= 15 in an eligible category → gold
export const PROPOSED_SATURATION = 5;  // proposed ballot is -5..+5
// Retained for external references; accepted-bar geometry no longer uses it (each phase has its own
// denominator).
export const ACCEPTED_SATURATION = 10;

export type BarPhase = 'up' | 'fade' | 'delete';
export type BarDir = 'pos' | 'neg' | null;
export interface Bar {
  dir: BarDir;
  w: number;
  phase: BarPhase;
}

const clampPct = (x: number) => Math.max(0, Math.min(1, x)) * 100;

// Accepted tag geometry: score > 0 → up (fills toward +GOLD_THRESHOLD); FADED_MAX < score < 0 →
// fade (toward −5); score <= FADED_MAX → delete (fresh bar −5 → −15).
export function acceptedBar(score: number): Bar {
  if (score > 0) {
    return { dir: 'pos', phase: 'up', w: clampPct(score / GOLD_THRESHOLD) };
  }
  if (score === 0) {
    return { dir: null, phase: 'up', w: 0 };
  }
  if (score > FADED_MAX) {
    return { dir: 'neg', phase: 'fade', w: clampPct(Math.abs(score) / Math.abs(FADED_MAX)) };
  }
  // score <= -5: delete ballot rebased so -5→-15 maps 0%→100%.
  const span = Math.abs(DELETE_AT) - Math.abs(FADED_MAX);
  return {
    dir: 'neg',
    phase: 'delete',
    w: clampPct((Math.abs(score) - Math.abs(FADED_MAX)) / span),
  };
}

export function proposedBar(miniScore: number): Bar {
  const dir: BarDir = miniScore > 0 ? 'pos' : miniScore < 0 ? 'neg' : null;
  return { dir, phase: dir === 'pos' ? 'up' : 'fade', w: clampPct(Math.abs(miniScore) / PROPOSED_SATURATION) };
}
