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
    if (tagsLoaded && tagMap.size > 0) {
      let foundNsfwId: string | null = null;
      for (const [id, tag] of tagMap.entries()) { if (tag.name.toLowerCase() === 'nsfw') { foundNsfwId = id; break; } }
      setNsfwTagId(foundNsfwId);
      // if (!foundNsfwId && tagsLoaded) console.warn("[Tag ID Finder] NSFW tag ID not found in loaded tagMap!");
    }
  }, [tagsLoaded, tagMap]);

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
      const canFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

      if (!canFetch) {
        console.warn(`[fetchGames] Cannot fetch page ${pageNum}. Conditions not met: tagsLoaded=${tagsLoaded}, nsfwFilterActive=${nsfwFilterActive}, nsfwTagId=${nsfwTagId}`);
        // Если ждем NSFW ID, оставляем лоадер
        if (tagsLoaded && nsfwFilterActive && nsfwTagId === null) { setLoading(true); }
        return;
      }

      console.log(`[fetchGames] Attempting to fetch page ${pageNum}. Reset: ${isReset}. Current loading state: ${loading}`); // Убрали 'Current loading state' из лога, т.к. он сразу станет true
      setLoading(true); // Устанавливаем загрузку ПЕРЕД запросом

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
        if (filterMode === 'sfw') { if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`); else console.warn("SFW filter needs NSFW tag ID, which is null."); } // Улучшил лог
        else if (filterMode === 'nsfw') { if (nsfwTagId) filterConditions.push(`tags ~ "${nsfwTagId}"`); else { console.warn("NSFW filter needs NSFW tag ID, which is null. Blocking results."); filterConditions.push('(1=0)'); } } // Улучшил лог
        if (negativeSelectedTagNames.length > 0) { const ids = Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id); if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`)); if(ids.length !== negativeSelectedTagNames.length) console.warn("Neg tags mismatch"); }
        if (blockedTagIds.length > 0) { const negIds = new Set(Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id)); const finalBlocked = blockedTagIds.filter(bId => !negIds.has(bId)); if (finalBlocked.length > 0) filterConditions.push(...finalBlocked.map(id => `tags.id != "${id}"`)); }
        // --- End Filter ---
        const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
        const expandRelations = 'authors_via_games,tags,tags.tag_categories_via_tags';
        const fieldsToFetch = ['id','title','description','image','image_base64','upvotes_count','comments_count','authors','expand.authors_via_games.name','expand.tags.id','expand.tags.name','expand.tags.expand.tag_categories_via_tags.name'].join(',');

        const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, { sort: '-created', expand: expandRelations, filter: filterString, fields: fieldsToFetch });
        console.log(`[fetchGames] API call SUCCESS for page ${pageNum}. Received ${fetchedGamesResult.items.length} items.`);

        const gamesFromApi = processGameData(fetchedGamesResult.items);

        setGames((prevGames) => {
             const newGames = isReset ? gamesFromApi : [...prevGames, ...gamesFromApi];
             const uniqueGames = Array.from(new Map(newGames.map(g => [g.id, g])).values());
            // console.log(`[fetchGames] Updating games state for page ${pageNum}. Prev: ${prevGames.length}, New raw: ${gamesFromApi.length}, Total Unique: ${uniqueGames.length}`);
             return uniqueGames;
         });
        const newHasMore = fetchedGamesResult.items.length === ITEMS_PER_PAGE;
        setHasMore(newHasMore);
        console.log(`[fetchGames] State updated for page ${pageNum}. HasMore set to: ${newHasMore}`);

      } catch (error: any) {
          // Важно логировать ошибку ПОДРОБНО
          console.error(`[fetchGames] API call FAILED for page ${pageNum}:`, error);
          // Можно проверить тип ошибки, если нужно
          // if (error instanceof ClientResponseError) { console.error('PocketBase Error Details:', error.data); }
          setHasMore(false); // Останавливаем дальнейшие попытки при ошибке
          console.log(`[fetchGames] Error occurred. HasMore set to false.`);
      } finally {
          // Этот блок ДОЛЖЕН выполниться всегда после try или catch
          setLoading(false);
          console.log(`[fetchGames] FINALLY block executed for page ${pageNum}. Loading set to false.`);
      }
    },
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, tagMap, loading] // Добавил loading в зависимости useCallback, т.к. мы его читаем в логе в начале
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount
  useEffect(() => {
    let isMounted = true;
    console.log("[Effect #1: Tags] Mounting. Fetching tags...");
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap'); const lastUpdated = localStorage.getItem('tagMapLastUpdated'); const now = Date.now(); let newTagMap: Map<string, Tag>;
        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) { newTagMap = new Map(JSON.parse(cachedTags)); console.log("[Effect #1: Tags] Using cached tags."); }
        else { const ft = await tagsCollection.getFullList(500,{fields:'id,name',sort:'name'}); newTagMap = new Map((ft as Tag[]).map(t=>[t.id,t])); localStorage.setItem('tagMap',JSON.stringify([...newTagMap])); localStorage.setItem('tagMapLastUpdated',now.toString()); console.log("[Effect #1: Tags] Fetched and cached new tags."); }
        if (isMounted) { setTagMap(newTagMap); setTagsLoaded(true); console.log("[Effect #1: Tags] Tags loaded into state.");}
      } catch (error) { console.error('[Effect #1: Tags] Error:', error); if(isMounted){ setTagsLoaded(true); setLoading(false); console.log("[Effect #1: Tags] Error occurred, setting tagsLoaded=true, loading=false.");}} // Устанавливаем tagsLoaded в true и setLoading(false) даже при ошибке, чтобы не блокировать вечно
    })();
    return () => { isMounted = false; console.log("[Effect #1: Tags] Unmounting.");};
  }, []);

  // 2. Initial Data Handling (Check Preload THEN Fetch)
  useEffect(() => {
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
              setPage(1); // Убедимся, что страница 1
              // Вызываем fetchGames здесь, он сам установит setLoading(true)
              fetchGames(1, true);
          } else {
               if (!tagsLoaded || (nsfwFilterActive && nsfwTagId === null)) {
                    console.log("[Effect #2: Initial Load] Waiting for dependencies (tags/nsfwId). Setting loading=true.");
                    setLoading(true);
               } else {
                   console.log("[Effect #2: Initial Load] Not ready to fetch yet, but dependencies seem met? Waiting cycle.");
               }
               // console.log("Waiting for dependencies before initial fetch. Tags loaded:", tagsLoaded, "NSFW ID needed/found:", nsfwFilterActive, nsfwTagId);
          }
      }
    } else {
        console.log("[Effect #2: Initial Load] Skipped, initial fetch already performed.");
    }
  }, [tagsLoaded, filterMode, nsfwTagId, fetchGames]); // fetchGames добавлена как зависимость

  // 3. Handle Filter Changes (после initial load) --- ИСПРАВЛЕННАЯ ЛОГИКА ---
  useEffect(() => {
    console.log(`[Effect #3: Filter Change] Running. Initial fetch performed: ${initialFetchPerformedRef.current}, Tags loaded: ${tagsLoaded}`);
    // Ждем инициализации и загрузки тегов
    if (!initialFetchPerformedRef.current || !tagsLoaded) {
        console.log("[Effect #3: Filter Change] Skipped: Waiting for initial fetch and tags.");
        return;
    }

    const currentBlockedIds = blockedTags.map(t => t.id).sort();
    const sortedTags = [...selectedTags].sort();
    const sortedAuthors = [...selectedAuthors].sort();
    const currentFilters = { tags: sortedTags, authors: sortedAuthors, mode: filterMode, blocked: currentBlockedIds };

    // --- НАЧАЛО ИЗМЕНЕНИЯ ---
    // Если это первый запуск эффекта после инициализации (prevFiltersRef еще null)
    if (prevFiltersRef.current === null) {
        console.log("[Effect #3: Filter Change] First run after init. Storing initial filters, NO refetch triggered.");
        prevFiltersRef.current = currentFilters; // Просто сохраняем текущие (начальные) фильтры
        return; // НЕ вызываем fetchGames
    }
    // --- КОНЕЦ ИЗМЕНЕНИЯ ---

    // Если фильтры не изменились по сравнению с предыдущими
    if (JSON.stringify(currentFilters) === JSON.stringify(prevFiltersRef.current)) {
      console.log("[Effect #3: Filter Change] Skipped: Filters haven't changed since last check.");
      return;
    }

    // Фильтры ИЗМЕНИЛИСЬ
    console.log("[Effect #3: Filter Change] Filters CHANGED, refetching page 1.", { prev: prevFiltersRef.current, current: currentFilters });
    prevFiltersRef.current = currentFilters; // Обновляем сохраненные фильтры
    setPage(1); // Сбрасываем на первую страницу
    setHasMore(true); // Предполагаем, что есть данные
    // fetchGames сам установит loading=true
    fetchGames(1, true); // Сбрасываем и запрашиваем первую страницу с НОВЫМИ фильтрами

  // Зависимости остаются те же, но логика внутри изменилась
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames]);


  // 4. Infinite Scroll - Fetch More Games
  useEffect(() => {
    console.log(`[Effect #4: Infinite Scroll] Checking conditions for page ${page}. hasMore=${hasMore}, loading=${loading}, initialFetchDone=${initialFetchPerformedRef.current}`);
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      console.log(`[Effect #4: Infinite Scroll] Conditions met! Calling fetchGames for page ${page}.`);
      fetchGames(page, false); // Append results for the current 'page' state
    } else {
        console.log(`[Effect #4: Infinite Scroll] Conditions NOT met or page is 1. Skipping fetch.`);
    }
  }, [page, hasMore, loading, initialFetchPerformedRef, fetchGames]); // Зависимости те же


  // --- Intersection Observer ---
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
    // console.log(`[Observer Callback] Running. Loading: ${loading}, HasMore: ${hasMore}`); // Убрал loading из лога, т.к. он не в зависимостях
     if (loading) {
         // console.log("[Observer Callback] Loading is true, detaching observer temporarily.");
         if (observer.current) observer.current.disconnect(); // Отключаем, пока грузится
         return;
     }
    if (!hasMore) {
        // console.log("[Observer Callback] No more items, disconnecting observer.");
        if (observer.current) observer.current.disconnect(); // Отключаем навсегда
        return;
    }

    if (observer.current) observer.current.disconnect(); // Отключаем старый перед созданием нового

    observer.current = new IntersectionObserver(entries => {
      // console.log(`[Observer Internal Callback] Fired. isIntersecting: ${entries[0].isIntersecting}`);
      if (entries[0].isIntersecting) {
        console.log("[Observer Internal Callback] Element is intersecting! Incrementing page.");
        setPage(p => {
            console.log(`[Observer setPage] Current page: ${p}, New page: ${p + 1}`);
            return p + 1;
            });
      }
    }/*, { threshold: 0.1 } */); // Можно добавить threshold, если нужно срабатывание чуть раньше

    if (node) {
        // console.log("[Observer Callback] Attaching observer to new node.");
        observer.current.observe(node);
    } else {
        // console.log("[Observer Callback] Node is null.");
    }

  // Зависимости useCallback: `loading` убрали, `hasMore` оставили. Добавим `page` на всякий случай, если он влияет на логику (хотя он используется только в setPage)
  }, [hasMore]); // Убрали loading, оставили hasMore

  // Memoize games
  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component ---
  return (
    <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
      <Typography variant="h3" component="h1" sx={{ mt: -4, mb: 3, textAlign: 'center', fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },   ...(theme.custom?.cardTitle || { fontWeight: 'bold' }), }} >
        {isSearchActive ? 'Search Results' : 'Recent Uploads'}
      </Typography>

      {/* Главный лоадер (только при первой загрузке) */}
      {loading && games.length === 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}><CircularProgress /></Box>
      )}

      {/* Список игр */}
      {games.length > 0 && (
        <Grid2 container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
            {memoizedGames.map((game, index) => (
               <Grid2
                 size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                 key={`search-${game.id}-${index}`} // Ключ должен быть стабильным и уникальным
                 ref={index === memoizedGames.length - 1 ? lastGameElementRef : null} // Вешаем ref на последний элемент
               >
                 <GameCard game={game} variant="standard"/>
               </Grid2>
             ))}
        </Grid2>
      )}

       {/* Лоадер для подгрузки (появляется внизу при загрузке следующих страниц) */}
      {loading && games.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}><CircularProgress size={30} /></Box>
      )}

      {/* Сообщение о конце списка */}
      {!loading && !hasMore && games.length > 0 && initialFetchPerformedRef.current && (
          <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
      )}

      {/* Сообщение, если ничего не найдено */}
      {!loading && games.length === 0 && initialFetchPerformedRef.current && (
          <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
              {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'}
          </Typography>
      )}
    </Box>
  );
}