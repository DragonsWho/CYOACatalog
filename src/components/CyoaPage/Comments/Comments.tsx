// Comment thread for a game page (replaced `react-comments-section`). Top-level comments paginated
// (Reddit-style "Load more") so hundreds of roots or one giant "story in the comments" can't hang
// the page; replies fetched in bulk and nested client-side (any depth, markdown). Logged-out
// visitors can read; only the input requires login.

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

// Walk up from a target comment to its top-level root and the ancestor chain. All replies are
// loaded in bulk, so the chain is known even if the root's page isn't loaded.
function ancestryOf(
  targetId: string,
  roots: Comment[],
  replies: Comment[],
): { rootId: string; ancestorIds: Set<string> } | null {
  const byId = new Map<string, Comment>();
  for (const c of roots) byId.set(c.id, c);
  for (const c of replies) byId.set(c.id, c);
  // Replies are all loaded, so a target missing from the maps can only be an unloaded top-level
  // comment (a later page) — it is its own root.
  if (!byId.has(targetId)) return { rootId: targetId, ancestorIds: new Set() };

  const ancestorIds = new Set<string>();
  let node: Comment | undefined = byId.get(targetId);
  let rootId = targetId;
  while (node && node.parent) {
    ancestorIds.add(node.parent);
    rootId = node.parent;
    node = byId.get(node.parent);
  }
  return { rootId, ancestorIds };
}

export default function Comments({ game }: { game: Game }) {
  const { user, isModerator } = useContext(AuthContext);
  const theme = useTheme();

  const [roots, setRoots] = useState<Comment[]>([]);
  const [replies, setReplies] = useState<Comment[]>([]);
  const [rootsTotal, setRootsTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('new');
  // Filter chips (All / Comments / Builds): a server-side condition on the root query, so each tab
  // paginates its own kind honestly.
  const [filter, setFilter] = useState<ThreadFilter>('all');
  // Root counts for chips, independent of which tab's pages are loaded.
  const [counts, setCounts] = useState<{ roots: number; buildRoots: number }>({
    roots: 0,
    buildRoots: 0,
  });
  // The viewer's builds for this game — private ones render in the pinned MyBuilds strip (public
  // ones are comments in the wall).
  const [myBuilds, setMyBuilds] = useState<Build[]>([]);
  const [expandPath, setExpandPath] = useState<Set<string>>(new Set());
  // Seed text for the composer (e.g. "@moderator …" from "Call a moderator"); bumping the key
  // remounts the form. pendingModKind tags the next top-level post so the Go ticket gets the right
  // kind.
  const [seed, setSeed] = useState('');
  const [seedKey, setSeedKey] = useState(0);
  const [pendingModKind, setPendingModKind] = useState<string | null>(null);
  // Ids the viewer liked (one id-only query, lets us strip the full `likes` array from the main
  // payload). Empty when logged out.
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  // One-off confirmation after a @moderator summon so the user sees a ticket opened.
  const [modCalled, setModCalled] = useState(false);
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Navigation (location.key + hash) we already jumped for.
  const jumpedToRef = useRef<string | null>(null);
  // Reload the thread on user CHANGE, not object identity: authRefresh on tab return yields a new
  // object with the same data, and depending on it reset the thread to a spinner along with open
  // reply/edit forms (typed text lost).
  const userId = user?.id ?? null;

  // (Re)load replies plus the first `page` pages of roots in one go — on mount, sort change and
  // after any mutation so the view stays whole.
  const reload = useCallback(
    async (pages: number) => {
      setError(null);
      try {
        const [rootsRes, repliesRes, liked, rootCounts, mine] = await Promise.all([
          fetchTopLevel(game.id, sort, 1, PER_PAGE * pages, filter),
          fetchReplies(game.id),
          userId ? fetchMyLikedIds(game.id, userId) : Promise.resolve(new Set<string>()),
          fetchRootCounts(game.id),
          userId ? fetchMyBuilds(game.id).catch(() => [] as Build[]) : Promise.resolve([] as Build[]),
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
    [game.id, sort, filter, userId],
  );

  useEffect(() => {
    setLoading(true);
    setPage(1);
    void reload(1);
  }, [reload]);

  // ?call=mod: prefill the composer with the @moderator summon, focus and scroll. The param is
  // consumed so refresh/back doesn't re-trigger.
  useEffect(() => {
    if (searchParams.get('call') !== 'mod') return;
    if (user) {
      const kind = searchParams.get('kind');
      setSeed(seedForKind(kind));
      setPendingModKind(kind);
      setSeedKey((k) => k + 1);
    }
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

  // With a #comment-<id> hash make sure it's in the DOM: pull in its root if not loaded, mark
  // ancestors for force-expansion. The scroll effect below then fires.
  useEffect(() => {
    if (loading) return;
    const m = location.hash.match(/^#comment-([a-zA-Z0-9]+)$/);
    if (!m) return;
    const path = ancestryOf(m[1], roots, replies);
    if (!path) return;
    // Same ancestor set → keep the previous Set: a new reference re-ran the scroll effect and the
    // page jumped to the comment again.
    setExpandPath((prev) =>
      prev.size === path.ancestorIds.size && [...path.ancestorIds].every((id) => prev.has(id))
        ? prev
        : path.ancestorIds,
    );
    if (!roots.some((r) => r.id === path.rootId)) {
      let cancelled = false;
      fetchComment(path.rootId)
        .then((rec) => {
          if (!cancelled) {
            setRoots((prev) => (prev.some((p) => p.id === rec.id) ? prev : [...prev, rec]));
          }
        })
        .catch(() => {
        });
      return () => {
        cancelled = true;
      };
    }
  }, [loading, location.hash, roots, replies]);

  // Scroll to and highlight the hashed comment (e.g. from a notification at
  // /game/<id>#comment-<id>). Retried a few times since the thread renders async. Comments on an
  // unloaded page or inside a collapsed deep thread won't be found — acceptable. Jump ONCE per
  // navigation: the hash stays in the URL, and any re-render (Load more, refresh after submit)
  // dragged the user back mid-reply.
  useEffect(() => {
    if (loading) return;
    const m = location.hash.match(/^#comment-([a-zA-Z0-9]+)$/);
    if (!m) {
      jumpedToRef.current = null;
      return;
    }
    const nav = `${location.key}:${location.hash}`;
    if (jumpedToRef.current === nav) return;
    const id = `comment-${m[1]}`;
    let done = false;
    const timers = [0, 150, 400, 800, 1300].map((delay) =>
      window.setTimeout(() => {
        if (done) return;
        const el = document.getElementById(id);
        if (!el) return;
        done = true;
        // Mark only an actual jump: if not rendered yet, the next render retries.
        jumpedToRef.current = nav;
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
  }, [loading, location.hash, location.key, roots.length, expandPath]);

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

  // A build posted from the in-game cheat menu creates a comment via the Go endpoint (not this
  // component) — refresh when it fires.
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
      // A ticket opens whenever the comment summons a moderator — via the guided menu
      // (pendingModKind) or typed @moderator.
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

  // Pin targets only top-level comments (one boolean), so patch `roots` in place instead of
  // `refresh()` (which re-fetches 5 collections incl. the entire unpaginated replies list). Re-sort
  // afterwards to mirror the server's `-pinned,...`; Array.sort is stable.
  const handlePin = useCallback(async (id: string, pinned: boolean) => {
    await pinComment(id, pinned);
    setRoots((prev) =>
      prev
        .map((c) => (c.id === id ? { ...c, pinned } : c))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned)),
    );
  }, []);

  // Re-derived only on roots/replies change: popular threads are hundreds of roots + thousands of
  // replies and buildThread allocates a node per comment.
  const tree = useMemo(() => buildThread(roots, replies), [roots, replies]);
  // Header/chip counts use the filter-independent root counts (rootsTotal tracks the ACTIVE tab and
  // drives its pagination). Replies are never builds.
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
        mt: 3,
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

      {/* Filter chips shown only once the thread mixes builds and comments. */}
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
            draftKey={`new.${game.id}`}
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
