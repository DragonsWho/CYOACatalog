// Home page (/), formerly the FeedLab3 stand. Mode controls (three independent axes) live in
// FeedModeControls, shared by the wide panel and the narrow variant (`page` / `panel` layouts).

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  ButtonBase,
  Chip,
  CircularProgress,
  Collapse,
  Container,
  IconButton,
  Paper,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import TitleIcon from '@mui/icons-material/Title';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';

import { DECK_REFRESH_MS, drawDeck, loadDeck, refreshDeck, saveDeck } from './randomPicks';
import GameGrid from '../Search/GameGrid';
import {
  AuthContext,
  CATALOG_GAME_FIELDS,
  Game,
  PINNED_ORIGINAL_DAYS,
  peekPinnedSeen,
  Tag,
  authorsCollectionPublic,
  gamesCollectionPublic,
  loadPinnedSeen,
} from '../../pocketbase/pocketbase';
import { getUsedTagIds } from '../../utils/tagUsage';
import { inlineRatingTagIds, loadTagDictionary, peekTagDictionary, tagMapOf } from '../../utils/tagDictionary';
import { SEARCH_HOME_EVENT, requestSearchOpen } from '../../utils/searchTagBus';
import FeedModeControls from './FeedModeControls';
import { readSeed } from './feedParams';
import type { DirKey, FormatKey, PeriodKey, SeedKey, SortKey } from './feedParams';
import type { FilterMode } from '../../types';

const ITEMS_PER_PAGE = 25;
const LIKED_IDS_MAX = 500;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
const RANDOM_PICK = 20;
const SEMANTIC_MAX = 40;
const TITLE_DEBOUNCE_MS = 350;

const PERIOD_DAYS: Record<Exclude<PeriodKey, 'all'>, number> = {
  week: 7,
  month: 30,
  year: 365,
};

// Sort field plus a secondary tiebreaker. Reversing flips only the first key's sign: "least
// discussed" = few comments, not "oldest".
// Default feed sorts by bumped_at: roulette bumps and updates are events too — that's why bumps
// exist. Explicit "Newest" is strictly by created: the user asked "what's new HERE", bumps would
// only get in the way.
const SORT_FIELD: Record<SortKey, string> = {
  feed: 'bumped_at',
  fresh: 'created',
  top: 'upvotes_count',
  talk: 'comments_count',
};

const sortExpr = (key: SortKey, dir: DirKey): string => {
  const sign = dir === 'asc' ? '+' : '-';
  // Tiebreaker only if it differs from the primary key — PB rejects `-created,-created`.
  return SORT_FIELD[key] === 'created'
    ? `${sign}created`
    : `${sign}${SORT_FIELD[key]},-created`;
};

// Sanitize quotes/slashes for values going into the PB filter as string literals.
const sanitize = (s: string) => s.replace(/["\\]/g, '');

const esc = (s: string) => s.replace(/"/g, '\\"');

const cutoffFor = (period: PeriodKey): string | null => {
  if (period === 'all') return null;
  const d = new Date(Date.now() - PERIOD_DAYS[period] * ONE_DAY_IN_MS);
  return d.toISOString().replace('T', ' ').substring(0, 19);
};

// PB returns expand as object or array — normalize to array (as in SearchPage).
const processGameData = (items: Record<string, unknown>[]): Game[] =>
  items.map((item) => {
    const rawExpand = item['expand'] as Record<string, unknown> | undefined;
    const expand = rawExpand
      ? {
          ...(rawExpand.authors
            ? { authors: Array.isArray(rawExpand.authors) ? rawExpand.authors : [rawExpand.authors] }
            : {}),
          ...(rawExpand.tags
            ? { tags: Array.isArray(rawExpand.tags) ? rawExpand.tags : [rawExpand.tags] }
            : {}),
        }
      : {};
    return { ...item, expand } as Game;
  });

const byBlockedAuthor = (game: Game, blocked: Set<string>): boolean => {
  const ids = game.expand?.authors?.map((a) => a.id) ?? game.authors ?? [];
  return ids.some((id) => blocked.has(id));
};

interface HomePageProps {
  // Tags/authors picked in the header panel (same search surface).
  selectedTags: string[];
  selectedAuthors: string[];
  filterMode: FilterMode;
  blockedTags: Tag[];
}

export default function HomePage({
  selectedTags: headerTags,
  selectedAuthors: headerAuthors,
  filterMode,
  blockedTags,
}: HomePageProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, blockedGameIds, blockedAuthorIds } = useContext(AuthContext);
  // Only the id: the user object changes on every token refresh; putting it in deps loops effects
  // into endless refetch (auth-user-identity-churn-trap).
  const userId = user?.id ?? null;

  const blockedGameSet = useMemo(() => new Set(blockedGameIds), [blockedGameIds]);
  const blockedAuthorSet = useMemo(() => new Set(blockedAuthorIds), [blockedAuthorIds]);

  // --- STATE = URL --- Read straight from searchParams, not useState: "share this feed" and Back
  // work without syncing two sources of truth.
  const urlTags = useMemo(
    () => (searchParams.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean),
    [searchParams],
  );
  const urlAuthors = useMemo(
    () => (searchParams.get('authors') || '').split(',').map((s) => s.trim()).filter(Boolean),
    [searchParams],
  );
  const q = searchParams.get('q') || '';
  // A missing param is NOT "fresh" but a separate `feed` state — the one showing bumps. No button
  // is highlighted then.
  const sort = (searchParams.get('sort') as SortKey) || 'feed';
  const dir: DirKey = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  // Semantic search has its own param and field; it can no longer share `q` with the title filter —
  // both are visible at once.
  const sem = searchParams.get('sem') || '';
  const period = (searchParams.get('period') as PeriodKey) || 'all';
  const format = (searchParams.get('format') as FormatKey) || 'all';
  const liked = searchParams.get('liked') === '1';
  // Seed mode is driven by content: text in the "by meaning" field = semantic mode. No separate
  // toggle.
  const seed: SeedKey = readSeed(searchParams);

  // Header tags/authors add to URL tags — one surface.
  const activeTags = useMemo(
    () => Array.from(new Set([...headerTags, ...urlTags])),
    [headerTags, urlTags],
  );
  const activeAuthors = useMemo(
    () => Array.from(new Set([...headerAuthors, ...urlAuthors])),
    [headerAuthors, urlAuthors],
  );

  const showPins =
    seed === 'none' && sort === 'feed' && !q && !liked
    && activeTags.length === 0 && activeAuthors.length === 0
    && format === 'all' && period === 'all';

  // One-line summary of what narrows the feed, for the narrow "search button": the user must see
  // what is being searched, otherwise the placeholder lies ("Title, author or tag..." with an
  // active filter).
  const feedSummary = useMemo(
    () => [sem || q, ...activeAuthors, ...activeTags].filter(Boolean).join(' · '),
    [sem, q, activeAuthors, activeTags],
  );

  const patchParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      Object.entries(patch).forEach(([k, v]) => {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      });
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // --- Inputs --- Each field has one role, so debouncing `q` is safe: the title field can't set a
  // tag and vice versa — the double-chip bug of variant A is impossible by design.
  const [titleDraft, setTitleDraft] = useState(q);
  useEffect(() => {
    setTitleDraft(q);
  }, [q]);
  useEffect(() => {
    const id = setTimeout(() => {
      const next = titleDraft.trim();
      if (next !== q) patchParams({ q: next || null });
    }, TITLE_DEBOUNCE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleDraft]);

  // The "by meaning" field applies on Enter, not per keystroke — embedding queries are expensive.
  const [semDraft, setSemDraft] = useState(sem);
  useEffect(() => {
    setSemDraft(sem);
  }, [sem]);

  const [tagDraft, setTagDraft] = useState('');
  const [authorDraft, setAuthorDraft] = useState('');

  // --- "Home" on logo click --- This feed IS the home page, so navigating to "/" resets nothing.
  // All feed state lives in the URL → reset = clear params; field drafts live outside the URL and
  // are cleared by hand. Signal comes from the header (the same one the old /search catalog listens
  // to).
  useEffect(() => {
    const onHome = () => {
      setTitleDraft('');
      setSemDraft('');
      setTagDraft('');
      setAuthorDraft('');
      setSearchParams({}, { replace: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener(SEARCH_HOME_EVENT, onHome);
    return () => window.removeEventListener(SEARCH_HOME_EVENT, onHome);
  }, [setSearchParams]);

  // --- Panel --- The four-field panel is desktop-only: on narrow screens two search blocks
  // compete. The home page must not be empty there, so a narrow variant renders instead: one search
  // line (opens the header sheet) plus the same mode row.
  const panelVisible = isDesktop;
  const inputRef = useRef<HTMLInputElement | null>(null);

  // --- Tag dictionary --- One shared source (utils/tagDictionary). NSFW/Extreme ids come inlined
  // in the HTML, so the default feed does NOT wait for the dictionary; only URL tag names (→ ids)
  // need it. A stale or missing dictionary must never silently disable the NSFW filter.
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(() => {
    const dict = peekTagDictionary();
    return dict ? tagMapOf(dict) : new Map();
  });
  const [tagsLoaded, setTagsLoaded] = useState(() => peekTagDictionary() !== null);
  useEffect(() => {
    if (tagsLoaded) return;
    let alive = true;
    loadTagDictionary()
      .then((dict) => { if (alive) setTagMap(tagMapOf(dict)); })
      .catch((e) => console.error(e))
      .finally(() => { if (alive) setTagsLoaded(true); });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inlineRating = useMemo(() => inlineRatingTagIds(), []);
  const nsfwTagId = useMemo(() => {
    for (const [id, t] of tagMap) if (t.name.toLowerCase() === 'nsfw') return id;
    return inlineRating?.nsfw ?? null;
  }, [tagMap, inlineRating]);
  const extremeTagId = useMemo(() => {
    for (const [id, t] of tagMap) if (t.name.toLowerCase() === 'extreme') return id;
    return inlineRating?.extreme ?? null;
  }, [tagMap, inlineRating]);
  // The feed can start once the filter has what it needs: rating ids (inline or dictionary) and,
  // only if tags are named in the URL/header, the dictionary for name → id.
  const filterReady = tagsLoaded || (inlineRating !== null && activeTags.length === 0);
  const idByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, t] of tagMap) m.set(t.name.toLowerCase(), id);
    return m;
  }, [tagMap]);

  // --- Tag suggestions: local --- tagMap is fully in memory, so no request; list opens instantly.
  // Empty tags (0 games) hidden.
  const usedTagIdsRef = useRef<Set<string>>(new Set());
  const [usedTagsReady, setUsedTagsReady] = useState(false);
  useEffect(() => {
    getUsedTagIds()
      .then((s) => { usedTagIdsRef.current = s; })
      .catch(() => {})
      .finally(() => setUsedTagsReady(true));
  }, []);

  const tagOptions = useMemo(() => {
    const used = usedTagIdsRef.current;
    return Array.from(tagMap.values())
      .filter((t) => (used.size ? used.has(t.id) : true))
      .map((t) => t.name)
      .sort((a, b) => a.localeCompare(b));
    // usedTagsReady — recompute once the non-empty-tags list arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagMap, usedTagsReady]);

  const [authorOptions, setAuthorOptions] = useState<string[]>([]);
  const authorSeqRef = useRef(0);
  useEffect(() => {
    const needle = sanitize(authorDraft.trim());
    if (needle.length < 2) {
      setAuthorOptions([]);
      return;
    }
    const my = ++authorSeqRef.current;
    const id = setTimeout(() => {
      authorsCollectionPublic
        .getList(1, 8, {
          filter: `(name ~ "${needle}" || aliases ~ "${needle}")`,
          fields: 'id,name',
          skipTotal: true,
        })
        .then((res) => {
          if (my !== authorSeqRef.current) return;
          setAuthorOptions((res.items as unknown as { name: string }[]).map((a) => a.name));
        })
        .catch(() => {
          if (my === authorSeqRef.current) setAuthorOptions([]);
        });
    }, TITLE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [authorDraft]);

  const [games, setGames] = useState<Game[]>([]);
  // Pin order belongs to the displayed result, not the requested URL mode. Keep it until the
  // replacement cards arrive (also on errors).
  const [gamesShowPins, setGamesShowPins] = useState(false);
  const [scores, setScores] = useState<Map<string, number>>(new Map());
  const [pinned, setPinned] = useState<Game[]>([]);
  const [seenPinned, setSeenPinned] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const generationRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // First paint from the snapshot Go inlines into the HTML (main.go buildCatalogScriptTag): the
  // default feed page and its pins, per filter mode. Cards show before any API round-trip; the
  // normal fetch then reconciles in place (same order → no jump). Only the exact default view is
  // seeded; nsfw-only is a different server-filtered set. Blocked games/authors are cut at render
  // (visibleGames); blocked tags are a server filter, so users with any aren't seeded.
  useLayoutEffect(() => {
    if (!showPins || dir !== 'desc' || sem || filterMode === 'nsfw' || blockedTags.length) return;
    const win = window as unknown as Record<string, unknown>;
    const all = filterMode === 'all';
    const feed = win[all ? '__CATALOG_ALL__' : '__CATALOG__'];
    const pins = win[all ? '__CATALOG_PINS_ALL__' : '__CATALOG_PINS__'];
    if (!Array.isArray(feed) || feed.length === 0) return;
    setGames(processGameData(feed as Record<string, unknown>[]));
    setPinned(Array.isArray(pins) ? processGameData(pins as Record<string, unknown>[]) : []);
    setSeenPinned(peekPinnedSeen());
    setGamesShowPins(true);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Liked list is a separate query with no tag conditions (see join trap in buildFilter). null =
  // not loaded yet: the feed waits, otherwise the first visit would show "nothing found".
  const [likedIds, setLikedIds] = useState<string[] | null>(null);
  useEffect(() => {
    if (!liked || !userId) {
      setLikedIds(null);
      return;
    }
    let cancelled = false;
    gamesCollectionPublic
      .getList(1, LIKED_IDS_MAX, {
        filter: `upvotes ?~ "${userId}"`,
        fields: 'id',
        sort: '-created',
        skipTotal: true,
      })
      .then((res) => {
        if (!cancelled) setLikedIds(res.items.map((i) => i.id));
      })
      .catch(() => {
        if (!cancelled) setLikedIds([]);
      });
    return () => { cancelled = true; };
  }, [liked, userId]);

  // PB filter conditions shared by feed and pins.
  const buildFilter = useCallback(
    (opts: { withUserFilters: boolean }) => {
      const c: string[] = [];

      if (filterMode === 'sfw') {
        if (nsfwTagId) c.push(`tags.id != "${nsfwTagId}"`);
        if (extremeTagId) c.push(`tags.id != "${extremeTagId}"`);
      } else if (filterMode === 'nsfw') {
        const any: string[] = [];
        if (nsfwTagId) any.push(`tags ~ "${nsfwTagId}"`);
        if (extremeTagId) any.push(`tags ~ "${extremeTagId}"`);
        c.push(any.length ? `(${any.join(' || ')})` : '(1=0)');
      }
      // Blocked tags cut results in all modes — a user property, not a feed filter, so no chip.
      blockedTags.forEach((t) => c.push(`tags.id != "${t.id}"`));

      if (!opts.withUserFilters) return c;

      if (q) c.push(`(title ~ "${esc(q)}" || aliases ~ "${esc(q)}")`);
      if (activeAuthors.length) {
        c.push(`(${activeAuthors.map((a) => `authors.name ?~ "${esc(a)}"`).join(' || ')})`);
      }

      const pos: string[] = [];
      const neg: string[] = [];
      activeTags.forEach((raw) => {
        const isNeg = raw.startsWith('-');
        const name = (isNeg ? raw.slice(1) : raw).trim();
        if (!name) return;
        const id = idByName.get(name.toLowerCase());
        if (!id) {
          // Unknown tag: an empty result is more honest than silently dropping it.
          if (!isNeg) pos.push('__missing__');
          return;
        }
        (isNeg ? neg : pos).push(id);
      });
      if (pos.includes('__missing__')) c.push('(1=0)');
      else pos.forEach((id) => c.push(`tags ~ "${id}"`));
      neg.forEach((id) => c.push(`tags.id != "${id}"`));

      const cutoff = cutoffFor(period);
      if (cutoff) c.push(`created >= "${cutoff}"`);
      if (format !== 'all') c.push(`img_or_link = "${format}"`);
      // PocketBase TRAP: `upvotes ?~ "<user>"` must NOT be combined in one filter with conditions
      // on another multi-relation (`tags.id != "..."`) — each adds a join and results collapse to
      // near zero. Verified on prod: 40 likes → 1 → 0 as "not NSFW"/"not Extreme" were added. So
      // likes are fetched separately (single join) and injected as plain ids — no join on a flat
      // field, tag filters work again.
      if (liked && userId) {
        c.push(likedIds && likedIds.length ? `(${likedIds.map((id) => `id = "${id}"`).join(' || ')})` : '(1=0)');
      }

      return c;
    },
    [
      filterMode, nsfwTagId, extremeTagId, blockedTags, q, activeAuthors, activeTags,
      idByName, period, format, liked, userId, likedIds,
    ],
  );

  // Client-side filter over a ready set — for seeds (semantic/random).
  const applyClientFilters = useCallback(
    (list: Game[]): Game[] => {
      const cutoff = cutoffFor(period);
      const cutoffMs = cutoff ? new Date(cutoff.replace(' ', 'T') + 'Z').getTime() : null;
      const pos: string[] = [];
      const neg: string[] = [];
      activeTags.forEach((raw) => {
        const isNeg = raw.startsWith('-');
        const name = (isNeg ? raw.slice(1) : raw).trim().toLowerCase();
        if (name) (isNeg ? neg : pos).push(name);
      });
      return list.filter((g) => {
        const names = (g.expand?.tags ?? []).map((t) => t.name.toLowerCase());
        if (pos.some((p) => !names.includes(p))) return false;
        if (neg.some((n) => names.includes(n))) return false;
        if (format !== 'all' && (g as unknown as { img_or_link?: string }).img_or_link !== format) return false;
        if (cutoffMs && g.created && new Date(g.created).getTime() < cutoffMs) return false;
        if (activeAuthors.length) {
          const authors = (g.expand?.authors ?? []).map((a) => a.name.toLowerCase());
          if (!activeAuthors.some((a) => authors.includes(a.toLowerCase()))) return false;
        }
        // Title is a filter too and applies to semantic results: it has its own field, separate
        // from "by meaning".
        if (q.trim() && !(g.title || '').toLowerCase().includes(q.trim().toLowerCase())) return false;
        return true;
      });
    },
    [activeTags, activeAuthors, period, format, q],
  );

  const fetchFeed = useCallback(
    async (pageNum: number, reset: boolean) => {
      if (!filterReady) return;
      if (liked && !userId) {
        setGames([]);
        setGamesShowPins(false);
        setScores(new Map());
        setHasMore(false);
        setLoading(false);
        return;
      }
      // Liked list still loading — wait instead of showing an empty feed.
      if (liked && likedIds === null) {
        setLoading(true);
        return;
      }
      const gen = ++generationRef.current;
      setLoading(true);
      setError(null);
      try {
        // Fetch feed and pin metadata together; publish a single complete layout.
        const [res, freshPins] = await Promise.all([
          gamesCollectionPublic.getList(pageNum, ITEMS_PER_PAGE, {
            sort: sortExpr(sort, dir),
            expand: 'authors,tags',
            filter: buildFilter({ withUserFilters: true }).join(' && '),
            fields: CATALOG_GAME_FIELDS,
          }),
          reset && showPins ? (async () => {
            const cutoff = new Date(Date.now() - PINNED_ORIGINAL_DAYS * ONE_DAY_IN_MS)
              .toISOString().replace('T', ' ').substring(0, 19);
            const result = await gamesCollectionPublic.getList(1, 10, {
              sort: '-created', expand: 'authors,tags', fields: CATALOG_GAME_FIELDS,
              filter: ['original_release = true', `created >= "${cutoff}"`,
                ...buildFilter({ withUserFilters: false })].join(' && '),
            });
            const items = processGameData(result.items as unknown as Record<string, unknown>[]);
            const seen = await loadPinnedSeen(items.map((game) => game.id));
            return { items, seen };
          })() : Promise.resolve(null),
        ]);
        if (gen !== generationRef.current) return;
        const items = processGameData(res.items as unknown as Record<string, unknown>[]);
        setGames((prev) => {
          if (reset) return items;
          const seen = new Set(prev.map((g) => g.id));
          return [...prev, ...items.filter((g) => !seen.has(g.id))];
        });
        if (freshPins) {
          setPinned(freshPins.items);
          setSeenPinned(freshPins.seen);
        }
        setGamesShowPins(showPins);
        setScores(new Map());
        setHasMore(res.items.length === ITEMS_PER_PAGE);
      } catch (e) {
        if (gen !== generationRef.current) return;
        console.error(e);
        setError('Could not load the feed');
      } finally {
        if (gen === generationRef.current) setLoading(false);
      }
    },
    [filterReady, liked, likedIds, userId, sort, dir, buildFilter, showPins],
  );

  const fetchSemantic = useCallback(async () => {
    const query = sem.trim();
    if (query.length < 2) {
      setGames([]);
      setGamesShowPins(false);
      setScores(new Map());
      setLoading(false);
      return;
    }
    const gen = ++generationRef.current;
    setLoading(true);
    setError(null);
    setHasMore(false);
    try {
      const r = await fetch(`/api/semantic-search?q=${encodeURIComponent(query)}&mode=mixed`);
      if (!r.ok) throw new Error(`semantic-search ${r.status}`);
      const data = (await r.json()) as { results?: { id: string; score: number }[] };
      const results = (data.results ?? []).slice(0, SEMANTIC_MAX);
      if (gen !== generationRef.current) return;
      if (!results.length) {
        setGames([]);
        setGamesShowPins(false);
        setScores(new Map());
        return;
      }
      const scoreMap = new Map(results.map((x) => [x.id, x.score]));
      const pb = await gamesCollectionPublic.getFullList<Game>({
        filter: results.map((x) => `id="${x.id}"`).join(' || '),
        expand: 'authors,tags',
        fields: CATALOG_GAME_FIELDS,
      });
      if (gen !== generationRef.current) return;
      // Semantic search defines the order; PB doesn't preserve it.
      const byId = new Map(pb.map((g) => [g.id, g]));
      const ordered = results.map((x) => byId.get(x.id)).filter((g): g is Game => !!g);
      // ...only now apply filters. This is why semantic moved into the shared feed: "by meaning,
      // but SFW only and no Horror" is impossible on /semantic-search.
      setScores(scoreMap);
      setGamesShowPins(false);
      setGames(applyClientFilters(processGameData(ordered as unknown as Record<string, unknown>[])));
    } catch (e) {
      if (gen !== generationRef.current) return;
      console.error(e);
      setError('Semantic search did not respond');
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [sem, applyClientFilters]);

  // Cache only IDs and progress. Card requests always use current filters.
  const randomPendingRef = useRef<{ key: string; generation: number; promise: Promise<string[]> } | null>(null);
  const fetchRandom = useCallback(async () => {
    const gen = ++generationRef.current;
    setLoading(true);
    setError(null);
    setHasMore(false);
    const checkCurrent = () => {
      if (gen !== generationRef.current) throw new Error('Obsolete random draw');
    };
    try {
      const conditions = buildFilter({ withUserFilters: true });
      blockedGameIds.forEach((id) => conditions.push(`id != "${esc(id)}"`));
      blockedAuthorIds.forEach((id) => conditions.push(`authors.id != "${esc(id)}"`));
      if (liked && !userId) conditions.push('(1=0)');
      const filter = conditions.join(' && ');
      // Sort arrays so equivalent filter combinations resume the same deck. Do not include the
      // moving timestamp of relative date filters in the key.
      const key = JSON.stringify({ userId, period, format, liked, q,
        activeTags: [...activeTags].sort(), activeAuthors: [...activeAuthors].sort(),
        filterMode, nsfwTagId, extremeTagId,
        blocked: blockedTags.map((t) => t.id).sort(),
        blockedGames: [...blockedGameIds].sort(), blockedAuthors: [...blockedAuthorIds].sort(),
      });
      const reloadIds = async () => {
        checkCurrent();
        let pending = randomPendingRef.current;
        if (!pending || pending.key !== key) {
          const promise = (async () => {
            const ids: string[] = [];
            for (let page = 1; ; page++) {
              const res = await gamesCollectionPublic.getList(page, 500, {
                sort: 'id', filter, fields: 'id', skipTotal: true,
              });
              ids.push(...res.items.map((game) => game.id));
              if (res.items.length < 500) return ids;
              // Stop a long scan if the user switched to another mode/filter.
              if (randomPendingRef.current?.key !== key || randomPendingRef.current.generation !== generationRef.current) throw new Error('Obsolete ID scan');
            }
          })();
          pending = { key, generation: gen, promise };
          randomPendingRef.current = pending;
        }
        pending.generation = gen;
        try {
          const ids = await pending.promise;
          checkCurrent();
          return ids;
        } finally {
          if (randomPendingRef.current === pending) randomPendingRef.current = null;
        }
      };
      let deck = loadDeck(key);
      if (!deck || Date.now() - deck.refreshedAt >= DECK_REFRESH_MS) {
        deck = refreshDeck(deck, await reloadIds());
      }
      const result = await drawDeck(deck, RANDOM_PICK, async (ids) => {
        checkCurrent();
        const idFilter = `(${ids.map((id) => `id="${esc(id)}"`).join(' || ')})`;
        const res = await gamesCollectionPublic.getList(1, RANDOM_PICK, {
          filter: [filter, idFilter].filter(Boolean).join(' && '),
          expand: 'authors,tags', fields: CATALOG_GAME_FIELDS, skipTotal: true,
        });
        checkCurrent();
        return processGameData(res.items as unknown as Record<string, unknown>[])
          .filter((game) => !blockedGameSet.has(game.id) && !byBlockedAuthor(game, blockedAuthorSet));
      }, reloadIds);
      checkCurrent();
      setGames(result.cards);
      setGamesShowPins(false);
      setScores(new Map());
      saveDeck(key, result.deck);
    } catch (e) {
      if (gen !== generationRef.current) return;
      console.error(e);
      setError('Could not build a random selection');
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [buildFilter, userId, blockedGameSet, blockedAuthorSet, blockedGameIds, blockedAuthorIds, period, format,
    liked, q, activeTags, activeAuthors, filterMode, nsfwTagId, extremeTagId, blockedTags]);

  // One entry for all three modes: key changes → refetch from scratch. `likedReady` MUST be in the
  // key: the liked list arrives AFTER `liked` appears in the URL; without it the first "my likes"
  // click did nothing (request deferred, nobody woke it) and it only worked on the second click.
  const likedReady = !liked || !userId || likedIds !== null;
  const stateKey = JSON.stringify({
    seed, sort, dir, period, format, liked, q, sem, activeTags, activeAuthors,
    filterMode, blocked: blockedTags.map((t) => t.id), user: userId, filterReady,
    likedReady,
    randomBlocks: seed === 'random' ? [blockedGameIds, blockedAuthorIds] : null,
  });
  const prevKeyRef = useRef('');
  const [randomRoll, setRandomRoll] = useState(0);
  useEffect(() => {
    // Mode/filter change invalidates even a pending response.
    ++generationRef.current;
    if (!filterReady) return;
    // Liked list still loading — wait, or the seed (random/semantic) runs against the placeholder
    // filter and returns nothing.
    if (!likedReady) { setLoading(true); return; }
    if (prevKeyRef.current === stateKey && seed !== 'random') return;
    prevKeyRef.current = stateKey;
    setPage(1);
    setHasMore(true);
    if (seed === 'semantic') {
      fetchSemantic();
    } else if (seed === 'random') {
      fetchRandom();
    } else {
      fetchFeed(1, true);
    }
    return () => {
      // This is a request counter, not a DOM ref: invalidate its latest value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++generationRef.current;
      // React StrictMode may replay this effect on mount.
      prevKeyRef.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, randomRoll, filterReady]);

  // Infinite scroll only for the feed: seed results are finite by nature.
  useEffect(() => {
    if (page === 1 || seed !== 'none') return;
    fetchFeed(page, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const lastItemRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading || !hasMore || seed !== 'none') return;
      observerRef.current?.disconnect();
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) setPage((p) => p + 1);
      });
      if (node) observerRef.current.observe(node);
    },
    [loading, hasMore, seed],
  );

  const visibleGames = useMemo(
    () => games.filter((g) => !blockedGameSet.has(g.id) && !byBlockedAuthor(g, blockedAuthorSet)),
    [games, blockedGameSet, blockedAuthorSet],
  );
  const visiblePinned = useMemo(
    () =>
      pinned.filter(
        (g) =>
          !blockedGameSet.has(g.id) && !seenPinned.has(g.id) && !byBlockedAuthor(g, blockedAuthorSet),
      ),
    [pinned, blockedGameSet, blockedAuthorSet, seenPinned],
  );
  const pinnedIds = useMemo(() => new Set(visiblePinned.map((g) => g.id)), [visiblePinned]);
  // Pins are not a separate section: they come first in the grid, marked only by the green "Fresh"
  // corner tag.
  const feedGames = useMemo(
    () =>
      gamesShowPins
        ? [...visiblePinned, ...visibleGames.filter((g) => !pinnedIds.has(g.id))]
        : visibleGames,
    [gamesShowPins, visibleGames, visiblePinned, pinnedIds],
  );

  const setTags = (next: string[]) => patchParams({ tags: next.join(',') || null });
  const setAuthors = (next: string[]) => patchParams({ authors: next.join(',') || null });

  // The tag field emits its whole list (chips inside = its value). Header tags are removed where
  // they were added, so only non-header tags are written to the URL.
  const commitTags = (next: string[]) => {
    setTags(Array.from(new Set(next.filter((t) => !headerTags.includes(t)))));
  };
  const commitAuthors = (next: string[]) => {
    setAuthors(Array.from(new Set(next.filter((a) => !headerAuthors.includes(a)))));
  };

  // Tag field input: "-name" makes an exclude tag; name normalized to canonical.
  const normalizeTagToken = (raw: string): string | null => {
    const token = raw.trim();
    if (!token) return null;
    const negated = token.startsWith('-');
    const bare = negated ? token.slice(1) : token;
    const known = idByName.get(bare.toLowerCase());
    if (!known) return null;
    const canonical = tagMap.get(known)?.name ?? bare;
    return negated ? `-${canonical}` : canonical;
  };

  // A tag and its negation are one condition with opposite signs: the last sign wins. Otherwise
  // "#RPG" and "-RPG" coexist and yield an empty feed.
  const dedupeTagPolarity = (list: string[]): string[] => {
    const bareOf = (t: string) => (t.startsWith('-') ? t.slice(1) : t).toLowerCase();
    const out: string[] = [];
    list.forEach((t) => {
      const i = out.findIndex((x) => bareOf(x) === bareOf(t));
      if (i >= 0) out[i] = t;
      else out.push(t);
    });
    return out;
  };

  // Field styling copies production search (SearchPage.paperInputStyles, textFieldSx: 44px height,
  // 1rem font) so the new screen doesn't look like a different site.
  const fieldSx: SxProps<Theme> = {
    p: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    backgroundColor:
      theme.palette.mode === 'dark'
        ? alpha(theme.palette.common.white, 0.05)
        : alpha(theme.palette.common.black, 0.03),
    borderRadius: 3,
    transition: 'box-shadow 0.2s, background-color 0.2s',
    border: '1px solid transparent',
    '&:hover': {
      backgroundColor:
        theme.palette.mode === 'dark'
          ? alpha(theme.palette.common.white, 0.08)
          : alpha(theme.palette.common.black, 0.05),
    },
    '&:focus-within': {
      backgroundColor: theme.palette.background.paper,
      boxShadow: theme.shadows[2],
      borderColor: theme.palette.primary.main,
    },
  };

  const textFieldSx: SxProps<Theme> = {
    flex: 1,
    '& .MuiOutlinedInput-root': {
      '& fieldset': { border: 'none' },
      padding: '0 8px !important',
      minHeight: '44px',
    },
    '& .MuiInputBase-input': {
      padding: '8px 0 !important',
      fontSize: '1rem',
    },
    '& .MuiInputBase-input::placeholder': {
      fontSize: '0.95rem',
      opacity: 0.6,
    },
  };

  const fieldIconSx: SxProps<Theme> = { ml: 1, mr: 1, fontSize: '1.2rem' };

  const chipSx = (mainColor: string, strike: boolean): SxProps<Theme> => ({
    borderColor: mainColor,
    color: theme.palette.text.primary,
    height: '26px',
    fontSize: '0.85rem',
    borderRadius: '6px',
    m: '3px',
    borderWidth: '1px',
    textDecoration: strike ? 'line-through' : 'none',
    '& .MuiChip-label': { px: 1, fontWeight: 500 },
    '& .MuiChip-deleteIcon': {
      color: mainColor,
      opacity: 0.7,
      fontSize: '18px',
      '&:hover': { color: mainColor, opacity: 1 },
    },
  });

  return (
    <Container maxWidth={false} disableGutters sx={{ maxWidth: '2200px', mx: 'auto', px: { xs: 1, sm: 2, md: 3 }, pb: 2 }}>
      <Collapse in={panelVisible}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, mb: 1.5, alignItems: { md: 'center' } }}>
          <Box
            sx={{
              display: 'flex',
              gap: 1,
              width: '100%',
              // Fields don't stretch to full catalog width: the search panel is a compact centered
              // block, otherwise it competes with the grid.
              maxWidth: 1080,
              alignItems: { xs: 'stretch', md: 'center' },
              flexDirection: { xs: 'column', md: 'row' },
            }}
          >
            <Paper elevation={0} sx={fieldSx}>
              <TitleIcon color="action" sx={fieldIconSx} />
              <TextField
                fullWidth
                inputRef={inputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  patchParams({ q: titleDraft.trim() || null });
                }}
                placeholder="Title..."
                sx={textFieldSx}
              />
            </Paper>

            <Paper elevation={0} sx={fieldSx}>
              <LocalOfferIcon color="action" sx={fieldIconSx} />
              <Autocomplete
                multiple
                freeSolo
                fullWidth
                disableClearable
                options={tagOptions}
                value={activeTags}
                inputValue={tagDraft}
                onInputChange={(_, v, reason) => { if (reason !== 'reset') setTagDraft(v); }}
                onChange={(_, v, reason, details) => {
                  // MUI passes the BARE tag name on select: a typed minus lives only in inputValue
                  // and got lost — the chip became an include tag. So apply the sign to the
                  // just-selected option ourselves.
                  const draftNeg = tagDraft.trim().startsWith('-');
                  const picked = reason === 'selectOption' && details?.option ? String(details.option) : null;
                  const next = (v as string[])
                    .map((t) => {
                      if (activeTags.includes(t)) return t;
                      const token = picked !== null && t === picked && draftNeg && !t.startsWith('-') ? `-${t}` : t;
                      return normalizeTagToken(token);
                    })
                    .filter((t): t is string => !!t);
                  commitTags(dedupeTagPolarity(next));
                  setTagDraft('');
                }}
                filterOptions={(opts, s) => {
                  const raw = s.inputValue.trim();
                  const needle = (raw.startsWith('-') ? raw.slice(1) : raw).toLowerCase();
                  if (!needle) return [];
                  return opts
                    .filter((o) => o.toLowerCase().includes(needle) && !activeTags.includes(o) && !activeTags.includes(`-${o}`))
                    .slice(0, 10);
                }}
                renderTags={(value, getTagProps) =>
                  value.map((t, index) => {
                    const isNeg = t.startsWith('-');
                    const color = isNeg ? theme.palette.error.main : theme.palette.success.main;
                    const { key, ...rest } = getTagProps({ index });
                    return (
                      <Chip
                        key={key}
                        {...rest}
                        size="small"
                        variant="outlined"
                        label={isNeg ? t.slice(1) : t}
                        onDelete={urlTags.includes(t) ? rest.onDelete : undefined}
                        sx={chipSx(color, isNeg)}
                      />
                    );
                  })
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    placeholder={activeTags.length ? '' : 'Tags (e.g. RPG, -Horror)'}
                    sx={textFieldSx}
                  />
                )}
              />
            </Paper>

            <Paper elevation={0} sx={fieldSx}>
              <PersonSearchIcon color="action" sx={fieldIconSx} />
              <Autocomplete
                multiple
                freeSolo
                fullWidth
                disableClearable
                options={authorOptions}
                filterOptions={(o) => o}
                value={activeAuthors}
                inputValue={authorDraft}
                onInputChange={(_, v, reason) => { if (reason !== 'reset') setAuthorDraft(v); }}
                onChange={(_, v) => {
                  commitAuthors((v as string[]).map((a) => a.trim()).filter(Boolean));
                  setAuthorDraft('');
                }}
                renderTags={(value, getTagProps) =>
                  value.map((a, index) => {
                    const { key, ...rest } = getTagProps({ index });
                    return (
                      <Chip
                        key={key}
                        {...rest}
                        size="small"
                        variant="outlined"
                        label={a}
                        onDelete={urlAuthors.includes(a) ? rest.onDelete : undefined}
                        sx={chipSx(theme.palette.text.secondary, false)}
                      />
                    );
                  })
                }
                renderInput={(params) => (
                  <TextField
                    {...params}
                    placeholder={activeAuthors.length ? '' : 'Authors...'}
                    sx={textFieldSx}
                  />
                )}
              />
            </Paper>
          </Box>

          {/*
            Row 1b: semantic search. Formerly an icon inside the title field — nobody found it. Now
            its own row: not a fourth filter but a different way to ask.
          */}
          <Box sx={{ display: 'flex', gap: 1, width: '100%', maxWidth: 820, alignItems: 'center' }}>
            <Paper
              elevation={0}
              sx={{
                ...fieldSx,
                ...(seed === 'semantic' ? { borderColor: alpha(theme.palette.primary.main, 0.5) } : {}),
              }}
            >
              <PsychologyIcon
                color={seed === 'semantic' ? 'primary' : 'action'}
                sx={fieldIconSx}
              />
              <TextField
                fullWidth
                value={semDraft}
                onChange={(e) => setSemDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  patchParams({ sem: semDraft.trim() || null, seed: null });
                }}
                placeholder="...or describe what you want and search by meaning"
                sx={textFieldSx}
                InputProps={{
                  endAdornment: sem ? (
                    <Tooltip title="Clear the meaning search">
                      <IconButton
                        size="small"
                        onClick={() => { setSemDraft(''); patchParams({ sem: null }); }}
                        aria-label="Clear the meaning search"
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null,
                }}
              />
            </Paper>
          </Box>

          <FeedModeControls randomLoading={loading} onReroll={() => setRandomRoll((n) => n + 1)} />

        </Box>
      </Collapse>

      {/*
        Narrow screen: the home page must never lack search and modes (formerly both hid behind the
        header magnifier and nobody knew). Always show one universal search line and the mode row.
        The line is a BUTTON, not a field: typing happens in the header sheet (suggestions,
        semantic). Open it with the same event as the magnifier, SYNCHRONOUSLY inside the tap —
        otherwise iOS won't raise the keyboard.
      */}
      {!panelVisible && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 1.5 }}>
          <ButtonBase
            onClick={() => requestSearchOpen()}
            aria-label="Search"
            sx={{ ...(fieldSx as object), justifyContent: 'flex-start', textAlign: 'left' }}
          >
            <SearchIcon color="action" sx={fieldIconSx} />
            <Typography
              noWrap
              sx={{
                flex: 1,
                py: '10px',
                pr: 1,
                fontSize: '0.95rem',
                color: feedSummary ? 'text.primary' : 'text.secondary',
                opacity: feedSummary ? 1 : 0.6,
              }}
            >
              {feedSummary || 'Title, author or tag...'}
            </Typography>
          </ButtonBase>

          <FeedModeControls variant="panel" randomLoading={loading} onReroll={() => setRandomRoll((n) => n + 1)} />
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
          {error}
        </Alert>
      )}

      {scores.size > 0 && games.length > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          {games.length} closest by meaning · filters applied to the result
        </Typography>
      )}

      <GameGrid games={feedGames} scores={scores.size ? scores : undefined} lastElementRef={lastItemRef} />

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={28} />
        </Box>
      )}

      {!loading && feedGames.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 6 }}>
          <Typography variant="body2" color="text.secondary">
            {liked && !userId
              ? 'Sign in to see what you liked.'
              : seed === 'semantic' && q.trim().length < 2
                ? 'Describe what you want and press Enter.'
                : 'Nothing matches these conditions — drop one of the filters.'}
          </Typography>
        </Box>
      )}
    </Container>
  );
}
