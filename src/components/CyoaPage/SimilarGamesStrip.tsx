// "Similar games" strip under the card. Before it, the game card linked to ZERO other games (6
// links in rendered DOM, none to games — Googlebot render check 2026-09-20): a dead end for readers
// and a crawl break that left 598 URLs as "Discovered, not indexed". Links are real <a href> to
// canonical /game/<slug> (RouterLink), serving both people and bots.
// Data: semantic neighbors first (/api/similar-games/<id>, nearest description vectors + similarity
// %). Many games aren't in the index (404), so fallback: games with shared tags by likes. No % in
// the fallback — a made-up number is worse than none.
// Nothing is hidden from readers for "SEO": what the bot sees, people see. The opposite is
// cloaking, penalized by Google.

import { useEffect, useState } from 'react';
import { Box, Typography, Link, Skeleton, Chip, IconButton, useTheme } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ZoomOutMapIcon from '@mui/icons-material/ZoomOutMap';
import ZoomInMapIcon from '@mui/icons-material/ZoomInMap';
import { Link as RouterLink } from 'react-router-dom';
import {
  Game,
  gamesCollectionPublic,
  gameCanonicalKey,
} from '../../pocketbase/pocketbase';
import { cfImage } from '../../utils/cfImage';
import { getRatingTagIds } from '../../utils/ratingTags';
import type { FilterMode } from '../../types';

// One row of six: a footnote under the game, not a second feed.
const MAX_ITEMS = 6;
// Over-request candidates: the rating filter (sfw/nsfw) drops an unknown number.
const FALLBACK_FETCH_LIMIT = 24;
const THUMB_WIDTH = 320;
// expand.tags.name only to filter nsfw/extreme for the current mode (filterByRating); tags aren't
// shown. Flat `tags` ids rank the fill: more shared tags beats more likes.
const STRIP_FIELDS = 'id,collectionId,slug,title,image,tags,expand.tags.name';

// View preference, site-wide (collapsed on one card = collapsed on the next). ⚠️ Default 'normal'
// matters: crawlers have no localStorage, so bots ALWAYS get the expanded block with all six links.
// Collapsed is a person's browser choice, not what we show search engines — otherwise it'd be
// reverse cloaking.
type StripView = 'collapsed' | 'normal' | 'large';

const VIEW_KEY = 'similarGames.view';

function readView(): StripView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'collapsed' || v === 'normal' || v === 'large') return v;
  } catch {
  }
  return 'normal';
}

function writeView(v: StripView) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
  }
}

type StripGame = Pick<Game, 'id' | 'slug' | 'title' | 'image'> & {
  collectionId?: string;
  tags?: string[];
  expand?: { tags?: { name: string }[] };
};

// Same criterion as the header (nsfwTagId/extremeTagId in SearchPage): tags by name, not id — no
// global tagMap here, only expand on loaded candidates.
function isRestricted(g: StripGame): boolean {
  return (g.expand?.tags ?? []).some((t) => {
    const n = t.name.toLowerCase();
    return n === 'nsfw' || n === 'extreme';
  });
}

// Same sfw/all/nsfw toggle as the rest of the site.
function filterByRating(games: StripGame[], filterMode: FilterMode): StripGame[] {
  if (filterMode === 'sfw') return games.filter((g) => !isRestricted(g));
  if (filterMode === 'nsfw') return games.filter(isRestricted);
  return games;
}

interface StripItem {
  game: StripGame;
  score?: number;
}

interface SimilarApiResult {
  id: string;
  score?: number;
}

interface SimilarApiResponse {
  results?: SimilarApiResult[];
}

function rawURL(game: StripGame): string | null {
  if (!game.image) return null;
  const collectionId = game.collectionId || '5kxdvx071c10s2t';
  return `/api/files/${collectionId}/${game.id}/${game.image}`;
}

function thumbURL(game: StripGame): string | null {
  const raw = rawURL(game);
  return raw ? cfImage(raw, { width: THUMB_WIDTH, quality: 70 }) : null;
}

// Cache of the finished row: costs three requests (semantic + tag fill) and changes rarely (vectors
// on index rebuild, tag fill as the catalog grows). Stored in localStorage for a day. Key includes
// the filter mode: sfw and nsfw are DIFFERENT rows; a shared key would show adult cards to someone
// who disabled them. The cache only speeds things up.
const CACHE_KEY = 'similarGames.cache.v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Storage is shared site-wide and we're a guest: keep a fingerprint of recently viewed cards, not
// all-time history.
const CACHE_MAX_ENTRIES = 80;

interface CacheEntry {
  at: number;
  items: StripItem[];
}

function cacheKey(gameId: string, filterMode: FilterMode): string {
  return `${gameId}|${filterMode}`;
}

function readCacheMap(): Record<string, CacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readCachedItems(gameId: string, filterMode: FilterMode): StripItem[] | null {
  const entry = readCacheMap()[cacheKey(gameId, filterMode)];
  if (!entry || !Array.isArray(entry.items)) return null;
  if (Date.now() - (entry.at ?? 0) > CACHE_TTL_MS) return null;
  // Empty rows aren't cached (writeCachedItems), but an old cache may contain one — treat as a
  // miss.
  return entry.items.length ? entry.items : null;
}

function writeCachedItems(gameId: string, filterMode: FilterMode, items: StripItem[]) {
  // An empty result is almost always a hiccup (semantic down, no tags); caching it for a day would
  // strip the card of the block for a day.
  if (!items.length) return;
  try {
    const map = readCacheMap();
    map[cacheKey(gameId, filterMode)] = { at: Date.now(), items };
    const keys = Object.keys(map);
    if (keys.length > CACHE_MAX_ENTRIES) {
      keys
        .sort((a, b) => (map[a].at ?? 0) - (map[b].at ?? 0))
        .slice(0, keys.length - CACHE_MAX_ENTRIES)
        .forEach((k) => delete map[k]);
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
  // Full storage mustn't break the block: the row is already rendered.
  }
}

// Semantic neighbors; [] on any failure (404 not indexed, embedding service down) — the caller
// decides on fallback. Not trimmed to MAX_ITEMS here: backend caps at top_k and the rating filter
// drops more.
async function fetchSemanticNeighbours(gameId: string): Promise<SimilarApiResult[]> {
  try {
    const res = await fetch(`/api/similar-games/${gameId}`);
    if (!res.ok) return [];
    const data: SimilarApiResponse = await res.json();
    return data.results ?? [];
  } catch {
    return [];
  }
}

export default function SimilarGamesStrip({ game, filterMode }: { game: Game; filterMode: FilterMode }) {
  const theme = useTheme();
  const [items, setItems] = useState<StripItem[] | null>(null);
  const [rawFallback, setRawFallback] = useState<Set<string>>(() => new Set());
  // Read lazily in the initializer, else the first frame renders one view and the next another —
  // the page jerks on every card.
  const [view, setView] = useState<StripView>(readView);

  const applyView = (v: StripView) => {
    setView(v);
    writeView(v);
  };

  // The strip mounts with the page so its skeleton holds the exact height (a fixed placeholder that
  // later grew pushed Comments and the footer down — CLS); the requests wait until it nears the
  // viewport. No skeleton element (collapsed view) → fetch right away, it's one small row.
  const [skeletonEl, setSkeletonEl] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    if (view === 'collapsed' || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    if (!skeletonEl) return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) setNear(true);
    }, { rootMargin: '300px' });
    io.observe(skeletonEl);
    return () => io.disconnect();
  }, [skeletonEl, near, view]);

  useEffect(() => {
    let cancelled = false;

    const cached = readCachedItems(game.id, filterMode);
    setItems(cached);
    if (cached || !near) return;

    (async () => {
      try {
        // Adult tag ids are needed BEFORE the requests: without them the tag fill returns the 20
        // most-liked cards, which in sfw mode are mostly adult — the row silently came out 4
        // instead of 6. A registry failure is tolerable: the name filter below remains.
        const ratingIds = await getRatingTagIds();
        const restrictedTagIds = [ratingIds.nsfw, ratingIds.extreme].filter(
          (id): id is string => Boolean(id),
        );
        // Same conditions as the feed (HomePage.buildFilter): positive "has tag" on the flat field
        // (`tags ~ "id"`, no join), negative via `tags.id != "id"`. Mixing is fine; `tags.id ?=
        // "id"` together with a negation collapses the result.
        const ratingConds: string[] = [];
        if (filterMode === 'sfw') {
          restrictedTagIds.forEach((id) => ratingConds.push(`tags.id != "${id}"`));
        } else if (filterMode === 'nsfw' && restrictedTagIds.length) {
          ratingConds.push(`(${restrictedTagIds.map((id) => `tags ~ "${id}"`).join(' || ')})`);
        }

        const neighbours = await fetchSemanticNeighbours(game.id);
        let found: StripItem[] = [];

        if (neighbours.length > 0) {
          const ids = neighbours.map((n) => n.id);
          const byId = await gamesCollectionPublic.getFullList({
            filter: ids.map((id) => `id="${id}"`).join('||'),
            expand: 'tags',
            fields: STRIP_FIELDS,
          });
          const eligible = filterByRating(byId as unknown as StripGame[], filterMode);
          // PB returns records in its own order — restore similarity order.
          const map = new Map(eligible.map((g) => [g.id, g]));
          found = neighbours
            .map((n): StripItem | null => {
              const g = map.get(n.id);
              return g ? { game: g, score: n.score } : null;
            })
            .filter((x): x is StripItem => x !== null)
            .slice(0, MAX_ITEMS);
        }

        // Game tags minus adult ones as the seed and similarity measure: an NSFW card has "NSFW"
        // first, and in sfw mode the seed would search for exactly what the filter discards.
        const seedTagIds = (game.expand?.tags ?? [])
          .map((t) => t.id)
          .filter((id) => !restrictedTagIds.includes(id));
        const seedTagSet = new Set(seedTagIds);

        // Fill the gap in one request. Exclude the current game here, not via `id != "…"` in the
        // filter: a negation next to a relation condition collapses PB results to empty (see
        // join-trap note). Also exclude already found ones (no duplicate tiles).
        const topUp = async (conds: string[], sort: string) => {
          const res = await gamesCollectionPublic.getList(1, FALLBACK_FETCH_LIMIT, {
            filter: ['hidden != true', ...conds, ...ratingConds].join(' && '),
            sort,
            expand: 'tags',
            fields: STRIP_FIELDS,
            skipTotal: true,
          });
          const alreadyIn = new Set(found.map((x) => x.game.id));
          // Name filter on top of the query isn't paranoia: adult tag ids may not have arrived
          // (getRatingTagIds), then only this filters.
          const pool = filterByRating(res.items as unknown as StripGame[], filterMode)
            .filter((g) => g.id !== game.id && !alreadyIn.has(g.id));
          // PB matches by one shared tag of five, so without re-sorting the most-liked card floated
          // up — "similar" by the word "Interactive". Count overlap and rank higher; ties keep PB
          // order (likes).
          const extra = pool
            .map((g, i) => ({
              g,
              i,
              shared: (g.tags ?? []).filter((id) => seedTagSet.has(id)).length,
            }))
            .sort((a, b) => b.shared - a.shared || a.i - b.i)
            .slice(0, MAX_ITEMS - found.length)
            .map(({ g }) => ({ game: g }));
          found = [...found, ...extra];
        };

        // The rating filter may cut semantic neighbors (or there were none) — fill the shortfall
        // via tags, not only when semantic is empty. Otherwise sfw mode showed 2–3 tiles.
        if (found.length < MAX_ITEMS) {
          // Fallback: shared tags, most-liked first. At most five tags in the query (long relation
          // ORs are slow in PB); ranking below still uses ALL shared tags.
          const tagIds = seedTagIds.slice(0, 5);
          if (tagIds.length > 0) {
            // `tags ~ "id"` compares the flat relation field without a join, so it coexists with
            // the rating negations. `tags.id?="id"` returns the same set but its join breaks them
            // into empty.
            await topUp([`(${tagIds.map((id) => `tags ~ "${id}"`).join(' || ')})`], '-upvotes_count');
          }
        }

        // Last fill: not enough shared tags. The row must be full (it exists for crawling; a broken
        // row looks like a bug). Random order, not top likes: otherwise all such cards link to the
        // same six and the crawl dead-ends there.
        if (found.length < MAX_ITEMS) {
          await topUp([], '@random');
        }

        if (!cancelled) {
          setItems(found);
          // Cache only what's drawn: tag expand was for filtering.
          writeCachedItems(
            game.id,
            filterMode,
            found.map(({ game: g, score }) => ({
              game: { id: g.id, slug: g.slug, title: g.title, image: g.image, collectionId: g.collectionId },
              score,
            })),
          );
        }
      } catch (err) {
        console.error('SimilarGamesStrip:', err);
        if (!cancelled) setItems([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [game.id, game.expand?.tags, filterMode, near]);

  // Same section heading as "Description" (GameDetails): h6, centered, opacity .9.
  const collapsed = view === 'collapsed';

  // The heading is the collapse toggle (chevron shows direction). Next to it a size button: larger
  // tiles (covers are hard to see at a third of a phone screen) vs compact row.
  const heading = (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
        mb: collapsed ? 0 : 1,
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={() => applyView(collapsed ? 'normal' : 'collapsed')}
        aria-expanded={!collapsed}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          background: 'none',
          border: 0,
          p: 0,
          cursor: 'pointer',
          color: theme.palette.text.primary,
          opacity: 0.9,
          '&:hover': { color: theme.palette.primary.main },
        }}
      >
        <Typography variant="h6" component="h2" sx={{ color: 'inherit' }}>
          Similar games
        </Typography>
        <ExpandMoreIcon
          fontSize="small"
          sx={{
            transition: 'transform 0.2s ease',
            transform: collapsed ? 'rotate(-90deg)' : 'none',
          }}
        />
      </Box>
      {!collapsed && (
        <IconButton
          size="small"
          onClick={() => applyView(view === 'large' ? 'normal' : 'large')}
          aria-label={view === 'large' ? 'Smaller tiles' : 'Bigger tiles'}
          title={view === 'large' ? 'Smaller tiles' : 'Bigger tiles'}
          sx={{ color: 'text.secondary', '&:hover': { color: 'primary.main' } }}
        >
          {view === 'large' ? <ZoomInMapIcon fontSize="small" /> : <ZoomOutMapIcon fontSize="small" />}
        </IconButton>
      )}
    </Box>
  );

  // Same grid for skeleton and content — nothing jumps. Normal view on phones: one scrollable row
  // (3 visible, swipe for the rest) — 3×2 took half the screen and hiding links is not allowed
  // (they exist for crawling). Large view wraps into a grid (2 cols phone, 3 desktop).
  const gridSx =
    view === 'large'
      ? ({
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
          gap: { xs: 1.25, sm: 2 },
        } as const)
      : ({
          display: 'grid',
          gridAutoFlow: { xs: 'column', sm: 'row' },
          gridAutoColumns: { xs: 'calc((100% - 16px) / 3)', sm: 'auto' },
          gridTemplateColumns: { xs: 'none', sm: 'repeat(6, 1fr)' },
          overflowX: { xs: 'auto', sm: 'visible' },
          scrollSnapType: { xs: 'x mandatory', sm: 'none' },
          // No scrollbar: the gesture is obvious from the cut-off tile.
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
          '& > a': { scrollSnapAlign: { xs: 'start', sm: 'none' } },
          gap: { xs: 1, sm: 1.25 },
        } as const);

  if (items === null) {
    // Collapsed: no skeleton, and the heading may turn out to title nothing (no similar found) —
    // stay silent until the response.
    if (collapsed) return null;
    return (
      <Box ref={setSkeletonEl} sx={{ mt: 3 }}>
        {heading}
        <Box sx={gridSx}>
          {Array.from({ length: MAX_ITEMS }).map((_, i) => (
            <Skeleton key={i} variant="rounded" sx={{ width: '100%', aspectRatio: '3 / 4' }} />
          ))}
        </Box>
      </Box>
    );
  }

  if (items.length === 0) return null;

  return (
    <Box component="section" sx={{ mt: collapsed ? 1.5 : 3 }} aria-label="Similar games">
      {heading}
      {collapsed ? null : (
      <Box sx={gridSx}>
        {items.map(({ game: item, score }) => {
          const raw = rawURL(item);
          const src = rawFallback.has(item.id) ? raw : thumbURL(item);
          return (
            <Link
              key={item.id}
              component={RouterLink}
              to={`/game/${gameCanonicalKey(item)}`}
              title={item.title}
              sx={{
                display: 'block',
                textDecoration: 'none',
                color: 'text.primary',
                transition: 'transform 0.3s ease-in-out',
                '&:hover': { transform: 'scale(1.04)' },
                '&:hover .similar-title': { color: 'primary.main' },
              }}
            >
              <Box
                sx={{
                  position: 'relative',
                  // 3:4 like catalog cards (CARD_ASPECT_RATIO), the shape covers are shot in.
                  // Landscape tiles cropped portrait screenshots to an often-empty top strip.
                  aspectRatio: '3 / 4',
                  overflow: 'hidden',
                  borderRadius: 1,
                  bgcolor: theme.palette.background.paper,
                  boxShadow: theme.shadows[3],
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                {src && (
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={() => {
                      // Cloudflare transform may fail (broken source, Image Resizing off, local dev
                      // without CF) → show the original. Fallback kept in state like the catalog
                      // card: assigning img.src in the handler doesn't stick — React restores its
                      // src on the next render and the image stays broken.
                      setRawFallback((prev) => (prev.has(item.id) ? prev : new Set(prev).add(item.id)));
                    }}
                    style={{
                      width: '100%',
                      height: '100%',
                      // Top, not center: CYOAs draw their title in the image header and center-crop
                      // cut exactly that.
                      objectFit: 'cover',
                      objectPosition: 'top',
                      display: 'block',
                    }}
                  />
                )}
                {score !== undefined && (
                  <Box sx={{ position: 'absolute', top: 4, right: 4, zIndex: 2 }}>
                    <Chip
                      icon={<AutoAwesomeIcon style={{ fontSize: '0.7rem', color: '#fff' }} />}
                      label={`${Math.round(score)}%`}
                      size="small"
                      // Same match badge as semantic search (GameCard, relevanceScore): the same
                      // number must look the same everywhere.
                      sx={{
                        height: 18,
                        backgroundColor: score > 80 ? 'rgba(46, 125, 50, 0.9)' : 'rgba(255, 143, 0, 0.9)',
                        color: '#fff',
                        fontWeight: 'bold',
                        fontSize: '0.65rem',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        '& .MuiChip-label': { px: 0.5 },
                        '& .MuiChip-icon': { ml: 0.5, mr: -0.25 },
                      }}
                    />
                  </Box>
                )}
              </Box>
              <Typography
                className="similar-title"
                variant="body2"
                align="center"
                sx={{
                  mt: 0.5,
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  lineHeight: 1.3,
                  color: 'text.primary',
                  transition: 'color 0.2s ease',
                }}
              >
                {item.title}
              </Typography>
            </Link>
          );
        })}
      </Box>
      )}
    </Box>
  );
}
