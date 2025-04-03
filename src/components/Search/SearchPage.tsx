// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../App';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25; // Убедитесь, что совпадает со значением в index.html
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

// Расширяем интерфейс Window для __INITIAL_DATA__
declare global {
    interface Window {
        __INITIAL_DATA__?: {
            items: any[]; // Используем any[], так как структура может быть неполной до обработки
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
  // Инициализируем loading в false, если ожидаем предзагруженные данные,
  // но установим в true, если придется их фетчить
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

  // --- Функция обработки данных (вынесена для переиспользования) ---
  const processGameData = (items: any[]): Game[] => {
      return items.map(game => {
          const expandData = game.expand || {};
          const tagsData = expandData.tags;
          const authorsData = expandData.authors_via_games;
          // Важно: Возвращаем полную структуру Game, даже если в fields были только нужные
          // Недостающие поля будут undefined, что обычно нормально для JS/TS
          return {
              ...game, // Копируем все поля, что пришли (id, title, image и т.д.)
              expand: {
                  // Восстанавливаем структуру expand с гарантированными массивами
                  ...(expandData.authors_via_games && { authors_via_games: Array.isArray(authorsData) ? authorsData : (authorsData ? [authorsData] : []) }),
                  ...(expandData.tags && { tags: Array.isArray(tagsData) ? tagsData : (tagsData ? [tagsData] : []) }),
              }
          } as Game; // Утверждаем тип как Game
      });
  };


  // Effect to find NSFW tag ID (без изменений)
  useEffect(() => {
    if (tagsLoaded && tagMap.size > 0) {
      let foundNsfwId: string | null = null;
      for (const [id, tag] of tagMap.entries()) { if (tag.name.toLowerCase() === 'nsfw') { foundNsfwId = id; break; } }
      setNsfwTagId(foundNsfwId);
      if (!foundNsfwId && tagsLoaded) console.warn("[Tag ID Finder] NSFW tag ID not found in loaded tagMap!");
    }
  }, [tagsLoaded, tagMap]);

  // --- fetchGames Function (без изменений в логике запроса) ---
  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
      const canFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

      if (!canFetch) {
        if (tagsLoaded && nsfwFilterActive && nsfwTagId === null) { setLoading(true); }
        return;
      }
      setLoading(true);
      try {
        // --- Filter logic ---
        const filterConditions: string[] = [];
        const blockedTagIds = blockedTags.map(tag => tag.id);
        const positiveSelectedTags: string[] = [];
        const negativeSelectedTagNames: string[] = [];
        selectedTags.forEach(tag => { if (tag.startsWith('-')) { const n = tag.substring(1); if(n) negativeSelectedTagNames.push(n); } else { positiveSelectedTags.push(tag); } });
        if (positiveSelectedTags.length > 0) { const ids = Array.from(tagMap.entries()).filter(([_,t])=>positiveSelectedTags.includes(t.name)).map(([id,_])=>id); if (ids.length===positiveSelectedTags.length) { filterConditions.push(...ids.map(id=>`tags ~ "${id}"`)); } else { console.warn("Pos tags mismatch"); filterConditions.push('(1=0)'); }}
        if (selectedAuthors.length > 0) { filterConditions.push(`(${selectedAuthors.map(a => `authors_via_games.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`); }
        if (filterMode === 'sfw') { if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`); else console.warn("SFW no id"); }
        else if (filterMode === 'nsfw') { if (nsfwTagId) filterConditions.push(`tags ~ "${nsfwTagId}"`); else { console.warn("NSFW no id"); filterConditions.push('(1=0)'); } }
        if (negativeSelectedTagNames.length > 0) { const ids = Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id); if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`)); if(ids.length !== negativeSelectedTagNames.length) console.warn("Neg tags mismatch"); }
        if (blockedTagIds.length > 0) { const negIds = new Set(Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id)); const finalBlocked = blockedTagIds.filter(bId => !negIds.has(bId)); if (finalBlocked.length > 0) filterConditions.push(...finalBlocked.map(id => `tags.id != "${id}"`)); }
        // --- End Filter ---
        const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
        const expandRelations = 'authors_via_games,tags,tags.tag_categories_via_tags';
        const fieldsToFetch = ['id','title','description','image','image_base64','upvotes_count','comments_count','authors','expand.authors_via_games.name','expand.tags.id','expand.tags.name','expand.tags.expand.tag_categories_via_tags.name'].join(',');

        const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, { sort: '-created', expand: expandRelations, filter: filterString, fields: fieldsToFetch });
        // Используем общую функцию обработки
        const gamesFromApi = processGameData(fetchedGamesResult.items);

        setGames((prevGames) => { const ng = isReset ? gamesFromApi : [...prevGames, ...gamesFromApi]; return Array.from(new Map(ng.map(g => [g.id, g])).values()); });
        setHasMore(fetchedGamesResult.items.length === ITEMS_PER_PAGE);
      } catch (error: any) { console.error('[fetchGames] Error:', error); setHasMore(false); }
      finally { setLoading(false); }
    },
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, tagMap] // Добавил tagMap т.к. он используется в фильтрах
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount (без изменений)
  useEffect(() => {
    let isMounted = true;
    // Не устанавливаем loading здесь, если данные могут быть предзагружены
    // setLoading(true);
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap'); const lastUpdated = localStorage.getItem('tagMapLastUpdated'); const now = Date.now(); let newTagMap: Map<string, Tag>;
        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) { newTagMap = new Map(JSON.parse(cachedTags)); }
        else { const ft = await tagsCollection.getFullList(500,{fields:'id,name',sort:'name'}); newTagMap = new Map((ft as Tag[]).map(t=>[t.id,t])); localStorage.setItem('tagMap',JSON.stringify([...newTagMap])); localStorage.setItem('tagMapLastUpdated',now.toString()); }
        if (isMounted) { setTagMap(newTagMap); setTagsLoaded(true); }
      } catch (error) { console.error('[Tags Effect] Error:', error); if(isMounted){ setTagsLoaded(true); setLoading(false); }}
    })();
    return () => { isMounted = false; };
  }, []);

  // 2. Initial Data Handling (Check Preload THEN Fetch) - ИЗМЕНЕННЫЙ HOOK
  useEffect(() => {
    // Выполняем только если начальная загрузка еще не произошла
    if (!initialFetchPerformedRef.current) {

      // Проверяем наличие предзагруженных данных
      if (window.__INITIAL_DATA__ && Array.isArray(window.__INITIAL_DATA__.items)) {
        
          console.log("Using preloaded data for initial load.");
          const preloadedItems = window.__INITIAL_DATA__.items;

          // Обрабатываем предзагруженные данные той же функцией
          const gamesFromPreload = processGameData(preloadedItems);

          // Устанавливаем состояние из предзагруженных данных
          setGames(gamesFromPreload);
          setHasMore(preloadedItems.length === ITEMS_PER_PAGE);
          setLoading(false); // Данные загружены
          initialFetchPerformedRef.current = true; // Помечаем, что начальная загрузка выполнена

          // Очищаем глобальную переменную
          window.__INITIAL_DATA__ = null;

      } else {
          // Предзагруженных данных нет или они невалидны, выполняем обычную логику fetch
          console.log("Preloaded data not found or invalid. Will fetch when ready.");
          const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
          // Проверяем готовность к fetch (теги загружены? nsfwId есть, если нужен?)
          const readyToFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

          if (readyToFetch) {
              console.log("Ready to fetch initial data.");
              initialFetchPerformedRef.current = true; // Помечаем *перед* вызовом fetch
              setLoading(true); // Убедимся, что есть индикатор загрузки
              fetchGames(1, true); // Выполняем первый fetch
          } else {
               // Все еще ждем зависимости (теги или nsfwId)
               // Устанавливаем loading=true, если ожидание активное
               if (!tagsLoaded || (nsfwFilterActive && nsfwTagId === null)) {
                    setLoading(true);
               }
               console.log("Waiting for dependencies before initial fetch. Tags loaded:", tagsLoaded, "NSFW ID needed/found:", nsfwFilterActive, nsfwTagId);
          }
      }
    }
    // Зависимости остаются те же, чтобы эффект перепроверял состояние при их изменении,
    // пока initialFetchPerformedRef.current не станет true.
  }, [tagsLoaded, filterMode, nsfwTagId, fetchGames]);


  // 3. Handle Filter Changes (после initial load) - логика без изменений
  useEffect(() => {
    if (!initialFetchPerformedRef.current || !tagsLoaded) { return; } // Ждем завершения начальной загрузки/загрузки тегов
    const currentBlockedIds = blockedTags.map(t => t.id).sort(); const sortedTags = [...selectedTags].sort(); const sortedAuthors = [...selectedAuthors].sort();
    const currentFilters = { tags: sortedTags, authors: sortedAuthors, mode: filterMode, blocked: currentBlockedIds };
    if (prevFiltersRef.current === null ) { prevFiltersRef.current = currentFilters; return; }
    const changed = JSON.stringify(currentFilters) !== JSON.stringify(prevFiltersRef.current); // Упрощенная проверка для примера
    if (changed) {
      console.log("Filters changed, refetching.");
      prevFiltersRef.current = currentFilters; setPage(1); setHasMore(true);
      // setGames([]); // Optional clear
      fetchGames(1, true); // Reset and fetch
    }
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames]);

  // 4. Infinite Scroll - Fetch More Games (без изменений)
  useEffect(() => {
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      console.log("Infinite scroll fetching page:", page);
      fetchGames(page, false); // Append results
    }
  }, [page, hasMore, loading, initialFetchPerformedRef, fetchGames]);

  // --- Intersection Observer (без изменений) ---
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
    if (loading || !hasMore) return; if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => { if (entries[0].isIntersecting) { setPage(p => p + 1); } });
    if (node) observer.current.observe(node);
  }, [loading, hasMore]);

  // Memoize games
  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component (без изменений) ---
  return (
    <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
      <Typography variant="h3" component="h1" sx={{ mt: -4, mb: 3, textAlign: 'center', fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },   ...(theme.custom?.cardTitle || { fontWeight: 'bold' }), }} >
        {isSearchActive ? 'Search Results' : 'Recent Uploads'}
      </Typography>
      {loading && games.length === 0 && ( <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}> <CircularProgress /> </Box> )}
      {games.length > 0 && (
        <Grid2 container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
            {memoizedGames.map((game, index) => ( <Grid2 size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }} key={`search-${game.id}-${index}`} ref={index === memoizedGames.length - 1 ? lastGameElementRef : null} > <GameCard game={game} variant="standard"/> </Grid2> ))}
        </Grid2>
      )}
      {loading && games.length > 0 && ( <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}> <CircularProgress size={30} /> </Box> )}
      {!loading && !hasMore && games.length > 0 && initialFetchPerformedRef.current && ( <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography> )}
      {!loading && games.length === 0 && initialFetchPerformedRef.current && ( <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}> {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'} </Typography> )}
    </Box>
  );
}