// Data layer for the comment thread. Reads: flat fetches assembled into a tree client-side from
// `parent`. Every write goes through Go — the comments collection is locked (create/update/delete =
// superusers); clients only read and toggle likes. Go runs with app context, bypasses rules and
// re-checks author/moderator itself.
// - create/reply → POST /api/custom/comments (sets author, links parent/children, bumps count)
// - edit → POST /api/custom/comments/edit (author only; content only)
// - delete → POST /api/custom/comments/delete (author OR moderator; tombstones comments that still
// have replies)
// - like → POST /api/custom/comments/{id}/like (toggle)

import { ListResult } from 'pocketbase';
import { Comment, commentsCollection, pb, User, authedFetch } from '../../../pocketbase/pocketbase';
import { BUILD_MARKER } from './buildComment';
import { analytics } from '../../../utils/analytics';

export type CommentNodeData = Comment & { replies: CommentNodeData[] };
export type SortMode = 'new' | 'old' | 'top';
// Builds are always top-level (the cheat bridge never posts them as replies), so the filter is a
// server-side ROOT condition — honest pagination per tab.
export type ThreadFilter = 'all' | 'comments' | 'builds';

const FILTER_EXPR: Record<ThreadFilter, string> = {
  all: '',
  comments: ` && content !~ "${BUILD_MARKER}"`,
  builds: ` && content ~ "${BUILD_MARKER}"`,
};

// Field whitelist: keeps the `likes`/`children` arrays (potentially huge) and unused author fields
// (email, blocked_tags, …) out of the payload. Author expand trimmed to avatar/name/mod badge.
// `liked` fetched separately (fetchMyLikedIds).
const COMMENT_FIELDS =
  'id,content,author,parent,created,updated,deleted,pinned,kind,likes_count,' +
  'expand.author.id,expand.author.collectionId,expand.author.collectionName,' +
  'expand.author.username,expand.author.name,expand.author.avatar,expand.author.isModerator';

// Threads paginated by roots so one huge top-level "story" can't force all replies to load.
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
    // Pinned comments always first regardless of order.
    sort: SORT_EXPR[sort],
  });
}

// Chip counts: two 1-item queries (totalItems only), correct whichever tab is loaded.
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

// Pinned first; "top" orders by like count, newest as tiebreak.
const SORT_EXPR: Record<SortMode, string> = {
  new: '-pinned,-created',
  old: '-pinned,created',
  top: '-pinned,-likes_count,-created',
};

// Defensive cap for fetchReplies. `getFullList` batches 500 per request (SDK default), not 20, so
// normal threads cost a couple of requests; the cap only matters for outliers, trading "some very
// old replies temporarily missing" for "section finishes loading". buildThread drops replies whose
// root isn't loaded, so a truncated tail is safe.
const MAX_REPLIES = 3000;

// All replies for the game oldest-first in one shot (usually a minority), attached to loaded roots;
// replies under unloaded roots are left out until their root pages in.
export async function fetchReplies(gameId: string): Promise<Comment[]> {
  const res = await commentsCollection.getList(1, MAX_REPLIES, {
    filter: `game = "${gameId}" && parent != ""`,
    expand: 'author',
    fields: COMMENT_FIELDS,
    sort: 'created',
  });
  return res.items;
}

export async function fetchComment(id: string): Promise<Comment> {
  return commentsCollection.getOne(id, { expand: 'author', fields: COMMENT_FIELDS });
}

// Id-only query for liked comments so the heavy `likes` relation can be stripped from main
// payloads.
export async function fetchMyLikedIds(gameId: string, userId: string): Promise<Set<string>> {
  const rows = await commentsCollection.getFullList({
    filter: `game = "${gameId}" && likes ~ "${userId}"`,
    fields: 'id',
  });
  return new Set(rows.map((r) => r.id));
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.message === 'string' && body.message) return body.message;
  } catch {
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
  // Via Go (not raw PB update): comments.updateRule is locked; only `content` may change, only by
  // the author.
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

export async function pinComment(commentId: string, pinned: boolean): Promise<void> {
  const res = await authedFetch('/api/custom/comments/pin', {
    method: 'POST',
    body: JSON.stringify({ comment_id: commentId, pinned }),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to pin comment (${res.status})`));
  }
}

// Root order preserved as given; replies oldest-first so children stay chronological. Replies whose
// root isn't loaded are dropped (not promoted to top level).
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

// Deleted but kept (flagged) to preserve its reply thread.
export function isTombstone(comment: Comment): boolean {
  return comment.deleted === true;
}

export function avatarUrl(user?: User): string | undefined {
  if (user?.avatar) return pb.files.getURL(user, user.avatar, { thumb: '100x100' });
  return undefined;
}

// Deterministic initials color per user (hashed from id/username), light enough on the dark avatar
// circle.
export function avatarColor(user?: User): string {
  const key = user?.id || user?.username || 'anon';
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 64%)`;
}

export function displayName(user?: User): string {
  return user?.name || user?.username || 'Anonymous';
}

export function initials(user?: User): string {
  const name = displayName(user).trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
