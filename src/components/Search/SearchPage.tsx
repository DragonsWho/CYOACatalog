import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

// Мемоизированный GameCard с проверкой равенства props
const MemoizedGameCard = memo(GameCard, (prevProps, nextProps) => {
  // Проверяем только ID игры, а не весь объект
  return prevProps.game.id === nextProps.game.id;
});

export default function SearchPage({
  selectedTags,
  selectedAuthors,
}: {
  selectedTags: string[];
  selectedAuthors: string[];
}) {
  console.log('SearchPage render', { selectedTags, selectedAuthors });
  
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  
  const prevFiltersRef = useRef({ tags: [] as string[], authors: [] as string[] });

  // Проверка изменений в фильтрах
  const filtersChanged = useCallback(() => {
    const tagsChanged = 
      selectedTags.length !== prevFiltersRef.current.tags.length || 
      selectedTags.some((tag, i) => tag !== prevFiltersRef.current.tags[i]);
    
    const authorsChanged = 
      selectedAuthors.length !== prevFiltersRef.current.authors.length || 
      selectedAuthors.some((author, i) => author !== prevFiltersRef.current.authors[i]);
    
    return tagsChanged || authorsChanged;
  }, [selectedTags, selectedAuthors]);

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

  // Загрузка игр
  const fetchGames = useCallback(async (pageNum = page, isReset = false) => {
    console.log('fetchGames', { pageNum, isReset });
    if (!hasMore && !isReset) return;

    setLoading(true);
    try {
      const filterConditions = [];

      if (selectedTags.length > 0) {
        const tagConditions = selectedTags.map((tag) => `tags.name ?~ "${tag}"`);
        filterConditions.push(`(${tagConditions.join(' || ')})`);
      }

      if (selectedAuthors.length > 0) {
        const authorConditions = selectedAuthors.map((author) => `authors_via_games.name ?~ "${author}"`);
        filterConditions.push(`(${authorConditions.join(' || ')})`);
      }

      const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
      console.log('Fetching games with filter:', filterString);

      const fetchedGames = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
        sort: '-created',
        expand: 'authors_via_games',
        filter: filterString,
        fields: 'id,title,description,image,image_base64,upvotes,comments,tags,expand.authors_via_games.name',
      });

      console.log(`Fetched ${fetchedGames.items.length} games (page ${pageNum}/${fetchedGames.totalPages})`);

      setGames((prevGames) => {
        if (isReset) {
          return fetchedGames.items;
        } else {
          const newGames = [...prevGames, ...fetchedGames.items];
          // Удаляем дубликаты
          return Array.from(new Map(newGames.map((game) => [game.id, game])).values());
        }
      });
      
      setHasMore(fetchedGames.items.length > 0 && fetchedGames.totalPages > pageNum);
    } catch (error) {
      console.error('Error fetching games:', error);
    } finally {
      setLoading(false);
    }
  }, [page, hasMore, selectedTags, selectedAuthors]);

  // Начальная загрузка игр
  useEffect(() => {
    console.log('Initial load effect');
    fetchGames(1, true);
  }, []);

  // Загрузка тегов для выпадающего меню
  useEffect(() => {
    console.log('Tags loading effect');
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap');
        const lastUpdated = localStorage.getItem('tagMapLastUpdated');
        const now = Date.now();

        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
          console.log('Using cached tags');
          setTagMap(new Map(JSON.parse(cachedTags)));
        } else {
          console.log('Fetching tags from server...');
          const fetchedTags = await tagsCollection.getFullList({
            expand: 'tag_categories_via_tags',
            fields: 'id,name,expand.tag_categories_via_tags.name',
          });
          console.log(`Received ${fetchedTags.length} tags from server`);
          const newTagMap = new Map(fetchedTags.map((tag) => [tag.id, tag]));
          setTagMap(newTagMap);
          localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
          localStorage.setItem('tagMapLastUpdated', now.toString());
        }
      } catch (error) {
        console.error('Error loading tags:', error);
      }
    })();
  }, []);

  // Обработка изменения фильтров
  useEffect(() => {
    // Пропускаем первый рендер
    if (selectedTags.length === 0 && selectedAuthors.length === 0 && 
        prevFiltersRef.current.tags.length === 0 && prevFiltersRef.current.authors.length === 0) {
      console.log('Skipping initial filter check');
      return;
    }
    
    // Проверяем, изменились ли фильтры
    if (!filtersChanged()) {
      console.log('Filters not changed, skipping update');
      return;
    }
    
    console.log('Filters changed, updating search results');
    
    // Обновляем сохраненные фильтры
    prevFiltersRef.current = {
      tags: [...selectedTags],
      authors: [...selectedAuthors]
    };
    
    // Сбрасываем и загружаем заново с новыми фильтрами
    setPage(1);
    setHasMore(true);
    fetchGames(1, true);
  }, [selectedTags, selectedAuthors, filtersChanged, fetchGames]);

  // Загрузка следующей страницы при бесконечной прокрутке
  useEffect(() => {
    if (page > 1) {
      console.log('Loading next page:', page);
      fetchGames(page, false);
    }
  }, [page, fetchGames]);

  // Мемоизируем список игр, чтобы предотвратить повторный рендер
  const memoizedGames = useMemo(() => games, [games]);

  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;

  return (
    <Box sx={{ width: '100%', p: 3 }}>
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
      <Grid2 container spacing={2} justifyContent="center">
        {memoizedGames.map((game, index) => (
          <Grid2
            size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
            key={`search-${game.id}`}
            ref={memoizedGames.length === index + 1 ? lastGameElementRef : null}
          >
            <MemoizedGameCard 
              game={game} 
              // Используем стабильный ключ для каждой игры
              key={game.id}
            />
          </Grid2>
        ))}
      </Grid2>

      {loading && <CircularProgress sx={{ mt: 2, display: 'block', margin: 'auto' }} />}
      {!loading && !hasMore && memoizedGames.length > 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>No more games to load</Typography>
      )}
      {!loading && memoizedGames.length === 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>
          {isSearchActive ? 'No games found matching your search criteria' : 'No games available'}
        </Typography>
      )}
    </Box>
  );
}