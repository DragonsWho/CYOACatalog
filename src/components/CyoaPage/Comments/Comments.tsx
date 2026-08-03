// Comment thread for a game page.
//
// Replaces the old `react-comments-section` integration. Top-level comments are
// paginated (Reddit-style "Load more") so a thread with hundreds of roots — or
// one giant "story in the comments" — can't hang the page; replies are fetched
// in bulk and nested client-side (arbitrary depth, real timestamps, markdown).
// Logged-out visitors can read; only the input is gated behind login.

import { useCallback, useContext, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Link as MuiLink,
  MenuItem,
  Select,
  Snackbar,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';
import { useTheme } from '@mui/material/styles';
import { AuthContext, Build, Comment, Game } from '../../../pocketbase/pocketbase';
import {
  buildThread,
  deleteComment,
  editComment,
  fetchComment,
  fetchMyLikedIds,
  fetchReplies,
  fetchRootCounts,
  fetchTopLevel,
  pinComment,
  postComment,
  SortMode,
  ThreadFilter,
} from './commentsApi';
import { fetchMyBuilds } from './buildsApi';
import CommentForm from './CommentForm';
import CommentNode from './CommentNode';
import MyBuilds from './MyBuilds';
import { seedForKind } from '../../Moderation/modKinds';
import { BUILD_POSTED_EVENT } from '../../../utils/cheat';

const PER_PAGE = 20;

// Walk up from a target comment (using every loaded root + reply) to find its
// top-level root and the chain of ancestors between them. All replies are loaded
// in bulk, so the chain is fully known even when the root's page isn't loaded.
function ancestryOf(
  targetId: string,
  roots: Comment[],
  replies: Comment[],
): { rootId: string; ancestorIds: Set<string> } | null {
  const byId = new Map<string, Comment>();
  for (const c of roots) byId.set(c.id, c);
  for (const c of replies) byId.set(c.id, c);
  // Replies are all loaded in bulk, so a target missing from the maps can only be
  // an unloaded top-level comment (a later "Load more" page) — it is its own root.
  if (!byId.has(targetId)) return { rootId: targetId, ancestorIds: new Set() };

  const ancestorIds = new Set<string>();
  let node: Comment | undefined = byId.get(targetId);
  let rootId = targetId;
  while (node && node.parent) {
    ancestorIds.add(node.parent);
    rootId = node.parent;
    node = byId.get(node.parent); // undefined once we reach the (unloaded) root
  }
  return { rootId, ancestorIds };
}

export default function Comments({ game }: { game: Game }) {
  const { user, isModerator } = useContext(AuthContext);
  const theme = useTheme();

  const [roots, setRoots] = useState<Comment[]>([]);
  const [replies, setReplies] = useState<Comment[]>([]);
  const [rootsTotal, setRootsTotal] = useState(0);
  const [page, setPage] = useState(1); // how many pages of roots are loaded
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('new');
  // Thread filter chips (All / Comments / Builds). A server-side condition on
  // the root query, so each tab paginates its own kind honestly.
  const [filter, setFilter] = useState<ThreadFilter>('all');
  // Root counts for the chips, independent of which tab's pages are loaded.
  const [counts, setCounts] = useState<{ roots: number; buildRoots: number }>({
    roots: 0,
    buildRoots: 0,
  });
  // The viewer's builds registry records for this game — the private ones render
  // in the pinned MyBuilds strip (public ones live in the wall as comments).
  const [myBuilds, setMyBuilds] = useState<Build[]>([]);
  // Ancestor comment ids that must be force-expanded so a deep-linked comment is
  // actually rendered (overrides the auto-collapse of deep threads).
  const [expandPath, setExpandPath] = useState<Set<string>>(new Set());
  // Seed text for the new-comment box (e.g. an "@moderator …" template when
  // arriving from the "Call a moderator" menu); bumping the key remounts the
  // form with it. pendingModKind tags the next top-level post so the Go ticket
  // gets the right kind.
  const [seed, setSeed] = useState('');
  const [seedKey, setSeedKey] = useState(0);
  const [pendingModKind, setPendingModKind] = useState<string | null>(null);
  // Ids of comments the viewer has liked (one tiny id-only query; lets us strip
  // the full `likes` array from the main payload). Empty when logged out.
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  // One-off confirmation after a @moderator summon, so the user sees their
  // report actually opened a ticket (not just another comment).
  const [modCalled, setModCalled] = useState(false);
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  // (Re)load replies plus the first `page` pages of roots in one query. Used on
  // mount, on sort change and after any mutation so the current view stays whole.
  const reload = useCallback(
    async (pages: number) => {
      setError(null);
      try {
        const [rootsRes, repliesRes, liked, rootCounts, mine] = await Promise.all([
          fetchTopLevel(game.id, sort, 1, PER_PAGE * pages, filter),
          fetchReplies(game.id),
          user ? fetchMyLikedIds(game.id, user.id) : Promise.resolve(new Set<string>()),
          fetchRootCounts(game.id),
          user ? fetchMyBuilds(game.id).catch(() => [] as Build[]) : Promise.resolve([] as Build[]),
        ]);
        setRoots(rootsRes.items);
        setRootsTotal(rootsRes.totalItems);
        setReplies(repliesRes);
        setLikedIds(liked);
        setCounts(rootCounts);
        setMyBuilds(mine);
      } catch {
        setError('Failed to load comments.');
      } finally {
        setLoading(false);
      }
    },
    [game.id, sort, filter, user],
  );

  useEffect(() => {
    setLoading(true);
    setPage(1);
    void reload(1);
  }, [reload]);

  // "Call a moderator" arrives as ?call=mod: prefill the composer with the
  // @moderator summon, focus it and scroll there. The param is consumed so a
  // refresh or back-navigation doesn't re-trigger it.
  useEffect(() => {
    if (searchParams.get('call') !== 'mod') return;
    if (user) {
      const kind = searchParams.get('kind');
      setSeed(seedForKind(kind));
      setPendingModKind(kind);
      setSeedKey((k) => k + 1);
    }
    // Scroll to the composer (or the login CTA for logged-out visitors).
    window.setTimeout(() => {
      document
        .getElementById('comment-form')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 120);
    const next = new URLSearchParams(searchParams);
    next.delete('call');
    next.delete('kind');
    setSearchParams(next, { replace: true });
  }, [searchParams, user, setSearchParams]);

  // When a #comment-<id> hash is present, make sure that comment is actually in
  // the DOM: pull in its top-level root if the current page hasn't loaded it, and
  // mark its ancestors for force-expansion. The scroll effect below then fires.
  useEffect(() => {
    if (loading) return;
    const m = location.hash.match(/^#comment-([a-zA-Z0-9]+)$/);
    if (!m) return;
    const path = ancestryOf(m[1], roots, replies);
    if (!path) return;
    setExpandPath(path.ancestorIds);
    if (!roots.some((r) => r.id === path.rootId)) {
      let cancelled = false;
      fetchComment(path.rootId)
        .then((rec) => {
          if (!cancelled) {
            setRoots((prev) => (prev.some((p) => p.id === rec.id) ? prev : [...prev, rec]));
          }
        })
        .catch(() => {
          /* gone or unreachable — leave the user at the comments section */
        });
      return () => {
        cancelled = true;
      };
    }
  }, [loading, location.hash, roots, replies]);

  // Scroll to (and briefly highlight) the comment named in the URL hash, e.g.
  // arriving from a notification at /game/<id>#comment-<id>. Retried a few times
  // because the thread renders asynchronously after the page mounts. Comments on
  // a not-yet-loaded "Load more" page or inside a collapsed deep thread won't be
  // found — acceptable for now; we just leave the user at the comments section.
  useEffect(() => {
    if (loading) return;
    const m = location.hash.match(/^#comment-([a-zA-Z0-9]+)$/);
    if (!m) return;
    const id = `comment-${m[1]}`;
    let done = false;
    const timers = [0, 150, 400, 800, 1300].map((delay) =>
      window.setTimeout(() => {
        if (done) return;
        const el = document.getElementById(id);
        if (!el) return;
        done = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'background-color 0.5s ease';
        el.style.backgroundColor = 'rgba(124,160,255,0.16)';
        window.setTimeout(() => {
          el.style.backgroundColor = '';
        }, 1800);
      }, delay),
    );
    return () => {
      done = true;
      timers.forEach(window.clearTimeout);
    };
  }, [loading, location.hash, roots.length, expandPath]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const next = page + 1;
      const res = await fetchTopLevel(game.id, sort, next, PER_PAGE, filter);
      setRoots((prev) => [...prev, ...res.items]);
      setRootsTotal(res.totalItems);
      setPage(next);
    } catch {
      setError('Failed to load more comments.');
    } finally {
      setLoadingMore(false);
    }
  }, [game.id, sort, filter, page]);

  const refresh = useCallback(() => reload(page), [reload, page]);

  // A build posted from the in-game cheat menu creates a comment via the Go
  // endpoint (not through this component), so refresh the thread when it fires.
  useEffect(() => {
    const onPosted = (e: Event) => {
      const detail = (e as CustomEvent).detail as { gameId?: string } | undefined;
      if (!detail || detail.gameId === game.id) void refresh();
    };
    window.addEventListener(BUILD_POSTED_EVENT, onPosted);
    return () => window.removeEventListener(BUILD_POSTED_EVENT, onPosted);
  }, [game.id, refresh]);

  const handleNew = useCallback(
    async (text: string) => {
      // A ticket is opened whenever the comment summons a moderator — either via
      // the guided menu (pendingModKind) or by typing @moderator manually.
      const summonsMod = pendingModKind !== null || /(^|[^\w@])@moderators?\b/i.test(text);
      await postComment(game.id, text, undefined, pendingModKind ?? undefined);
      setPendingModKind(null);
      await refresh();
      if (summonsMod) setModCalled(true);
    },
    [game.id, refresh, pendingModKind],
  );

  const handleReply = useCallback(
    async (parentId: string, text: string) => {
      await postComment(game.id, text, parentId);
      await refresh();
    },
    [game.id, refresh],
  );

  const handleEdit = useCallback(
    async (id: string, text: string) => {
      await editComment(id, text);
      await refresh();
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteComment(id);
      await refresh();
    },
    [refresh],
  );

  const handlePin = useCallback(
    async (id: string, pinned: boolean) => {
      await pinComment(id, pinned);
      await refresh();
    },
    [refresh],
  );

  const tree = buildThread(roots, replies);
  // Header/chip counts come from the filter-independent root counts (rootsTotal
  // tracks the ACTIVE tab's total and drives its own pagination). Replies are
  // never builds, so they all count as comments.
  const buildsCount = counts.buildRoots;
  const commentsCount = counts.roots - counts.buildRoots + replies.length;
  const total = counts.roots + replies.length;
  const hasMore = roots.length < rootsTotal;

  const chipSx = (active: boolean) =>
    ({
      height: 24,
      fontSize: '0.78rem',
      bgcolor: active ? 'rgba(210,83,83,0.18)' : 'transparent',
      border: '1px solid',
      borderColor: active ? 'rgba(210,83,83,0.5)' : 'rgba(255,255,255,0.16)',
      color: active ? 'text.primary' : 'text.secondary',
      '&:hover': { bgcolor: active ? 'rgba(210,83,83,0.22)' : 'rgba(255,255,255,0.06)' },
    }) as const;

  return (
    <Box
      sx={{
        mt: 4,
        p: { xs: 2, sm: 3 },
        backgroundColor: theme.custom?.comments?.backgroundColor,
        borderRadius: theme.custom?.comments?.borderRadius,
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h6" sx={{ color: 'text.primary' }}>
          {total} {total === 1 ? 'Comment' : 'Comments'}
        </Typography>
        {total > 1 && (
          <Select
            size="small"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            sx={{ fontSize: '0.85rem', color: 'text.secondary' }}
          >
            <MenuItem value="new">Newest</MenuItem>
            <MenuItem value="old">Oldest</MenuItem>
            <MenuItem value="top">Top</MenuItem>
          </Select>
        )}
      </Stack>

      {/* Filter chips — shown once the thread actually mixes builds and comments. */}
      {buildsCount > 0 && (
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          <Chip label="All" size="small" clickable onClick={() => setFilter('all')} sx={chipSx(filter === 'all')} />
          <Chip
            label={`Comments (${commentsCount})`}
            size="small"
            clickable
            onClick={() => setFilter('comments')}
            sx={chipSx(filter === 'comments')}
          />
          <Chip
            label={`Builds (${buildsCount})`}
            size="small"
            clickable
            onClick={() => setFilter('builds')}
            sx={chipSx(filter === 'builds')}
          />
        </Stack>
      )}

      {user ? (
        <Box id="comment-form">
          <CommentForm
            key={seedKey}
            initialValue={seed}
            autoFocus={seedKey > 0}
            onSubmit={handleNew}
            placeholder="Share your thoughts…"
            submitLabel="Comment"
          />
        </Box>
      ) : (
        <Typography id="comment-form" sx={{ color: 'text.secondary' }}>
          <MuiLink component={RouterLink} to="/login">
            Log in
          </MuiLink>{' '}
          to join the discussion.
        </Typography>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* The viewer's private builds, pinned above the wall (owner-only). */}
      <MyBuilds builds={myBuilds} onChanged={() => void refresh()} />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : tree.length === 0 ? (
        <Typography sx={{ color: 'text.secondary', mt: 3 }}>
          {filter === 'builds'
            ? 'No builds posted yet.'
            : filter === 'comments'
              ? 'No comments yet. Be the first to comment.'
              : 'No comments yet. Be the first to comment.'}
        </Typography>
      ) : (
        <Box sx={{ mt: 2 }}>
          {tree.map((node) => (
            <CommentNode
              key={node.id}
              node={node}
              depth={0}
              rawDepth={0}
              currentUserId={user?.id ?? null}
              isModerator={isModerator}
              expandPath={expandPath}
              likedIds={likedIds}
              onReply={handleReply}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onPin={handlePin}
            />
          ))}

          {hasMore && (
            <Box sx={{ mt: 2, textAlign: 'center' }}>
              <Button
                variant="outlined"
                size="small"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                startIcon={loadingMore ? <CircularProgress size={14} /> : undefined}
              >
                {loadingMore ? 'Loading…' : `Load more comments (${rootsTotal - roots.length})`}
              </Button>
            </Box>
          )}
        </Box>
      )}

      <Snackbar
        open={modCalled}
        autoHideDuration={6000}
        onClose={() => setModCalled(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setModCalled(false)}>
          A moderator has been notified – they’ll reply right here.
        </Alert>
      </Snackbar>
    </Box>
  );
}
