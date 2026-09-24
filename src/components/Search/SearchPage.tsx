import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Container,
  Tabs,
  Tab,
  TextField,
  Button,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Autocomplete,
  Chip,
  useTheme,
  Paper,
  createFilterOptions,
  Grid,
  debounce,
  alpha,
  IconButton,
  Tooltip,
  Divider,
  SxProps,
  Theme,
  AutocompleteRenderGetTagProps
} from '@mui/material';
import { useSearchParams, useNavigate } from 'react-router-dom';

import SearchIcon from '@mui/icons-material/Search';
import PsychologyIcon from '@mui/icons-material/Psychology';
import NewReleasesIcon from '@mui/icons-material/NewReleases';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import ShuffleIcon from '@mui/icons-material/Shuffle';
import RefreshIcon from '@mui/icons-material/Refresh';
import TitleIcon from '@mui/icons-material/Title';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import FavoriteIcon from '@mui/icons-material/Favorite';
import ImageIcon from '@mui/icons-material/Image';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import AppsIcon from '@mui/icons-material/Apps';
import FilterNoneIcon from '@mui/icons-material/FilterNone';

import { Game, gamesCollectionPublic, Tag, authorsCollectionPublic, AuthContext, CATALOG_GAME_FIELDS, PINNED_ORIGINAL_DAYS, loadPinnedSeen } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameGrid from './GameGrid';
import AnnouncementBanner from '../Announcements/AnnouncementBanner';
import { analytics } from '../../utils/analytics';
import { buildAliasIndex, resolveAlias, AliasIndex } from '../../utils/fuzzy';
import { inlineRatingTagIds, loadTagDictionary, tagMapOf } from '../../utils/tagDictionary';
import { SEARCH_HOME_EVENT } from '../../utils/searchTagBus';

interface SemanticResult { id: string; score: number; }
interface SemanticApiResponse { results: SemanticResult[]; }
interface AuthorOption { id: string; name: string; }

type SearchTab = 'recent' | 'top' | 'liked' | 'tags' | 'random' | 'semantic' | 'similar';
type TimeFrame = 'all' | 'month';
type FormatFilter = 'all' | 'img' | 'link';

const ITEMS_PER_PAGE = 25;
const RANDOM_WINDOW = 200;
const RANDOM_PICK = 20;
const TITLE_DEBOUNCE_MS = 350;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

// PINNED_ORIGINAL_DAYS (pin/badge window) imported from pocketbase so GameCard (badge) and here
// (pin query) don't diverge.
const defaultFilter = createFilterOptions<string>();

// Game by a blocked author? Author ids from the catalog expand (expand.authors.id in
// CATALOG_GAME_FIELDS), falling back to the denormalized `authors` field (in semantic/similar
// responses). Several authors: blocked if any is blocked.
const byBlockedAuthor = (game: Game, blocked: Set<string>): boolean => {
  const ids = game.expand?.authors?.map((a) => a.id) ?? game.authors ?? [];
  return ids.some((id) => blocked.has(id));
};

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
  filterMode: FilterMode;
  blockedTags: Tag[];
}

export default function SearchPage({
  selectedTags: headerSelectedTags,
  selectedAuthors: headerSelectedAuthors,
  filterMode,
  blockedTags,
}: SearchPageProps) {
  const theme = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const { user, blockedGameIds, blockedAuthorIds } = useContext(AuthContext);
  // Personal game blocklist filtered on the CLIENT (not in the PB filter) so catalog queries stay
  // anonymous and Cloudflare-cacheable. Covers all tabs incl. the window.__CATALOG__ seed, semantic
  // and similar.
  const blockedGameSet = useMemo(() => new Set(blockedGameIds), [blockedGameIds]);
  // Author blocklist, same scheme: CLIENT-side. Never put it in the catalog PB filter — per-user
  // sets give every user a unique query URL and a CF cache miss on every feed page (author's
  // decision for blocked_games, wiki/log.md 2026-07-13). Author ids already ride in the catalog
  // payload.
  const blockedAuthorSet = useMemo(() => new Set(blockedAuthorIds), [blockedAuthorIds]);

  const paperInputStyles: SxProps<Theme> = {
    p: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    backgroundColor: theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.05) : alpha(theme.palette.common.black, 0.03),
    borderRadius: 3, 
    transition: 'box-shadow 0.2s, background-color 0.2s',
    border: '1px solid transparent',
    '&:hover': {
      backgroundColor: theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.08) : alpha(theme.palette.common.black, 0.05),
    },
    '&:focus-within': {
      backgroundColor: theme.palette.background.paper,
      boxShadow: theme.shadows[2],
      borderColor: theme.palette.primary.main,
    }
  };

  const singleInputContainerSx: SxProps<Theme> = {
      maxWidth: 700, 
      mx: 'auto', 
      mb: 3 
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
        opacity: 0.6
    }
  };

  const toggleGroupSx: SxProps<Theme> = {
    '& .MuiToggleButton-root': { 
        borderRadius: '10px', 
        px: 2, 
        py: 0.5, 
        border: 0, 
        color: theme.palette.text.secondary,
        bgcolor: alpha(theme.palette.primary.main, 0.05), 
        '&.Mui-selected': { 
            bgcolor: alpha(theme.palette.primary.main, 0.15),
            color: theme.palette.text.primary,
            fontWeight: 600
        },
        '&:hover': {
            bgcolor: alpha(theme.palette.primary.main, 0.1), 
        }
    } 
  };

  const [currentTab, setCurrentTab] = useState<SearchTab>('recent');
  const [topTimeFrame, setTopTimeFrame] = useState<TimeFrame>('month');
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');

  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Pin above the feed: fresh author releases (PINNED_ORIGINAL_DAYS).
  const [pinnedGames, setPinnedGames] = useState<Game[]>([]);
  // Personal dismiss: pinned games the user already viewed (server for logged in, localStorage for
  // anon) are removed from the row. seenLoaded gates pin rendering so the raw all-pins version
  // never flashes.
  const [seenPinned, setSeenPinned] = useState<Set<string>>(new Set());
  const [seenLoaded, setSeenLoaded] = useState(false);

  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticScores, setSemanticScores] = useState<Map<string, number>>(new Map());
  
  const [similarSourceGame, setSimilarSourceGame] = useState<Game | null>(null);

  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [allTagsList, setAllTagsList] = useState<string[]>([]);
  const [tagAliasIndex, setTagAliasIndex] = useState<AliasIndex>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const [localSelectedTags, setLocalSelectedTags] = useState<string[]>([]);
  const [tagInputValue, setTagInputValue] = useState('');

  const [localSelectedAuthors, setLocalSelectedAuthors] = useState<string[]>([]);
  const [localTitleQuery, setLocalTitleQuery] = useState('');
  // The input updates per keystroke, the catalog QUERY doesn't: every letter used to rerun a full
  // PocketBase fetch, and slow networks got a queue of cancelled-but-already-sent requests. The
  // feed uses a copy lagging by TITLE_DEBOUNCE_MS.
  const [debouncedTitleQuery, setDebouncedTitleQuery] = useState('');

  useEffect(() => {
      const t = window.setTimeout(() => setDebouncedTitleQuery(localTitleQuery), TITLE_DEBOUNCE_MS);
      return () => window.clearTimeout(t);
  }, [localTitleQuery]);

  // User explicitly searches by authors → don't apply the author blocklist (explicit query beats
  // background hiding; clicking a blocked author's name gave an unexplained empty feed).
  const authorSearchActive =
    (currentTab === 'tags' ? localSelectedAuthors.length : headerSelectedAuthors.length) > 0;

  // Displayed = games minus personal blocklists, filtered at render (not fetch) so editing a
  // blocklist doesn't refetch or touch cacheable queries. Pagination/hasMore use raw games.
  const visibleGames = useMemo(() => {
    let out = blockedGameSet.size ? games.filter((g) => !blockedGameSet.has(g.id)) : games;
    if (blockedAuthorSet.size && !authorSearchActive) out = out.filter((g) => !byBlockedAuthor(g, blockedAuthorSet));
    return out;
  }, [games, blockedGameSet, blockedAuthorSet, authorSearchActive]);

  const [titleInputValue, setTitleInputValue] = useState('');
  const [titleOptions, setTitleOptions] = useState<Game[]>([]);
  const [loadingTitles, setLoadingTitles] = useState(false);

  const [authorInputValue, setAuthorInputValue] = useState('');
  const [authorOptions, setAuthorOptions] = useState<AuthorOption[]>([]);
  const [loadingAuthors, setLoadingAuthors] = useState(false);
 

  const observer = useRef<IntersectionObserver | null>(null);
  const seedAppliedRef = useRef(false);
  const prevFiltersRef = useRef<string>('');
const lastFetchedPageRef = useRef<number>(1);

const fetchGenerationRef = useRef(0);

  useEffect(() => {
    const queryParam = searchParams.get('q');
    const tagsParam = searchParams.get('tags');
    const authorsParam = searchParams.get('authors');
    const similarParam = searchParams.get('similar');

    if (similarParam) {
        setCurrentTab('similar');
        fetchSimilarGames(similarParam);
    } else if (queryParam || tagsParam || authorsParam) {
        setCurrentTab('tags');
        if (queryParam) {
            setLocalTitleQuery(queryParam);
            setTitleInputValue(queryParam);
        }
        if (tagsParam) setLocalSelectedTags(tagsParam.split(','));
        if (authorsParam) setLocalSelectedAuthors(authorsParam.split(','));
        setSemanticQuery('');
    }
  }, [searchParams]);

  // "Return home" (logo tap): home is one component with many internal states (tab + filters), not
  // distinct URLs, so navigating to "/" can't reset it. This snaps back to the default New feed:
  // clears tab, filters, semantic/similar state and ?q/?tags/etc.
  useEffect(() => {
    const onHome = () => {
      setCurrentTab('recent');
      setTopTimeFrame('month');
      setFormatFilter('all');
      setLocalSelectedTags([]);
      setLocalSelectedAuthors([]);
      setLocalTitleQuery('');
      setTitleInputValue('');
      setAuthorInputValue('');
      setTagInputValue('');
      setSemanticQuery('');
      setSemanticScores(new Map());
      setSimilarSourceGame(null);
      setPage(1);
      lastFetchedPageRef.current = 1;
      setHasMore(true);
      setGames([]);
      prevFiltersRef.current = '';  // force the catalog effect to refetch the feed
      setSearchParams({});
    };
    window.addEventListener(SEARCH_HOME_EVENT, onHome);
    return () => window.removeEventListener(SEARCH_HOME_EVENT, onHome);
  }, [setSearchParams]);

  useEffect(() => {
      let isMounted = true;
      (async () => {
        try {
          // One shared tag dictionary (utils/tagDictionary): version-checked against the HTML, so a
          // stale copy can't silently disable the NSFW filter.
          const dict = await loadTagDictionary();
          const newTagMap = tagMapOf(dict);

          // Empty (0-game) tags hidden from autocomplete options (author's complaint).
          const usedIds = new Set(dict.used);
          const allTags = Array.from(newTagMap.values());

          if (isMounted) {
              setTagMap(newTagMap);
              setTagAliasIndex(buildAliasIndex(allTags));
              const visible = usedIds.size ? allTags.filter(t => usedIds.has(t.id)) : allTags;
              setAllTagsList(visible.map(t => t.name).sort());
              setTagsLoaded(true);
          }
        } catch (error) {
            console.error(error);
            if(isMounted) setTagsLoaded(true);
        }
      })();
      return () => { isMounted = false; };
  }, []);

 const nsfwTagId = useMemo(() => {
    for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'nsfw') return id;
    }
    return inlineRatingTagIds()?.nsfw ?? null;
}, [tagMap]);

const extremeTagId = useMemo(() => {
    for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'extreme') return id;
    }
    return inlineRatingTagIds()?.extreme ?? null;
}, [tagMap]);

  const fetchTitleSuggestions = useMemo(
    () => debounce(async (request: { input: string }, callback: (results?: Game[]) => void) => {
        if (!request.input || request.input.length < 2) { callback([]); return; }
        try {
            const result = await gamesCollectionPublic.getList(1, 10, {
                filter: `(title ~ "${request.input}" || aliases ~ "${request.input}")`, sort: '-created', fields: 'id,title'
            });
            callback(result.items);
        } catch (error) { console.error(error); callback([]); }
    }, 300), []
  );

  useEffect(() => {
    let active = true;
    if (titleInputValue === '') { setTitleOptions([]); return undefined; }
    setLoadingTitles(true);
    fetchTitleSuggestions({ input: titleInputValue }, (results) => {
        if (active && results) { setTitleOptions(results); setLoadingTitles(false); }
    });
    return () => { active = false; };
  }, [titleInputValue, fetchTitleSuggestions]);

  const fetchAuthorSuggestions = useMemo(
      () => debounce(async (request: { input: string }, callback: (results?: AuthorOption[]) => void) => {
          if (!request.input || request.input.length < 2) { callback([]); return; }
          try {
              const result = await authorsCollectionPublic.getList(1, 10, { filter: `(name ~ "${request.input}" || aliases ~ "${request.input}")`, fields: 'id,name' });
              callback(result.items as unknown as AuthorOption[]);
          } catch (error) {
              console.error(error);
              callback([]);
          }
      }, 300), []
  );

  useEffect(() => {
      let active = true;
      if (authorInputValue === '') { setAuthorOptions([]); return undefined; }
      setLoadingAuthors(true);
      fetchAuthorSuggestions({ input: authorInputValue }, (results) => {
          if (active && results) { setAuthorOptions(results || []); setLoadingAuthors(false); }
      });
      return () => { active = false; };
  }, [authorInputValue, fetchAuthorSuggestions]);

  const filterTagOptions = (options: string[], params: { inputValue: string; getOptionLabel: (option: string) => string; }) => {
    const cleanedInput = params.inputValue.startsWith('-') ? params.inputValue.substring(1) : params.inputValue;
    return defaultFilter(options, { ...params, inputValue: cleanedInput });
  };

  const handleAddTag = (tagToAdd: string | null) => {
    if (!tagToAdd) return;
    const trimmedItem = tagToAdd.trim();
    if (!trimmedItem) return;
    const isNegative = trimmedItem.startsWith('-');
    const baseTagName = isNegative ? trimmedItem.substring(1) : trimmedItem;
    // Resolve synonym/typo to the canonical name: "Netorare"→NTR, "Gender Swap"→Gender Bender,
    // "trasnformation"→Transformation.
    const canonical =
      resolveAlias(baseTagName, tagAliasIndex) ??
      allTagsList.find(t => t.toLowerCase() === baseTagName.toLowerCase()) ??
      baseTagName;
    const finalTag = isNegative ? `-${canonical}` : canonical;
    setLocalSelectedTags([...new Set([...localSelectedTags, finalTag])]);
    setTagInputValue('');
  };

  const renderTagChips = (value: string[], getTagProps: AutocompleteRenderGetTagProps) => {
    return value.map((option: string, index: number) => {
      const { key, ...tagProps } = getTagProps({ index });
      const isNegative = option.startsWith('-');
      const label = isNegative ? option.substring(1) : option;
      
      const mainColor = isNegative ? theme.palette.error.main : theme.palette.success.main;

      return (
        <Chip 
            key={key}
            label={label}
            {...tagProps}
            variant="outlined"
            size="small"
            sx={{
                borderColor: mainColor,
                color: theme.palette.text.primary,
                height: '26px',
                fontSize: '0.85rem',
                borderRadius: '6px',
                m: '3px',
                borderWidth: '1px',
                '& .MuiChip-label': {
                    px: 1,
                    fontWeight: 500,
                },
                '& .MuiChip-deleteIcon': {
                    color: mainColor,
                    opacity: 0.7,
                    fontSize: '18px',
                    '&:hover': {
                        color: mainColor,
                        opacity: 1
                    }
                }
            }}
        />
      );
    });
  };

  const processGameData = (items: Record<string, unknown>[]): Game[] => {
      return items.map((item) => {
          const rawExpand = item['expand'] as Record<string, unknown> | undefined;
          const processedExpand = rawExpand ? {
              ...(rawExpand.authors ? { 
                  authors: Array.isArray(rawExpand.authors) ? rawExpand.authors : [rawExpand.authors] 
              } : {}),
              ...(rawExpand.tags ? { 
                  tags: Array.isArray(rawExpand.tags) ? rawExpand.tags : [rawExpand.tags] 
              } : {})
          } : {};

          return {
              ...item,
              expand: processedExpand
          } as Game;
      });
  };

  // Frame-2 seed: Go inlines the default catalog view into index.html as two `-created` top-page
  // arrays (getList response shape): `window.__CATALOG__` (SFW, nsfw/extreme excluded) and
  // `window.__CATALOG_ALL__` (no filter). Seed the grid from the one matching the active filter
  // mode BEFORE first paint, so cold visits render real cards immediately (no empty→cards CLS
  // jump). Seed only where the snapshot matches the upcoming fetch exactly: sfw → __CATALOG__, all
  // → __CATALOG_ALL__. nsfw-only is a different server-filtered set, not seeded. fetchGames then
  // reconciles by id. useLayoutEffect runs before paint.
  useLayoutEffect(() => {
      if (seedAppliedRef.current) return;
      if (currentTab !== 'recent') return;
      if (filterMode !== 'sfw' && filterMode !== 'all') return;
      if (headerSelectedTags.length || headerSelectedAuthors.length || blockedTags.length) return;
      if (searchParams.get('q') || searchParams.get('tags') || searchParams.get('authors') || searchParams.get('similar')) return;
      const win = window as unknown as { __CATALOG__?: unknown; __CATALOG_ALL__?: unknown };
      const seed = filterMode === 'sfw' ? win.__CATALOG__ : win.__CATALOG_ALL__;
      if (!Array.isArray(seed) || seed.length === 0) return;
      seedAppliedRef.current = true;
      setGames(processGameData(seed as Record<string, unknown>[]));
      setLoading(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The pin row shows only in the "clean" recent feed (no tags, authors, format filter) so it
  // doesn't compete with active filters.
  const showPinnedStrip = currentTab === 'recent'
    && headerSelectedTags.length === 0
    && headerSelectedAuthors.length === 0
    && formatFilter === 'all';

  useEffect(() => {
    if (!showPinnedStrip || !tagsLoaded) {
      setPinnedGames([]); setSeenPinned(new Set()); setSeenLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cutoff = new Date(Date.now() - PINNED_ORIGINAL_DAYS * ONE_DAY_IN_MS)
          .toISOString().replace('T', ' ').substring(0, 19);
        // Fresh author release = boolean games.original_release (not a tag).
        const filters = [`original_release = true`, `created >= "${cutoff}"`];
        if (filterMode === 'sfw') {
          if (nsfwTagId) filters.push(`tags.id != "${nsfwTagId}"`);
          if (extremeTagId) filters.push(`tags.id != "${extremeTagId}"`);
        } else if (filterMode === 'nsfw') {
          const conditions = [];
          if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
          if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
          if (conditions.length) filters.push(`(${conditions.join(' || ')})`);
          else filters.push('(1=0)');
        }
        if (blockedTags.length > 0) filters.push(...blockedTags.map(t => `tags.id != "${t.id}"`));
        const result = await gamesCollectionPublic.getList(1, 10, {
          sort: '-created', expand: 'authors,tags', filter: filters.join(' && '),
          fields: CATALOG_GAME_FIELDS,
        });
        if (cancelled) return;
        const items = processGameData(result.items as unknown as Record<string, unknown>[]);
        // Which pinned games the user already viewed: a tiny parallel id-only query (≤10
        // candidates). Both states set together; React 18 batches them into one render.
        const seen = await loadPinnedSeen(items.map((g) => g.id));
        if (cancelled) return;
        setPinnedGames(items);
        setSeenPinned(seen);
        setSeenLoaded(true);
      } catch {
        if (!cancelled) { setPinnedGames([]); setSeenPinned(new Set()); setSeenLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
    // processGameData is recreated every render — not in deps (like the seed effect). user in deps:
    // recompute "seen" on login/logout (server ↔ localStorage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPinnedStrip, tagsLoaded, filterMode, nsfwTagId, extremeTagId, blockedTags, user]);

  // Remove blocked and already-viewed games from the pin (personal dismiss). A viewed original
  // stays in the normal feed at its place — the pin is released, not the game.
  const visiblePinned = useMemo(
    () => pinnedGames.filter((g) => !blockedGameSet.has(g.id) && !seenPinned.has(g.id) && !byBlockedAuthor(g, blockedAuthorSet)),
    [pinnedGames, blockedGameSet, blockedAuthorSet, seenPinned],
  );
  const pinnedIds = useMemo(() => new Set(visiblePinned.map((g) => g.id)), [visiblePinned]);
  // Final feed: pinned originals first, then the rest without them (no duplicates, no row of their
  // own). Gated by seenLoaded so a pin that would vanish isn't shown.
  const feedGames = useMemo(
    () => (showPinnedStrip && seenLoaded && pinnedIds.size > 0
        ? [...visiblePinned, ...visibleGames.filter((g) => !pinnedIds.has(g.id))]
        : visibleGames),
    [showPinnedStrip, seenLoaded, visiblePinned, pinnedIds, visibleGames],
  );

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
        if (!tagsLoaded) return;
        if (currentTab === 'semantic' || currentTab === 'random' || currentTab === 'similar') return;
        
        if (currentTab === 'liked' && !user) {
            setGames([]);
            setHasMore(false);
            setLoading(false);
            return;
        }

        const generation = ++fetchGenerationRef.current;
        setLoading(true);
        try {
            const filterConditions: string[] = [];
            const isAdvancedTab = currentTab === 'tags';
            const activeTags = isAdvancedTab ? localSelectedTags : headerSelectedTags;
            const activeAuthors = isAdvancedTab ? localSelectedAuthors : headerSelectedAuthors;
            const activeTitleQuery = isAdvancedTab ? debouncedTitleQuery : '';

            if (activeTitleQuery) {
                const q = activeTitleQuery.replace(/"/g, '\\"');
                filterConditions.push(`(title ~ "${q}" || aliases ~ "${q}")`);
            }
            if (activeAuthors.length > 0) filterConditions.push(`(${activeAuthors.map(a => `authors.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`);

            const positiveSelectedTags: string[] = [];
            const negativeSelectedTagNames: string[] = [];
            activeTags.forEach(tag => {
                const neg = tag.startsWith('-');
                const raw = neg ? tag.substring(1) : tag;
                if (!raw) return;
                // Synonym/typo from the header or URL → canonical tag name, else an exact name
                // match yields 0.
                const canon = resolveAlias(raw, tagAliasIndex) ?? raw;
                if (neg) negativeSelectedTagNames.push(canon);
                else positiveSelectedTags.push(canon);
            });

            if (filterMode === 'sfw') {
                if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`);
                if (extremeTagId) filterConditions.push(`tags.id != "${extremeTagId}"`);
            } else if (filterMode === 'nsfw') {
                if (nsfwTagId || extremeTagId) {
                    const conditions = [];
                    if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
                    if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
                    filterConditions.push(`(${conditions.join(' || ')})`);
                } else filterConditions.push('(1=0)');
            }

            if (blockedTags.length > 0) filterConditions.push(...blockedTags.map(t => `tags.id != "${t.id}"`));
            if (negativeSelectedTagNames.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([,t]) => negativeSelectedTagNames.includes(t.name)).map(([id]) => id);
                if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`));
            }
            if (positiveSelectedTags.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([,t]) => positiveSelectedTags.includes(t.name)).map(([id]) => id);
                if (ids.length === positiveSelectedTags.length) filterConditions.push(...ids.map(id => `tags ~ "${id}"`));
                else filterConditions.push('(1=0)');
            }

            if (currentTab === 'top' && topTimeFrame === 'month') {
                const date = new Date(); date.setDate(date.getDate() - 30);
                filterConditions.push(`created >= "${date.toISOString().replace('T', ' ').substring(0, 19)}"`);
            }

            if (currentTab === 'liked' && user) {
                filterConditions.push(`upvotes ?~ "${user.id}"`);
            }

            if (formatFilter !== 'all') {
                filterConditions.push(`img_or_link = "${formatFilter}"`);
            }

            // "new" includes bumps: bumped_at = created at creation and moves forward on
            // owner/moderator bumps (game_edits.go).
            const sortOrder = currentTab === 'top' ? '-upvotes_count,-created' : '-bumped_at,-created';
            const result = await gamesCollectionPublic.getList(pageNum, ITEMS_PER_PAGE, {
                sort: sortOrder, expand: 'authors,tags', filter: filterConditions.join(' && '),
                fields: CATALOG_GAME_FIELDS,
            });

            // A newer fetch started during this one — ignore the stale response.
            if (fetchGenerationRef.current !== generation) return;

            setGames((prev) => {
                 const newG = processGameData(result.items as unknown as Record<string, unknown>[]);
                 if (isReset) return newG;
                 const existingIds = new Set(prev.map(g => g.id));
                 return [...prev, ...newG.filter(g => !existingIds.has(g.id))];
             });
            setHasMore(result.items.length === ITEMS_PER_PAGE);
        } catch (error) { 
            if (fetchGenerationRef.current !== generation) return;
            console.error(error); setHasMore(false); 
        } finally { 
            if (fetchGenerationRef.current === generation) setLoading(false);
        }
    },
    [tagsLoaded, headerSelectedTags, headerSelectedAuthors, localSelectedTags, localSelectedAuthors, debouncedTitleQuery, filterMode, blockedTags, currentTab, topTimeFrame, tagMap, tagAliasIndex, nsfwTagId, extremeTagId, formatFilter, user]
);

  const fetchRandomGames = async () => {
      setLoading(true); setGames([]); setHasMore(false);
      try {
          const filterConditions: string[] = [];
          if (filterMode === 'sfw') { if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`); if (extremeTagId) filterConditions.push(`tags.id != "${extremeTagId}"`); }
          else if (filterMode === 'nsfw') {
              // Parentheses are MANDATORY: conditions are joined with ' && ', and in PB filters (as
              // in SQL) && binds tighter than ||. Without them `A || B && format` became `A || (B
              // && format)` — nsfw games bypassed the format filter and blocked tags. Also only
              // known ids are substituted, else the literal "null" landed in the string.
              const conditions = [];
              if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
              if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
              filterConditions.push(conditions.length ? `(${conditions.join(' || ')})` : '1=0');
          }
          if (blockedTags.length > 0) filterConditions.push(...blockedTags.map(t => `tags.id != "${t.id}"`));

          if (formatFilter !== 'all') {
             filterConditions.push(`img_or_link = "${formatFilter}"`);
          }

          const baseFilter = filterConditions.join(' && ');

          // This used to fetch the ENTIRE catalog id list: getFullList pages by 500, so every
          // "Random" click sent a dozen sequential requests, growing with the catalog. Now a random
          // window: one request for the count, one for RANDOM_WINDOW ids, shuffle within the
          // window.
          const head = await gamesCollectionPublic.getList(1, 1, { filter: baseFilter, fields: 'id' });
          if (!head.totalItems) { setLoading(false); return; }

          const pages = Math.max(1, Math.ceil(head.totalItems / RANDOM_WINDOW));
          const windowPage = 1 + Math.floor(Math.random() * pages);
          const windowRes = await gamesCollectionPublic.getList(windowPage, RANDOM_WINDOW, { filter: baseFilter, fields: 'id' });

          let windowIds = windowRes.items;
          if (windowIds.length < RANDOM_PICK && pages > 1) {
              // The tail page can be shorter than the window — top up from the neighbor, or
              // "Random" returns three games instead of twenty.
              const extra = await gamesCollectionPublic.getList(windowPage === 1 ? 2 : 1, RANDOM_WINDOW, { filter: baseFilter, fields: 'id' });
              windowIds = [...windowIds, ...extra.items];
          }
          if (!windowIds.length) { setLoading(false); return; }

          // Fisher-Yates: sort() with a random comparator gives a biased permutation (some games
          // much more often) and sorts the source array in place.
          const pool = [...windowIds];
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          const shuffled = pool.slice(0, RANDOM_PICK);
          const randomG = await gamesCollectionPublic.getFullList({
              filter: shuffled.map(i => `id="${i.id}"`).join(' || '),
              expand: 'authors,tags',
              fields: CATALOG_GAME_FIELDS,
          });
          const picked = processGameData(randomG as unknown as Record<string, unknown>[]);
          for (let i = picked.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [picked[i], picked[j]] = [picked[j], picked[i]];
          }
          setGames(picked);
      } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const handleSemanticSearch = async (e?: React.FormEvent) => {
      if (e) e.preventDefault(); if (semanticQuery.trim().length < 2) return;
      analytics.semanticSearch({ source: 'catalog', query_len: semanticQuery.trim().length });
      setLoading(true); setGames([]); setHasMore(false);
      try {
          const res = await fetch(`/api/semantic-search?q=${encodeURIComponent(semanticQuery)}&mode=mixed`);
          if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Search failed'); }
          
          const data: SemanticApiResponse = await res.json();
          if (!data.results || data.results.length === 0) { setLoading(false); return; }
          
          const scoreMap = new Map<string, number>();
          data.results.forEach((r) => scoreMap.set(r.id, r.score));
          setSemanticScores(scoreMap);
          
          const pbGames = await gamesCollectionPublic.getFullList({ filter: data.results.map((r)=>`id="${r.id}"`).join('||'), expand: 'authors,tags', fields: CATALOG_GAME_FIELDS });
          
          const matchedGames = data.results
             .map((r) => pbGames.find((g) => g.id === r.id))
             .filter((g): g is Game => !!g);

          setGames(processGameData(matchedGames as unknown as Record<string, unknown>[]));
      } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const fetchSimilarGames = async (gameId: string) => {
    setLoading(true); setGames([]); setHasMore(false);
    try {
        const res = await fetch(`/api/similar-games/${gameId}`);
        if (!res.ok) {
             const err = await res.json();
             if(res.status === 404) { 
                 console.warn("Game AI data not found");
             }
             throw new Error(err.detail || 'Similarity search failed'); 
        }
        
        const data: SemanticApiResponse = await res.json();
        if (!data.results || data.results.length === 0) { setLoading(false); return; }

        const scoreMap = new Map<string, number>();
        data.results.forEach((r) => scoreMap.set(r.id, r.score));
        setSemanticScores(scoreMap);

        const pbGames = await gamesCollectionPublic.getFullList({ filter: data.results.map((r)=>`id="${r.id}"`).join('||'), expand: 'authors,tags', fields: CATALOG_GAME_FIELDS });
        
        const matchedGames = data.results
            .map((r) => pbGames.find((g) => g.id === r.id))
            .filter((g): g is Game => !!g);

        setGames(processGameData(matchedGames as unknown as Record<string, unknown>[]));
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  const handleTabChange = (_: React.SyntheticEvent, newValue: SearchTab) => {
      analytics.tabSwitch(newValue);
      setCurrentTab(newValue);
      setPage(1); 
    lastFetchedPageRef.current = 1; 
      setHasMore(true); 
      setGames([]); 
      setSimilarSourceGame(null); 
      prevFiltersRef.current = '';
      
      if (newValue !== 'similar' && newValue !== 'tags') {
          setSearchParams({});
      }

      if (newValue === 'random') fetchRandomGames();
  };

  useEffect(() => {
      if (!tagsLoaded) return;
      if (currentTab === 'semantic' || currentTab === 'random' || currentTab === 'similar') return;
      
      const currentFilters = JSON.stringify({
          headerTags: headerSelectedTags, headerAuthors: headerSelectedAuthors,
          localTags: localSelectedTags, localAuthors: localSelectedAuthors,
          title: debouncedTitleQuery,
          mode: filterMode, blocked: blockedTags.map(t=>t.id), tab: currentTab, time: topTimeFrame,
          format: formatFilter, userId: user?.id,
          nsfwTagId, extremeTagId
      });
      if (prevFiltersRef.current !== currentFilters) {
          prevFiltersRef.current = currentFilters;
          setPage(1); lastFetchedPageRef.current = 1; setHasMore(true); fetchGames(1, true);
      }
  }, [tagsLoaded, headerSelectedTags, headerSelectedAuthors, localSelectedTags, localSelectedAuthors,
      debouncedTitleQuery, filterMode, blockedTags, currentTab, topTimeFrame, formatFilter, user, fetchGames,
      nsfwTagId, extremeTagId
  ]);

  // The main effect skips the Random tab, so format or NSFW filter changes didn't reshuffle — it
  // kept the old mixed selection until "Roll Again". Reshuffle here. Compare VALUES, not references
  // (like prevFiltersRef): blockedTags arrives as a new array on every authStore.onChange, incl.
  // when another tab refreshed the token — middle-clicking a card opened a tab that refreshed the
  // token and the old tab rerolled, pulling the selection from under the user. Such empty updates
  // are ignored.
  const randomRollKeyRef = useRef<string | null>(null);
  useEffect(() => {
      const key = JSON.stringify({
          format: formatFilter,
          mode: filterMode,
          blocked: blockedTags.map((t) => t.id),
      });
      if (randomRollKeyRef.current === key) return;
      randomRollKeyRef.current = key;
      if (currentTab !== 'random') return;
      fetchRandomGames();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatFilter, filterMode, blockedTags]);

useEffect(() => {
    const isStandardTab = ['recent','top','liked','tags'].includes(currentTab);
    
    if (page > 1 && hasMore && !loading && isStandardTab) {
        // Loop guard: don't request the same page twice.
        if (lastFetchedPageRef.current === page) return;

        lastFetchedPageRef.current = page;
        fetchGames(page, false);
    }
}, [page, hasMore, loading, currentTab, fetchGames]);

  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
      if (loading || !hasMore || ['semantic','random','similar'].includes(currentTab)) return;
      if (observer.current) observer.current.disconnect();
      // ~1.5 screens ahead, else the footer shows and then gets pushed away (layout shift).
      observer.current = new IntersectionObserver(entries => { if (entries[0].isIntersecting) setPage(p => p + 1); }, { rootMargin: '0px 0px 1500px 0px' });
      if (node) observer.current.observe(node);
  }, [loading, hasMore, currentTab]);


  return (
      <Container maxWidth={false} disableGutters sx={{ maxWidth: '2200px', mx: 'auto', px: { xs: 1, sm: 2, md: 3 }, pt: 0, pb: 1 }}>

            <AnnouncementBanner />

            <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <Paper
                elevation={0}
                sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    p: 0.5,
                    backgroundColor: alpha(theme.palette.text.primary, 0.04),
                    borderRadius: '16px',
                    
                    width: 'fit-content', 
                    maxWidth: '100%',
                }}
                >
                    <Tabs
                    value={currentTab}
                    onChange={handleTabChange}
                    sx={{
                        minHeight: 'unset',
                        '& .MuiTabs-indicator': { display: 'none' },
                        
                        '& .MuiTabs-flexContainer': {
                            flexWrap: 'wrap',
                            justifyContent: 'center',
                            gap: 0.5
                        },
                        
                        '& .MuiTab-root': {
                            textTransform: 'none',
                            minHeight: '40px',
                            fontWeight: 600,
                            borderRadius: '12px',
                            px: { xs: 1, sm: 2 },
                            mr: 0,
                            
                            // On phones (xs) buttons stretch to fill the row (flexGrow: 1); from sm
                            // up they take their own size.
                            flexGrow: { xs: 1, sm: 0 }, 
                            maxWidth: { xs: '100%', sm: 'none' },

                            '&.Mui-selected': {
                                backgroundColor: theme.palette.background.paper,
                                boxShadow: theme.shadows[1],
                                color: theme.palette.primary.main
                            }
                        }
                    }}
                    >
                        <Tab value="recent" label="New" icon={<NewReleasesIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="top" label="Top" icon={<EmojiEventsIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="liked" label="Liked" icon={<FavoriteIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="tags" label="Search" icon={<SearchIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="random" label="Random" icon={<ShuffleIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="similar" label="Similar" icon={<FilterNoneIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="semantic" label="Semantic" icon={<PsychologyIcon fontSize="small" />} iconPosition="start"/>
                    </Tabs>
                </Paper>
                 

              {['recent', 'top', 'liked', 'tags'].includes(currentTab) && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', alignItems: 'center' }}>
                      <ToggleButtonGroup value={formatFilter} exclusive onChange={(_, n) => n && setFormatFilter(n)} size="small" sx={toggleGroupSx}>
                          <ToggleButton value="all" aria-label="All Formats"><Tooltip title="All Formats"><AppsIcon fontSize="small" /></Tooltip></ToggleButton>
                          <ToggleButton value="img" aria-label="Static Images"><Tooltip title="Static Images"><ImageIcon fontSize="small" /></Tooltip></ToggleButton>
                          <ToggleButton value="link" aria-label="Interactive"><Tooltip title="Interactive"><TouchAppIcon fontSize="small" /></Tooltip></ToggleButton>
                      </ToggleButtonGroup>
                      {currentTab === 'top' && (
                          <>
                            <Divider orientation="vertical" flexItem sx={{ height: 24, alignSelf: 'center' }} />
                            <ToggleButtonGroup value={topTimeFrame} exclusive onChange={(_, n) => n && setTopTimeFrame(n)} size="small" sx={toggleGroupSx}>
                                <ToggleButton value="month">Month</ToggleButton>
                                <ToggleButton value="all">All Time</ToggleButton>
                            </ToggleButtonGroup>
                          </>
                      )}
                  </Box>
              )}

              {currentTab === 'random' && (
                  <Box sx={{ display: 'flex', gap: 2 }}>
                     <ToggleButtonGroup value={formatFilter} exclusive onChange={(_, n) => n && setFormatFilter(n)} size="small" sx={toggleGroupSx}>
                          <ToggleButton value="all"><AppsIcon fontSize="small" /></ToggleButton>
                          <ToggleButton value="img"><ImageIcon fontSize="small" /></ToggleButton>
                          <ToggleButton value="link"><TouchAppIcon fontSize="small" /></ToggleButton>
                      </ToggleButtonGroup>
                      <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => fetchRandomGames()} disabled={loading} size="small" sx={{ borderRadius: 3, px:3 }}>
                        Roll Again
                      </Button>
                  </Box>
              )}
          </Box>

          {currentTab === 'tags' && (
              <Box sx={{ maxWidth: 1000, mx: 'auto', mb: 3 }}>
                  <Grid container spacing={1.5} alignItems="center">
                      <Grid item xs={12} md={3.5}>
                          <Paper sx={paperInputStyles} elevation={0}>
                              <TitleIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                              <Autocomplete
                                  freeSolo fullWidth options={titleOptions} loading={loadingTitles}
                                  getOptionLabel={(o) => (typeof o === 'string' ? o : o.title)} inputValue={titleInputValue}
                                  onInputChange={(_, v) => { setTitleInputValue(v); if (!v) setLocalTitleQuery(''); }}
                                  onChange={(_, v) => setLocalTitleQuery(typeof v === 'string' ? v : v?.title || '')}
                                  renderInput={(params) => (<TextField {...params} placeholder="Title..." sx={textFieldSx} InputProps={{ ...params.InputProps, endAdornment: loadingTitles ? <CircularProgress size={16} /> : null }} />)}
                              />
                          </Paper>
                      </Grid>
                      <Grid item xs={12} md={5}>
                          <Paper sx={paperInputStyles} elevation={0}>
                              <LocalOfferIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                              <Autocomplete
                                multiple freeSolo fullWidth options={allTagsList} value={localSelectedTags} inputValue={tagInputValue}
                                onInputChange={(_, v) => setTagInputValue(v)}
                                onChange={(_, v, r, d) => { if (r === 'selectOption' && d?.option) handleAddTag(tagInputValue.startsWith('-') ? `-${d.option}` : d.option); else setLocalSelectedTags(v as string[]); }}
                                filterOptions={filterTagOptions} 
                                renderTags={(v, p) => renderTagChips(v, p)}
                                renderInput={(params) => (<TextField {...params} placeholder={localSelectedTags.length ? '' : "Tags (e.g. RPG, -Horror)"} sx={textFieldSx} onKeyDown={(e) => { if (e.key==='Enter' && tagInputValue) { e.preventDefault(); handleAddTag(tagInputValue); } }} />)}
                              />
                          </Paper>
                      </Grid>
                      <Grid item xs={12} md={3.5}>
                           <Paper sx={paperInputStyles} elevation={0}>
                                <PersonSearchIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                                <Autocomplete
                                    multiple freeSolo fullWidth options={authorOptions} loading={loadingAuthors}
                                    getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)} inputValue={authorInputValue}
                                    onInputChange={(_, v) => setAuthorInputValue(v)} value={localSelectedAuthors.map(n => ({ id: n, name: n }))}
                                    onChange={(_, v) => setLocalSelectedAuthors(v.map(i => typeof i === 'string' ? i : i.name))}
                                    renderTags={(v, p) => renderTagChips(v.map(i => typeof i === 'string' ? i : i.name), p)}
                                    renderInput={(params) => (<TextField {...params} placeholder={localSelectedAuthors.length ? '' : "Authors..."} sx={textFieldSx} InputProps={{ ...params.InputProps, endAdornment: loadingAuthors ? <CircularProgress size={16} /> : null }} />)}
                                />
                           </Paper>
                      </Grid>
                  </Grid>
              </Box>
          )}

          {currentTab === 'similar' && (
             <Box sx={singleInputContainerSx}>
                <Paper sx={paperInputStyles} elevation={0}>
                    <FilterNoneIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.4rem' }} />
                    <Autocomplete
                        freeSolo fullWidth
                        options={titleOptions}
                        loading={loadingTitles}
                        getOptionLabel={(o) => (typeof o === 'string' ? o : o.title)}
                        inputValue={titleInputValue}
                        onInputChange={(_, v) => setTitleInputValue(v)}
                        onChange={(_, v) => {
                            if (v && typeof v !== 'string') {
                                setSimilarSourceGame(v);
                                fetchSimilarGames(v.id);
                            }
                        }}
                        renderInput={(params) => (
                            <TextField 
                                {...params} 
                                placeholder="Type game name to find lookalikes..." 
                                sx={textFieldSx}
                                InputProps={{ 
                                    ...params.InputProps, 
                                    endAdornment: loadingTitles ? <CircularProgress size={16} /> : null 
                                }}
                            />
                        )}
                    />
                </Paper>
             </Box>
          )}

          {currentTab === 'semantic' && (
             <Box sx={singleInputContainerSx}>
                <Paper
                    component="form"
                    onSubmit={handleSemanticSearch}
                    elevation={0}
                    sx={paperInputStyles}
                >
                    <InputAdornment position="start" sx={{ pl: 1, mr: 1 }}>
                        <PsychologyIcon color="action" sx={{ fontSize: '1.4rem' }} />
                    </InputAdornment>
                    <TextField
                        fullWidth variant="outlined"
                        placeholder="Describe the game you are looking for..."
                        value={semanticQuery}
                        onChange={(e) => setSemanticQuery(e.target.value)}
                        sx={textFieldSx}
                    />
                    <Tooltip title="Search">
                        <IconButton type="submit" color="primary" sx={{ p: '8px', mr: 0.5 }} disabled={loading}>
                            {loading ? <CircularProgress size={20} /> : <SearchIcon />}
                        </IconButton>
                    </Tooltip>
                </Paper>
             </Box>
          )}

          <Box sx={{ minHeight: 400 }}>
            
            {currentTab === 'liked' && !user && (
                <Box sx={{ textAlign: 'center', mt: 8, opacity: 0.8 }}>
                    <FavoriteIcon sx={{ fontSize: 60, color: 'text.secondary', mb: 2, opacity: 0.5 }} />
                    <Typography variant="h5" gutterBottom>Your Favorites</Typography>
                    <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
                        Login to see the games you've liked.
                    </Typography>
                    <Button variant="contained" color="primary" onClick={() => navigate('/login')}>
                        Login / Sign Up
                    </Button>
                </Box>
            )}

            {loading && visibleGames.length === 0 && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>}

            {!loading && visibleGames.length === 0 && (currentTab !== 'liked' || user) && (
                <Box sx={{ textAlign: 'center', mt: 8, opacity: 0.7, maxWidth: 600, mx: 'auto' }}>
                    
                    {currentTab === 'semantic' && (
                        <Box>
                            <Typography variant="body1" sx={{ mb: 1, fontSize: '1.05rem' }}>
                                Find games by describing them in plain English.
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Try: <i>"Isekai with kingdom building"</i> or <i>"Horror game about being trapped in a loop"</i>.
                            </Typography>
                        </Box>
                    )}

                    {currentTab === 'similar' && (
                         <Box>
                            {similarSourceGame ? (
                                <>
                                    <Typography variant="h6">No similarities found</Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        We couldn't find games close enough to {similarSourceGame.title}.
                                    </Typography>
                                </>
                            ) : (
                                <>
                                     <Typography variant="body1" sx={{ mb: 1, fontSize: '1.05rem' }}>
                                        Find Similar Games
                                    </Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        Select a game from the list above to see what matches its vibe.
                                    </Typography>
                                </>
                            )}
                        </Box>
                    )}

                    {currentTab !== 'semantic' && currentTab !== 'similar' && (
                        <>
                            <Typography variant="h6">No results found</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {currentTab === 'liked' ? "You haven't liked any games yet." : "Try adjusting your filters."}
                            </Typography>
                        </>
                    )}
                </Box>
            )}
            
            {currentTab === 'similar' && similarSourceGame && !loading && visibleGames.length > 0 && (
                 <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2, opacity: 0.8 }}>
                    Showing games similar to <b>{similarSourceGame.title}</b>
                </Typography>
            )}

            {/*
              Pinned fresh author releases go at the START of the feed (first in the row, with the
              ORIGINAL chip), not a separate strip (one game shouldn't take the whole first row).
              Removed from the tail (dedupe).
            */}
            {feedGames.length > 0 && (
                <GameGrid
                    games={feedGames}
                    scores={currentTab === 'semantic' || currentTab === 'similar' ? semanticScores : undefined}
                    lastElementRef={lastGameElementRef}
                />
            )}

            {loading && visibleGames.length > 0 && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}><CircularProgress size={24} /></Box>}
          </Box>

      </Container>
  );
}