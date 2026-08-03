// Data layer for tag voting.
//
// Every write goes through one Go endpoint — game_tag_votes create/update is
// locked to the backend (clients only read), and games.updateRule is
// moderator-only. The server enforces that a user can only add/remove
// THEMSELVES from a vote (no rigging someone else's upVoters) and performs the
// privileged activation (appending the tag to games.tags once a proposal
// crosses the threshold) under app context.
//
//   - upvote/downvote/clear -> POST /api/custom/tag-vote
//
// A vote is one click cycling up → down → clear. "Proposed" tags (votes in the
// reserved low band) run a small -5..+5 ballot: +5 promotes the tag onto the game
// at a neutral 0, -5 (or losing all support) drops it server-side. Accepted tags
// use up - down directly; -20 removes the tag from the game.

import { GameTagVote, authedFetch } from '../../pocketbase/pocketbase';
import { analytics } from '../../utils/analytics';

export type TagVoteAction = 'upvote' | 'downvote' | 'clear';

export type TagVoteResult = {
  /** Updated vote, or null if the proposal was dropped (no supporters left). */
  vote: GameTagVote | null;
  /** True when this call promoted a proposed tag into games.tags. */
  activated: boolean;
  /** True when the vote record was removed (abandoned proposal). */
  deleted: boolean;
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
  } catch {
    /* not JSON — use fallback */
  }
  return fallback;
}

/**
 * Cast (or change/withdraw) the caller's vote on a (game, tag) pair. Returns the
 * server's authoritative vote state so callers can replace their local copy.
 */
export async function castTagVote(
  gameId: string,
  tagId: string,
  action: TagVoteAction,
): Promise<TagVoteResult> {
  const res = await authedFetch('/api/custom/tag-vote', {
    method: 'POST',
    body: JSON.stringify({ game_id: gameId, tag_id: tagId, action }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to vote on tag (${res.status})`));
  }
  const body = await res.json();
  analytics.tagVote({ game_id: gameId, tag_id: tagId, action });
  return {
    vote: (body.vote ?? null) as GameTagVote | null,
    activated: !!body.activated,
    deleted: !!body.deleted,
  };
}
