// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

declare global {
    interface Window {
        __INITIAL_DATA__?: {
            items: any[];
            page: number;
            perPage: number;
            totalItems: number;
            totalPages: number;
        } | null;
    }
}

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
  filterMode: FilterMode;
  blockedTags: Tag[];
}

export default function SearchPage({
  selectedTags,
  selectedAuthors,
  filterMode,
  blockedTags,
}: SearchPageProps) {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(!window.__INITIAL_DATA__);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const initialFetchPerformedRef = useRef<boolean>(false);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);

  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[]
  } | null>(null);

  const processGameData = (items: any[]): Game[] => {
      // ... (без изменений)
      return items.map(game => {
          const expandData = game.expand || {};
          const tagsData = expandData.tags;
          const authorsData = expandData.authors_via_games;
          return {
              ...game,
              expand: {
                  ...(expandData.authors_via_games && { authors_via_games: Array.isArray(authorsData) ? authorsData : (authorsData ? [authorsData] : []) }),
                  ...(expandData.tags && { tags: Array.isArray(tagsData) ? tagsData : (tagsData ? [tagsData] : []) }),
              }
          } as Game;
      });
  };

  useEffect(() => {
      // ... (Effect to find NSFW tag ID - без изменений)
      if (tagsLoaded && tagMap.size > 0) {
          let foundNsfwId: string | null = null;
          for (const [id, tag] of tagMap.entries()) { if (tag.name.toLowerCase() === 'nsfw') { foundNsfwId = id; break; } }
          setNsfwTagId(foundNsfwId);
      }
  }, [tagsLoaded, tagMap]);

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
        // ... (Логика fetchGames - без изменений, включая console.log)
        const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
        const canFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

        if (!canFetch) {
            console.warn(`[fetchGames] Cannot fetch page ${pageNum}. Conditions not met: tagsLoaded=${tagsLoaded}, nsfwFilterActive=${nsfwFilterActive}, nsfwTagId=${nsfwTagId}`);
            if (tagsLoaded && nsfwFilterActive && nsfwTagId === null) { setLoading(true); } else { setLoading(false); } // Установим loading false если не ждем nsfwId
            return;
        }

        console.log(`[fetchGames] Attempting to fetch page ${pageNum}. Reset: ${isReset}.`);
        setLoading(true);

        try {
            console.log(`[fetchGames] Starting API call for page ${pageNum}...`);
            // --- Filter logic ---
            const filterConditions: string[] = [];
            const blockedTagIds = blockedTags.map(tag => tag.id);
            const positiveSelectedTags: string[] = [];
            const negativeSelectedTagNames: string[] = [];
            selectedTags.forEach(tag => { if (tag.startsWith('-')) { const n = tag.substring(1); if(n) negativeSelectedTagNames.push(n); } else { positiveSelectedTags.push(tag); } });
            if (positiveSelectedTags.length > 0) { const ids = Array.from(tagMap.entries()).filter(([_,t])=>positiveSelectedTags.includes(t.name)).map(([id,_])=>id); if (ids.length===positiveSelectedTags.length) { filterConditions.push(...ids.map(id=>`tags ~ "${id}"`)); } else { console.warn("Pos tags mismatch"); filterConditions.push('(1=0)'); }}
            if (selectedAuthors.length > 0) { filterConditions.push(`(${selectedAuthors.map(a => `authors_via_games.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`); }
            if (filterMode === 'sfw') { if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`); else console.warn("SFW filter needs NSFW tag ID, which is null."); }
            else if (filterMode === 'nsfw') { if (nsfwTagId) filterConditions.push(`tags ~ "${nsfwTagId}"`); else { console.warn("NSFW filter needs NSFW tag ID, which is null. Blocking results."); filterConditions.push('(1=0)'); } }
            if (negativeSelectedTagNames.length > 0) { const ids = Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id); if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`)); if(ids.length !== negativeSelectedTagNames.length) console.warn("Neg tags mismatch"); }
            if (blockedTagIds.length > 0) { const negIds = new Set(Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id)); const finalBlocked = blockedTagIds.filter(bId => !negIds.has(bId)); if (finalBlocked.length > 0) filterConditions.push(...finalBlocked.map(id => `tags.id != "${id}"`)); }
            // --- End Filter ---
            const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
            console.log(`[fetchGames] Filter string for page ${pageNum}:`, filterString || '""'); // Логируем фильтр
            const expandRelations = 'authors_via_games,tags,tags.tag_categories_via_tags';
            const fieldsToFetch = ['id','title','description','image','image_base64','upvotes_count','comments_count','authors','expand.authors_via_games.name','expand.tags.id','expand.tags.name','expand.tags.expand.tag_categories_via_tags.name'].join(',');

            const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, { sort: '-created', expand: expandRelations, filter: filterString, fields: fieldsToFetch });
            console.log(`[fetchGames] API call SUCCESS for page ${pageNum}. Received ${fetchedGamesResult.items.length} items.`);

            const gamesFromApi = processGameData(fetchedGamesResult.items);

            setGames((prevGames) => {
                 const newGames = isReset ? gamesFromApi : [...prevGames, ...gamesFromApi];
                 const uniqueGames = Array.from(new Map(newGames.map(g => [g.id, g])).values());
                 return uniqueGames;
             });
            const newHasMore = fetchedGamesResult.items.length === ITEMS_PER_PAGE;
            setHasMore(newHasMore);
            console.log(`[fetchGames] State updated for page ${pageNum}. HasMore set to: ${newHasMore}`);

        } catch (error: any) {
            console.error(`[fetchGames] API call FAILED for page ${pageNum}:`, error);
            setHasMore(false);
            console.log(`[fetchGames] Error occurred. HasMore set to false.`);
        } finally {
            setLoading(false);
            console.log(`[fetchGames] FINALLY block executed for page ${pageNum}. Loading set to false.`);
        }
    },
    // Зависимости fetchGames остаются прежними (кроме loading, если убрали из лога)
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, tagMap]
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount
  useEffect(() => {
      // ... (Effect #1: Tags - без изменений)
      let isMounted = true;
      console.log("[Effect #1: Tags] Mounting. Fetching tags...");
      (async () => {
        try {
          const cachedTags = localStorage.getItem('tagMap'); const lastUpdated = localStorage.getItem('tagMapLastUpdated'); const now = Date.now(); let newTagMap: Map<string, Tag>;
          if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) { newTagMap = new Map(JSON.parse(cachedTags)); /* console.log("[Effect #1: Tags] Using cached tags."); */ }
          else { const ft = await tagsCollection.getFullList(500,{fields:'id,name',sort:'name'}); newTagMap = new Map((ft as Tag[]).map(t=>[t.id,t])); localStorage.setItem('tagMap',JSON.stringify([...newTagMap])); localStorage.setItem('tagMapLastUpdated',now.toString()); console.log("[Effect #1: Tags] Fetched and cached new tags."); }
          if (isMounted) { setTagMap(newTagMap); setTagsLoaded(true); /* console.log("[Effect #1: Tags] Tags loaded into state."); */}
        } catch (error) { console.error('[Effect #1: Tags] Error:', error); if(isMounted){ setTagsLoaded(true); setLoading(false); console.log("[Effect #1: Tags] Error occurred, setting tagsLoaded=true, loading=false.");}}
      })();
      return () => { isMounted = false; /* console.log("[Effect #1: Tags] Unmounting."); */};
  }, []);

  // 2. Initial Data Handling (Check Preload THEN Fetch)
  useEffect(() => {
      // ... (Effect #2: Initial Load - без изменений)
      console.log(`[Effect #2: Initial Load] Running. Initial fetch performed: ${initialFetchPerformedRef.current}`);
      if (!initialFetchPerformedRef.current) {
        if (window.__INITIAL_DATA__ && Array.isArray(window.__INITIAL_DATA__.items)) {
            console.log("[Effect #2: Initial Load] Using preloaded data.");
            const preloadedItems = window.__INITIAL_DATA__.items;
            const gamesFromPreload = processGameData(preloadedItems);
            setGames(gamesFromPreload);
            setHasMore(preloadedItems.length === ITEMS_PER_PAGE);
            setLoading(false);
            setPage(1);
            initialFetchPerformedRef.current = true;
            console.log("[Effect #2: Initial Load] Preloaded data processed. initialFetchPerformed=true, loading=false, page=1.");
            window.__INITIAL_DATA__ = null;
        } else {
            console.log("[Effect #2: Initial Load] Preloaded data not found. Checking readiness for fetch...");
            const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
            const readyToFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

            if (readyToFetch) {
                console.log("[Effect #2: Initial Load] Ready to fetch initial data (Page 1). Setting initialFetchPerformed=true and calling fetchGames.");
                initialFetchPerformedRef.current = true;
                setPage(1);
                fetchGames(1, true);
            } else {
                 if (!tagsLoaded || (nsfwFilterActive && nsfwTagId === null)) {
                      console.log("[Effect #2: Initial Load] Waiting for dependencies (tags/nsfwId). Setting loading=true.");
                      setLoading(true);
                 } else {
                     console.log("[Effect #2: Initial Load] Not ready to fetch yet, but dependencies seem met? Waiting cycle.");
                 }
            }
        }
      } else {
          // console.log("[Effect #2: Initial Load] Skipped, initial fetch already performed.");
      }
  }, [tagsLoaded, filterMode, nsfwTagId, fetchGames]);

  // 3. Handle Filter Changes (после initial load)
  useEffect(() => {
      // ... (Effect #3: Filter Change - без изменений)
      // console.log(`[Effect #3: Filter Change] Running. Initial fetch performed: ${initialFetchPerformedRef.current}, Tags loaded: ${tagsLoaded}`);
      if (!initialFetchPerformedRef.current || !tagsLoaded) {
          // console.log("[Effect #3: Filter Change] Skipped: Waiting for initial fetch and tags.");
          return;
      }
      const currentBlockedIds = blockedTags.map(t => t.id).sort();
      const sortedTags = [...selectedTags].sort();
      const sortedAuthors = [...selectedAuthors].sort();
      const currentFilters = { tags: sortedTags, authors: sortedAuthors, mode: filterMode, blocked: currentBlockedIds };
      if (prevFiltersRef.current === null) {
          // console.log("[Effect #3: Filter Change] First run after init. Storing initial filters, NO refetch triggered.");
          prevFiltersRef.current = currentFilters;
          return;
      }
      if (JSON.stringify(currentFilters) === JSON.stringify(prevFiltersRef.current)) {
        // console.log("[Effect #3: Filter Change] Skipped: Filters haven't changed since last check.");
        return;
      }
      console.log("[Effect #3: Filter Change] Filters CHANGED, refetching page 1.", { prev: prevFiltersRef.current, current: currentFilters });
      prevFiltersRef.current = currentFilters;
      setPage(1);
      setHasMore(true);
      fetchGames(1, true);
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames]);


  // 4. Infinite Scroll - Fetch More Games --- ИЗМЕНЕННЫЙ EFFECT ---
  useEffect(() => {
    console.log(`[Effect #4: Infinite Scroll on Page Change] Page is now ${page}. Checking conditions.`);
    // Этот эффект теперь зависит ТОЛЬКО от `page`.
    // Мы читаем `hasMore`, `loading`, `initialFetchPerformedRef` и `fetchGames`
    // но эффект не будет перезапускаться при их изменении.

    // Условия для запуска fetch:
    // 1. Это не первая страница (т.к. первая загружается в Effect #2 или #3)
    // 2. Флаг `hasMore` установлен (есть смысл запрашивать)
    // 3. Загрузка в данный момент НЕ идет (`!loading`) - важно, чтобы не запускать параллельные запросы одной страницы
    // 4. Начальная загрузка была выполнена (`initialFetchPerformedRef.current`)
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      console.log(`[Effect #4: Infinite Scroll on Page Change] Conditions met! Calling fetchGames for page ${page}.`);
      // Вызываем fetchGames для ТЕКУЩЕЙ страницы `page`
      fetchGames(page, false);
    } else {
      // Логируем, почему пропустили (для отладки)
      let skipReason = [];
      if (page <= 1) skipReason.push("page is 1");
      if (!hasMore) skipReason.push("hasMore is false");
      if (loading) skipReason.push("loading is true");
      if (!initialFetchPerformedRef.current) skipReason.push("initial fetch not done");
      // Не выводим лог, если просто page=1, чтобы не засорять консоль при инициализации
      if (page > 1 && skipReason.length > 0) {
           console.log(`[Effect #4: Infinite Scroll on Page Change] Skipping fetch for page ${page}. Reasons: ${skipReason.join(', ')}`);
      }
    }
  // --- КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: Массив зависимостей ---
  // Теперь эффект сработает только при изменении `page`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]); // <<< ЗАВИСИМОСТЬ ТОЛЬКО ОТ `page`


  // --- Intersection Observer ---
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
    // ... (Логика Intersection Observer - без изменений)
     if (loading) {
         if (observer.current) observer.current.disconnect();
         return;
     }
    if (!hasMore) {
        if (observer.current) observer.current.disconnect();
        return;
    }
    if (observer.current) observer.current.disconnect();

    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        console.log("[Observer Internal Callback] Element is intersecting! Incrementing page.");
        // Просто увеличиваем страницу. Эффект #4 отреагирует на это изменение.
        setPage(p => p + 1);
      }
    });
    if (node) {
        observer.current.observe(node);
    }
  }, [loading, hasMore]); // Зависимости useCallback для observer остаются (loading нужен для отключения)

  // Memoize games
  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component ---
  return (
      // ... (Render JSX - без изменений)
      <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
          <Typography variant="h3" component="h1" sx={{ mt: -4, mb: 3, textAlign: 'center', fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },   ...(theme.custom?.cardTitle || { fontWeight: 'bold' }), }} >
              {isSearchActive ? 'Search Results' : 'Recent Uploads'}
          </Typography>
          {loading && games.length === 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}><CircularProgress /></Box>
          )}
          {games.length > 0 && (
              <Grid2 container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
                  {memoizedGames.map((game, index) => (
                     <Grid2
                       size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                       key={`search-${game.id}-${index}`}
                       ref={index === memoizedGames.length - 1 ? lastGameElementRef : null}
                     >
                       <GameCard game={game} variant="standard"/>
                     </Grid2>
                   ))}
              </Grid2>
          )}
           {loading && games.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}><CircularProgress size={30} /></Box>
          )}
          {!loading && !hasMore && games.length > 0 && initialFetchPerformedRef.current && (
              <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
          )}
          {!loading && games.length === 0 && initialFetchPerformedRef.current && (
              <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
                  {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'}
              </Typography>
          )}
      </Box>
  );
}