// src/components/Search/SearchPage.tsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

 
export default function SearchPage({
  selectedTags,
  selectedAuthors,
}: {
  selectedTags: string[];
  selectedAuthors: string[];
}) {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true); // Начинаем с true
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);
  // const [isPreloaded, setIsPreloaded] = useState(false); // Пока не используем initialData

  // Реф для хранения предыдущих фильтров, чтобы избежать лишних запросов
  const prevFiltersRef = useRef<{ tags: string[], authors: string[] } | null>(null); // Инициализируем null
  // Флаг, чтобы выполнить начальную загрузку только один раз
  const initialFetchPerformedRef = useRef<boolean>(false);

  // Функция загрузки игр (useCallback для стабильной ссылки)
  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      // Не выполняем запрос, если теги не загружены (доп. проверка)
      if (!tagsLoaded) {
          console.log("fetchGames aborted: tags not loaded yet.");
          return;
      }
       // Предотвращаем лишние запросы при пагинации
       if (!isReset && !hasMore) {
        console.log("fetchGames aborted: no more pages.");
        return;
       }

      console.log('fetchGames called with:', { pageNum, isReset });
      setLoading(true);

      try {
         // Формирование фильтра
         const filterConditions = [];
         if (selectedTags.length > 0) {
             const tagIds = Array.from(tagMap.entries())
                               .filter(([_, tag]) => selectedTags.includes(tag.name))
                               .map(([id, _]) => id);
             if (tagIds.length > 0) {
                  const tagConditions = tagIds.map(id => `tags.id ?= "${id}"`);
                  filterConditions.push(`(${tagConditions.join(' || ')})`);
             } else {
                 console.warn("Selected tags not found in tagMap, filtering by tags resulted in no matches.");
                 filterConditions.push('(1=0)');
             }
           }
           if (selectedAuthors.length > 0) {
             const authorConditions = selectedAuthors.map((author) => `authors_via_games.name ?~ "${author}"`);
             filterConditions.push(`(${authorConditions.join(' || ')})`);
           }
           const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
           console.log('Fetching games with filter:', filterString);

         // Запрос данных с upvotes_count и comments_count
         const fieldsToFetch = 'id,collectionId,title,description,image,image_base64,tags,expand.authors_via_games.name,upvotes_count,comments_count'; // Добавлен comments_count, убран comments

         const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
           sort: '-created',
           expand: 'authors_via_games', // Только авторов, теги обогатим вручную
           filter: filterString,
           fields: fieldsToFetch, // Используем обновленный список
         });

         console.log(`fetchGames RAW response (page ${pageNum}):`, JSON.parse(JSON.stringify(fetchedGamesResult.items)));

         // Обогащение тегов
         const enrichedGames = fetchedGamesResult.items.map((game) => {
           // Убедимся, что game.tags существует и является массивом перед map
           const gameTags = Array.isArray(game.tags) ? game.tags : [];
           const enrichedTags = gameTags
             .map((tagId) => tagMap.get(tagId))
             .filter((tag): tag is Tag => tag !== undefined);
           return {
             ...game,
             expand: { ...game.expand, tags: enrichedTags }, // Добавляем теги к существующему expand (авторы)
           };
         });


         console.log(`fetchGames ENRICHED games (page ${pageNum}):`, JSON.parse(JSON.stringify(enrichedGames)));
         console.log(`Fetched ${enrichedGames.length} games (page ${pageNum}/${fetchedGamesResult.totalPages})`);

         // Обновление состояния игр
         setGames((prevGames) => {
           const newGames = isReset ? enrichedGames : [...prevGames, ...enrichedGames];
           // Убираем дубликаты на всякий случай
           return Array.from(new Map(newGames.map((game) => [game.id, game])).values());
         });

         setHasMore(fetchedGamesResult.items.length > 0 && fetchedGamesResult.totalPages > pageNum);

      } catch (error) {
        console.error('Error fetching games:', error);
        setHasMore(false); // Останавливаем пагинацию при ошибке
      } finally {
        setLoading(false); // Завершаем загрузку
      }
    },
    // Зависимости fetchGames
    [tagsLoaded, hasMore, selectedTags, selectedAuthors, tagMap]
  );

  // --- ЛОГИКА useEffect ---

  // 1. Загрузка тегов (выполняется один раз при монтировании)
  useEffect(() => {
    let isMounted = true;
    console.log("[useEffect tags] Starting tags load...");
    setLoading(true);
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap');
        const lastUpdated = localStorage.getItem('tagMapLastUpdated');
        const now = Date.now();
        let newTagMap: Map<string, Tag>;

        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
            console.log("[useEffect tags] Using cached tags.");
            newTagMap = new Map(JSON.parse(cachedTags));
        } else {
            console.log("[useEffect tags] Fetching tags from server...");
            const fetchedTags = await tagsCollection.getFullList({
              expand: 'tag_categories_via_tags',
              fields: 'id,name,expand.tag_categories_via_tags.name',
            });
            newTagMap = new Map(fetchedTags.map((tag) => [tag.id, tag as Tag]));
            localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
            localStorage.setItem('tagMapLastUpdated', now.toString());
            console.log("[useEffect tags] Tags fetched and cached.");
        }

        if (isMounted) {
            setTagMap(newTagMap);
            setTagsLoaded(true);
            console.log("[useEffect tags] Tags state updated, tagsLoaded set to true.");
        }

      } catch (error) {
        console.error('Error loading tags:', error);
        if (isMounted) {
            setTagsLoaded(true);
            setLoading(false);
            console.log("[useEffect tags] Error loading tags, setting tagsLoaded=true, loading=false.");
        }
      }
    })();

    return () => { isMounted = false; };
  }, []);

  // 2. Начальная загрузка игр (срабатывает ОДИН РАЗ после загрузки тегов)
  useEffect(() => {
    if (tagsLoaded && !initialFetchPerformedRef.current) {
      console.log("[useEffect initial load] Tags loaded and initial fetch not performed yet. Fetching initial games...");
      initialFetchPerformedRef.current = true;
      fetchGames(1, true);
    } else if (!tagsLoaded) {
      console.log("[useEffect initial load] Waiting for tags...");
    } else {
        console.log("[useEffect initial load] Initial fetch already performed.");
    }
  }, [tagsLoaded, fetchGames]); // Зависит от tagsLoaded и fetchGames

  // 3. Обработка изменения фильтров
  useEffect(() => {
    if (!tagsLoaded || !initialFetchPerformedRef.current) {
        console.log("[useEffect filters] Skipping check: tags not loaded or initial fetch not done.");
        return;
    }
    if (prevFiltersRef.current === null) {
        console.log("[useEffect filters] Initializing prevFiltersRef.");
        prevFiltersRef.current = { tags: [...selectedTags], authors: [...selectedAuthors] };
        return;
    }

    const tagsChanged = JSON.stringify(selectedTags.sort()) !== JSON.stringify(prevFiltersRef.current.tags.sort());
    const authorsChanged = JSON.stringify(selectedAuthors.sort()) !== JSON.stringify(prevFiltersRef.current.authors.sort());
    const hasMeaningfulChange = tagsChanged || authorsChanged;

    if (hasMeaningfulChange) {
        console.log('[useEffect filters] Filters changed, fetching...');
        prevFiltersRef.current = {
          tags: [...selectedTags],
          authors: [...selectedAuthors],
        };
        setPage(1);
        setHasMore(true);
        setGames([]);
        fetchGames(1, true);
    } else {
         // console.log('[useEffect filters] Filters not meaningfully changed, skipping fetch.');
    }
  }, [selectedTags, selectedAuthors, tagsLoaded, fetchGames]); // Зависимости

  // 4. Бесконечная прокрутка (Загрузка следующей страницы)
  useEffect(() => {
    if (page > 1 && tagsLoaded && hasMore) {
      console.log('[useEffect pagination] Loading next page:', page);
      fetchGames(page, false);
    }
  }, [page, tagsLoaded, hasMore, fetchGames]);


  // Intersection Observer
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          console.log('Observer triggered, loading more games');
          setPage((prevPage) => prevPage + 1);
        }
      });
      if (node) observer.current.observe(node);
    },
    [loading, hasMore],
  );

  // Мемоизация списка игр для рендера
  const memoizedGames = useMemo(() => games, [games]);
  // Флаг активного поиска
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;

  // --- JSX Рендеринг ---
  return (
    <Box sx={{ width: '100%', p: 3 }}>
      {/* Заголовок */}
      <Typography
        variant="h3"
        sx={{
          mt: -4,
          mb: 2,
          textAlign: 'center',
          // @ts-expect-error custom theme property
          ...theme.custom.cardTitle,
        }}
      >
        {isSearchActive ? 'Search Results' : 'Recent Uploads'}
      </Typography>

      {/* Начальный индикатор загрузки */}
      {loading && !initialFetchPerformedRef.current && (
         <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
            <CircularProgress />
         </Box>
      )}

      {/* Список игр */}
      {initialFetchPerformedRef.current && games.length > 0 && (
        <Grid2 container spacing={2} justifyContent="center">
            {memoizedGames.map((game, index) => (
                <Grid2
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                    key={`search-${game.id}-${index}`} // Уникальный ключ
                    ref={memoizedGames.length === index + 1 ? lastGameElementRef : null}
                >
                    <GameCard game={game} key={game.id} variant="standard"/>
                </Grid2>
            ))}
        </Grid2>
      )}

      {/* Индикатор загрузки для пагинации */}
      {loading && initialFetchPerformedRef.current && page > 1 && (
          <CircularProgress sx={{ mt: 2, display: 'block', margin: 'auto' }} />
      )}

      {/* Сообщение "Больше нет игр" */}
      {initialFetchPerformedRef.current && !loading && !hasMore && games.length > 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
            No more games to load
        </Typography>
      )}

      {/* Сообщение "Игр не найдено" */}
      {initialFetchPerformedRef.current && !loading && games.length === 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
          {isSearchActive ? 'No games found matching your search criteria' : 'No games available'}
        </Typography>
      )}
    </Box>
  );
}