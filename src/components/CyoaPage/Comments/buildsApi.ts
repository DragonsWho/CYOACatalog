// Data layer for the `builds` registry (see pocketbase.ts → Build).
//
// Every build — public or private — is one record here; a PUBLIC build is
// additionally mirrored as a comment (the ```cyoa-build fenced block), which
// stays the social body of the build: likes, replies, notifications,
// moderation. The record is the state: it answers "does this user have a build
// for game X" for the cheat gate, the catalog badge and the "My builds" strip
// without substring-searching comment content.
//
// The collection's PB rules are owner-only, so every query below is implicitly
// scoped to the logged-in user — no `user = …` filter needed (and none would
// help: other users' records are invisible by rule).

import { Build, buildsCollection, pb } from '../../../pocketbase/pocketbase';
import { deleteComment, editComment, postComment } from './commentsApi';
import { BUILD_MARKER, MAX_BUILD_COMMENT_LEN, encodeBuildComment, type CheatBuild } from './buildComment';

/**
 * Encode a build's comment body, but fail early with a human-readable message
 * if it exceeds the server's stored-content limit. Without this the post hits
 * the server, trips the `comments.content` maxLength and comes back as an
 * opaque 500 that surfaces to the player as gibberish. Thrown here, the message
 * reaches the cheat shim's error toast instead (see useCheatBridge postBuild).
 */
function encodeBuildCommentChecked(build: CheatBuild): string {
  const body = encodeBuildComment(build);
  if (body.length > MAX_BUILD_COMMENT_LEN) {
    throw new Error(
      'This build is too large to post publicly (too many cards or very long '
      + 'card titles). Remove some selections, or save it as a private build.',
    );
  }
  return body;
}

/** All of the viewer's builds for one game, newest first. */
export async function fetchMyBuilds(gameId: string): Promise<Build[]> {
  if (!pb.authStore.isValid) return [];
  return buildsCollection.getFullList({
    filter: pb.filter('game = {:g}', { g: gameId }),
    sort: '-created',
  });
}

/**
 * Game ids of every build the viewer has (for the catalog "you built this"
 * badge). One id-only query, separate from the anonymous cacheable catalog
 * payload — per-user state must never ride on the shared catalog response.
 */
export async function fetchMyBuiltGameIds(): Promise<Set<string>> {
  if (!pb.authStore.isValid) return new Set();
  const rows = await buildsCollection.getFullList({ fields: 'game' });
  return new Set(rows.map((r) => r.game));
}

/**
 * The cheat gate: does the viewer have ANY build for this game? Checks the
 * registry first; falls back to the legacy marker-in-comment check so builds
 * posted before the registry existed (or not yet backfilled) still unlock.
 */
export async function hasAnyBuild(gameId: string, userId: string): Promise<boolean> {
  try {
    const r = await buildsCollection.getList(1, 1, {
      filter: pb.filter('game = {:g}', { g: gameId }),
      fields: 'id',
    });
    if (r.items.length > 0) return true;
  } catch {
    /* collection missing or unreachable — legacy check below still applies */
  }
  try {
    const r = await pb.collection('comments').getList(1, 1, {
      filter: pb.filter(
        'author = {:u} && game = {:g} && content ~ {:m} && deleted != true',
        { u: userId, g: gameId, m: BUILD_MARKER },
      ),
      fields: 'id',
    });
    return r.items.length > 0;
  } catch {
    return false;
  }
}

export interface SaveBuildOptions {
  gameId: string;
  build: CheatBuild;
  /** Omitted → keep the overwritten build's visibility (public for a new one). */
  isPublic?: boolean;
  /** Save as an additional build instead of overwriting the latest one. */
  forceNew?: boolean;
}

/**
 * Save the player's build: upsert the registry record and keep the public
 * comment-mirror in sync. Default overwrites the latest build for this game
 * (one build per player unless they explicitly opt into another), matching the
 * old comment-upsert behaviour. Publishing a previously-private build posts its
 * comment; re-saving a public one as private deletes the comment (unpublish).
 * Returns the saved record.
 */
export async function saveBuild({ gameId, build, isPublic, forceNew }: SaveBuildOptions): Promise<Build> {
  const existing = forceNew ? null : (await fetchMyBuilds(gameId))[0] ?? null;
  const resolvedPublic = isPublic ?? existing?.public ?? true;

  // Comment-mirror first: if it fails we haven't half-updated the registry.
  let commentId = existing?.comment || '';
  if (resolvedPublic) {
    // Length-check up front (before touching the registry or the thread) so an
    // oversized build fails cleanly with a readable message, not a partial save.
    const body = encodeBuildCommentChecked(build);
    // Records created before the registry (or lost links) may still have a
    // legacy build comment in the thread — update it rather than adding a twin.
    if (!commentId && !forceNew) commentId = await findMyLatestBuildCommentId(gameId);
    if (commentId) {
      try {
        await editComment(commentId, body);
      } catch {
        // The mirror comment is gone (deleted by a moderator or the user):
        // repost instead of failing the whole save.
        commentId = '';
      }
    }
    if (!commentId) {
      await postComment(gameId, body);
      commentId = await findMyLatestBuildCommentId(gameId);
    }
  } else if (commentId) {
    try {
      await deleteComment(commentId);
    } catch {
      /* already gone — fine, we're unpublishing anyway */
    }
    commentId = '';
  }

  const payload = {
    user: pb.authStore.model?.id ?? '',
    game: gameId,
    code: build.code,
    summary: build.summary,
    public: resolvedPublic,
    comment: commentId,
  };
  return existing
    ? buildsCollection.update(existing.id, payload)
    : buildsCollection.create(payload);
}

/** Publish an existing (private) build record: post the comment, flip the flag. */
export async function publishBuild(record: Build): Promise<Build> {
  await postComment(record.game, encodeBuildCommentChecked({ code: record.code, summary: record.summary }));
  const commentId = await findMyLatestBuildCommentId(record.game);
  return buildsCollection.update(record.id, { public: true, comment: commentId });
}

/** Delete a build record and, if it was public, its comment-mirror. */
export async function deleteBuild(record: Build): Promise<void> {
  if (record.comment) {
    try {
      await deleteComment(record.comment);
    } catch {
      /* comment already gone */
    }
  }
  await buildsCollection.delete(record.id);
}

// Comments are created via the Go endpoint, which doesn't return the new id —
// so after posting a build comment we look our newest one up to link it.
async function findMyLatestBuildCommentId(gameId: string): Promise<string> {
  const uid = pb.authStore.model?.id;
  if (!uid) return '';
  try {
    const r = await pb.collection('comments').getList(1, 1, {
      filter: pb.filter(
        'author = {:u} && game = {:g} && content ~ {:m} && deleted != true',
        { u: uid, g: gameId, m: BUILD_MARKER },
      ),
      fields: 'id',
      sort: '-created',
    });
    return r.items[0]?.id ?? '';
  } catch {
    return '';
  }
}
