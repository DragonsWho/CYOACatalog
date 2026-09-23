// Data layer for the `builds` registry (pocketbase.ts → Build). Every build (public or private) is
// one record; a PUBLIC build is also mirrored as a comment (fenced ```cyoa-build block) that stays
// its social body (likes, replies, notifications, moderation). The record is the state: it answers
// "does this user have a build for game X" for the cheat gate, catalog badge and My builds strip
// without substring-searching comments. PB rules are owner-only, so every query is implicitly
// scoped to the logged-in user (a `user = …` filter isn't needed and wouldn't help).

import { Build, buildsCollection, pb } from '../../../pocketbase/pocketbase';
import { deleteComment, editComment, postComment } from './commentsApi';
import { BUILD_MARKER, MAX_BUILD_COMMENT_LEN, encodeBuildComment, type CheatBuild } from './buildComment';

// Fail early with a readable message if the body exceeds the server content limit; otherwise
// `comments.content` maxLength trips and returns an opaque 500. Thrown here, the message reaches
// the shim's error toast (useCheatBridge postBuild).
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

export async function fetchMyBuilds(gameId: string): Promise<Build[]> {
  if (!pb.authStore.isValid) return [];
  return buildsCollection.getFullList({
    filter: pb.filter('game = {:g}', { g: gameId }),
    sort: '-created',
  });
}

// Game ids of all the viewer's builds (catalog "you built this" badge). Id-only query separate from
// the anonymous cacheable catalog — per-user state must never ride the shared catalog response.
export async function fetchMyBuiltGameIds(): Promise<Set<string>> {
  if (!pb.authStore.isValid) return new Set();
  const rows = await buildsCollection.getFullList({ fields: 'game' });
  return new Set(rows.map((r) => r.game));
}

// Cheat gate: any build for this game? Registry first; falls back to the legacy marker-in-comment
// check so builds before the registry (or not backfilled) still unlock.
export async function hasAnyBuild(gameId: string, userId: string): Promise<boolean> {
  try {
    const r = await buildsCollection.getList(1, 1, {
      filter: pb.filter('game = {:g}', { g: gameId }),
      fields: 'id',
    });
    if (r.items.length > 0) return true;
  } catch {
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
  isPublic?: boolean;
  forceNew?: boolean;
}

// Upsert the registry record and keep the public comment mirror in sync. Default overwrites the
// latest build for this game (one per player unless opted into another). Publishing a private build
// posts its comment; re-saving a public one as private deletes the comment.
export async function saveBuild({ gameId, build, isPublic, forceNew }: SaveBuildOptions): Promise<Build> {
  const existing = forceNew ? null : (await fetchMyBuilds(gameId))[0] ?? null;
  const resolvedPublic = isPublic ?? existing?.public ?? true;

  // Comment mirror first: if it fails the registry isn't half-updated.
  let commentId = existing?.comment || '';
  if (resolvedPublic) {
    // Length check up front so an oversized build fails cleanly, not as a partial save.
    const body = encodeBuildCommentChecked(build);
    // Pre-registry records (or lost links) may still have a legacy build comment — update it rather
    // than add a twin.
    if (!commentId && !forceNew) commentId = await findMyLatestBuildCommentId(gameId);
    if (commentId) {
      try {
        await editComment(commentId, body);
      } catch {
        // Mirror comment gone (deleted by moderator/user): repost instead of failing the save.
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

export async function publishBuild(record: Build): Promise<Build> {
  await postComment(record.game, encodeBuildCommentChecked({ code: record.code, summary: record.summary }));
  const commentId = await findMyLatestBuildCommentId(record.game);
  return buildsCollection.update(record.id, { public: true, comment: commentId });
}

export async function deleteBuild(record: Build): Promise<void> {
  if (record.comment) {
    try {
      await deleteComment(record.comment);
    } catch {
    }
  }
  await buildsCollection.delete(record.id);
}

// The Go comment endpoint doesn't return the new id — look up our newest one to link it.
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
