// Tag voting data layer. Every write goes through one Go endpoint (game_tag_votes create/update
// locked to the backend; games.updateRule moderator-only). The server enforces users only
// add/remove THEMSELVES from a vote and performs privileged activation (appending to games.tags
// past the threshold) under app context.
// - upvote/downvote/clear → POST /api/custom/tag-vote
// One click cycles up → down → clear. Proposed tags (reserved low band) run -5..+5: +5 promotes
// onto the game at neutral 0, -5 (or no support) drops it. Accepted tags use up - down; -15 removes
// the tag.

import { GameTagVote, authedFetch } from '../../pocketbase/pocketbase';
import { analytics } from '../../utils/analytics';

export type TagVoteAction = 'upvote' | 'downvote' | 'clear';

export type TagVoteResult = {
  // Updated vote, or null if the proposal was dropped (no supporters left).
  vote: GameTagVote | null;
  // True when this call promoted a proposed tag into games.tags.
  activated: boolean;
  // True when the vote record was removed (abandoned proposal).
  deleted: boolean;
};

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
  } catch {
  }
  return fallback;
}

// Cast/change/withdraw the caller's vote; returns the authoritative state. `modOverride` is the
// explicit "Approve/Remove as moderator": a decision, not weight — with `upvote` the tag goes on at
// neutral 0, with `downvote` it comes off and the ballot drops. Carousel clicks always weigh 1.
// Moderators have no hidden points: `votes` always equals upVoters − downVoters, so a tally never
// silently snaps back.
export async function castTagVote(
  gameId: string,
  tagId: string,
  action: TagVoteAction,
  modOverride?: boolean,
): Promise<TagVoteResult> {
  const res = await authedFetch('/api/custom/tag-vote', {
    method: 'POST',
    body: JSON.stringify({ game_id: gameId, tag_id: tagId, action, mod_override: modOverride === true }),
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
