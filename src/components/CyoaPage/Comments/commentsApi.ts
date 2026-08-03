// Data layer for the comment thread.
//
// Reads: one flat fetch of every comment for a game (sorted oldest-first);
// the tree is assembled client-side from the `parent` field, so arbitrary
// nesting depth and timestamps come for free.
//
// Every write goes through a Go endpoint — the comments collection is locked to
// clients (create/update/delete = superusers only), so the only direct client
// access is reading and the like toggle. Go runs with app context and bypasses
// the collection rules, re-checking author/moderator itself.
//   - create/reply  -> POST /api/custom/comments         (sets author, links parent/children, bumps count)
//   - edit          -> POST /api/custom/comments/edit     (author only; content only)
//   - delete        -> POST /api/custom/comments/delete   (author OR moderator; tombstones comments that still have replies)
//   - like          -> POST /api/custom/comments/{id}/like (toggle)

import { ListResult } from 'pocketbase';
import { Comment, commentsCollection, pb, User, authedFetch } from '../../../pocketbase/pocketbase';
import { BUILD_MARKER } from './buildComment';
import { analytics } from '../../../utils/analytics';

export type CommentNodeData = Comment & { replies: CommentNodeData[] };
export type SortMode = 'new' | 'old' | 'top';
// Thread filter: everything, plain comments only, or build posts only. Builds
// are always top-level (the cheat bridge never posts them as replies), so the
// filter is a server-side condition on the ROOT query — pagination stays honest
// per tab instead of fishing for builds across client pages.
export type ThreadFilter = 'all' | 'comments' | 'builds';

const FILTER_EXPR: Record<ThreadFilter, string> = {
  all: '',
  comments: ` && content !~ "${BUILD_MARKER}"`,
  builds: ` && content ~ "${BUILD_MARKER}"`,
};

// Whitelist of fields actually rendered — keeps the `likes` and `children`
// relation arrays (potentially huge) and unused author fields (email,
// blocked_tags, …) out of every comment payload. The author expand is trimmed
// to just what avatar/name/mod-badge need. `liked` state is fetched separately
// (fetchMyLikedIds) so the full likes array never crosses the wire.
const COMMENT_FIELDS =
  'id,content,author,parent,created,updated,deleted,pinned,kind,likes_count,' +
  'expand.author.id,expand.author.collectionId,expand.author.collectionName,' +
  'expand.author.username,expand.author.name,expand.author.avatar,expand.author.isModerator';

/**
 * One page of top-level comments (those with no parent), sorted newest/oldest.
 * Threads are paginated by their roots so a single huge top-level "story" can't
 * force the whole catalog of replies to load at once.
 */
export async function fetchTopLevel(
  gameId: string,
  sort: SortMode,
  page: number,
  perPage: number,
  filter: ThreadFilter = 'all',
): Promise<ListResult<Comment>> {
  return commentsCollection.getList(page, perPage, {
    filter: `game = "${gameId}" && parent = ""${FILTER_EXPR[filter]}`,
    expand: 'author',
    fields: COMMENT_FIELDS,
    // Pinned comments float to the very top regardless of the chosen order.
    sort: SORT_EXPR[sort],
  });
}

/**
 * Root counts for the filter chips: how many top-level posts are builds vs
 * everything. Two 1-item queries (totalItems only) so the counts stay correct
 * whichever tab's page window is actually loaded.
 */
export async function fetchRootCounts(
  gameId: string,
): Promise<{ roots: number; buildRoots: number }> {
  const opts = { fields: 'id', skipTotal: false } as const;
  const [all, builds] = await Promise.all([
    commentsCollection.getList(1, 1, { ...opts, filter: `game = "${gameId}" && parent = ""` }),
    commentsCollection.getList(1, 1, {
      ...opts,
      filter: `game = "${gameId}" && parent = ""${FILTER_EXPR.builds}`,
    }),
  ]);
  return { roots: all.totalItems, buildRoots: builds.totalItems };
}

// Sort expressions for the top-level query. Pinned always floats to the top;
// "top" then orders by like count (most-liked first), newest as the tiebreak.
const SORT_EXPR: Record<SortMode, string> = {
  new: '-pinned,-created',
  old: '-pinned,created',
  top: '-pinned,-likes_count,-created',
};

/**
 * Every reply (non top-level comment) for the game, oldest-first. Replies are
 * usually a small minority, so they're fetched in one shot and attached to
 * whichever roots are currently loaded; replies under not-yet-loaded roots are
 * simply left out of the tree until their root pages in.
 */
export async function fetchReplies(gameId: string): Promise<Comment[]> {
  return commentsCollection.getFullList({
    filter: `game = "${gameId}" && parent != ""`,
    expand: 'author',
    fields: COMMENT_FIELDS,
    sort: 'created',
  });
}

/** A single comment by id (used to pull in a deep-linked root that the current
 *  page of top-level comments hasn't loaded yet). */
export async function fetchComment(id: string): Promise<Comment> {
  return commentsCollection.getOne(id, { expand: 'author', fields: COMMENT_FIELDS });
}

/**
 * Ids of the comments (for one game) that the given user has liked. A tiny
 * id-only query so the heavy `likes` relation array can be stripped from the
 * main comment payloads while still rendering "you liked this".
 */
export async function fetchMyLikedIds(gameId: string, userId: string): Promise<Set<string>> {
  const rows = await commentsCollection.getFullList({
    filter: `game = "${gameId}" && likes ~ "${userId}"`,
    fields: 'id',
  });
  return new Set(rows.map((r) => r.id));
}

/** Extract the server's human-readable message from a failed JSON response. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
  } catch {
    /* not JSON — use fallback */
  }
  return fallback;
}

export async function postComment(
  gameId: string,
  content: string,
  parentId?: string,
  modKind?: string,
): Promise<void> {
  const res = await authedFetch('/api/custom/comments', {
    method: 'POST',
    body: JSON.stringify({ game_id: gameId, parent_id: parentId, content, mod_kind: modKind }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to post comment (${res.status})`));
  }
  analytics.commentPost({ game_id: gameId, is_reply: !!parentId });
}

export async function editComment(commentId: string, content: string): Promise<void> {
  // Goes through Go (not a raw PB update) because comments.updateRule is locked:
  // only `content` may change, and only by the author.
  const res = await authedFetch('/api/custom/comments/edit', {
    method: 'POST',
    body: JSON.stringify({ comment_id: commentId, content }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to edit comment (${res.status})`));
  }
}

export async function deleteComment(commentId: string): Promise<void> {
  const res = await authedFetch('/api/custom/comments/delete', {
    method: 'POST',
    body: JSON.stringify({ comment_id: commentId }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to delete comment (${res.status})`));
  }
}

/** Toggle the caller's like on a comment. Returns the new state and total. */
export async function toggleCommentLike(
  commentId: string,
): Promise<{ state: boolean; count: number }> {
  const res = await authedFetch(`/api/custom/comments/${commentId}/like`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to like comment (${res.status})`));
  }
  const body = await res.json();
  analytics.commentLike({ active: !!body.state });
  return { state: !!body.state, count: typeof body.count === 'number' ? body.count : 0 };
}

/** Pin or unpin a top-level comment (moderators only). */
export async function pinComment(commentId: string, pinned: boolean): Promise<void> {
  const res = await authedFetch('/api/custom/comments/pin', {
    method: 'POST',
    body: JSON.stringify({ comment_id: commentId, pinned }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to pin comment (${res.status})`));
  }
}

/**
 * Assemble the tree from a (pre-sorted, pre-paginated) list of root comments and
 * the full set of replies. Root order is preserved as given; replies arrive
 * oldest-first so each parent's children stay chronological. Replies whose
 * ancestor root isn't loaded are dropped (not promoted to top level).
 */
export function buildThread(roots: Comment[], replies: Comment[]): CommentNodeData[] {
  const nodes = new Map<string, CommentNodeData>();
  const rootNodes = roots.map((c) => {
    const n: CommentNodeData = { ...c, replies: [] };
    nodes.set(c.id, n);
    return n;
  });
  for (const r of replies) nodes.set(r.id, { ...r, replies: [] });
  for (const r of replies) {
    const parent = r.parent ? nodes.get(r.parent) : undefined;
    if (parent) parent.replies.push(nodes.get(r.id)!);
  }
  return rootNodes;
}

/** A comment that was deleted but kept (flagged) to preserve its reply thread. */
export function isTombstone(comment: Comment): boolean {
  return comment.deleted === true;
}

/** Avatar image URL for a user, or undefined to fall back to initials. */
export function avatarUrl(user?: User): string | undefined {
  if (user?.avatar) return pb.files.getURL(user, user.avatar, { thumb: '100x100' });
  return undefined;
}

/**
 * Deterministic avatar colour for a user — used for the initials drawn on the
 * faint dark avatar circle (the letters are the "colour spot", old-prod style).
 * Stable per user (hashed from id/username) and light enough to read on a dark
 * background.
 */
export function avatarColor(user?: User): string {
  const key = user?.id || user?.username || 'anon';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 64%)`;
}

export function displayName(user?: User): string {
  return user?.name || user?.username || 'Anonymous';
}

/** Two-letter initials for the avatar fallback (e.g. "Dragon's Whore" -> "DW"). */
export function initials(user?: User): string {
  const name = displayName(user).trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
