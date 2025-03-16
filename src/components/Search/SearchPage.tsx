// src/components/Search/SearchPage.tsx
// v3.0
// Combined GameList and SearchPage functionality
// Оптимизирован запрос, добавлено обновление тегов раз в 24 часа

import { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000; // 24 часа в миллисекундах

export default function SearchPage({
  selectedTags,
  selectedAuthors,
}: {
  selectedTags: string[];
  selectedAuthors: string[];
}) {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false); // Новое состояние для отслеживания загрузки тегов

  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setPage((prevPage) => prevPage + 1);
        }
      });
      if (node) observer.current.observe(node);
    },
    [loading, hasMore],
  );

  // Загрузка тегов
  useEffect(() => {
    (async () => {
      const cachedTags = localStorage.getItem('tagMap');
      const lastUpdated = localStorage.getItem('tagMapLastUpdated');
      const now = Date.now();

      if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
        setTagMap(new Map(JSON.parse(cachedTags)));
        setTagsLoaded(true);
      } else {
        console.log('Fetching tags...');
        const fetchedTags = await tagsCollection.getFullList({
          expand: 'tag_categories_via_tags',
          fields: 'id,name,expand.tag_categories_via_tags.name',
        });
        const newTagMap = new Map(fetchedTags.map((tag) => [tag.id, tag]));
        setTagMap(newTagMap);
        localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
        localStorage.setItem('tagMapLastUpdated', now.toString());
        setTagsLoaded(true);
      }
    })();
  }, []);

  const fetchGames = useCallback(async () => {
    if (!hasMore || !tagsLoaded) return; // Ждём загрузки тегов

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

      const fetchedGames = await gamesCollection.getList(page, ITEMS_PER_PAGE, {
        sort: '-created',
        expand: 'authors_via_games',
        filter: filterString,
        fields: 'id,title,description,image,image_preview,image_base64,upvotes,comments,tags,expand.authors_via_games.name',
      });

      const enrichedGames = fetchedGames.items.map((game) => {
        const enrichedTags = game.tags
          .map((tagId) => tagMap.get(tagId))
          .filter((tag): tag is Tag => tag !== undefined);
        return {
          ...game,
          expand: {
            ...game.expand,
            tags: enrichedTags,
          },
        };
      });

      setGames((prevGames) => {
        const newGames = [...prevGames, ...enrichedGames];
        return Array.from(new Map(newGames.map((game) => [game.id, game])).values());
      });
      setHasMore(fetchedGames.items.length > 0 && fetchedGames.totalPages > page);
    } catch (error) {
      console.error('Error fetching games:', error);
    } finally {
      setLoading(false);
    }
  }, [page, hasMore, selectedTags, selectedAuthors, tagMap, tagsLoaded]);

  // Объединённая логика сброса и загрузки
  useEffect(() => {
    if (!tagsLoaded) return; // Ждём загрузки тегов
    setGames([]);
    setPage(1);
    setHasMore(true);
    fetchGames(); // Загружаем сразу после сброса
  }, [selectedTags, selectedAuthors, tagsLoaded]);

  // Загрузка игр при изменении страницы (бесконечная прокрутка)
  useEffect(() => {
    if (page > 1) fetchGames();
  }, [page, fetchGames]);

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
        {games.map((game, index) => (
          <Grid2
            size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
            key={`search-${game.id}`}
            ref={games.length === index + 1 ? lastGameElementRef : null}
          >
            <GameCard game={game} />
          </Grid2>
        ))}
      </Grid2>

      {loading && <CircularProgress sx={{ mt: 2, display: 'block', margin: 'auto' }} />}
      {!loading && !hasMore && games.length > 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>No more games to load</Typography>
      )}
      {!loading && games.length === 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>
          {isSearchActive ? 'No games found matching your search criteria' : 'No games available'}
        </Typography>
      )}
    </Box>
  );
}