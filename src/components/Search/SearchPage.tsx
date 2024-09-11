// src/components/Search/SearchPage.tsx
// v2.0
// Description: Search page component with game filtering based on selected tags and authors

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Box, 
  Typography, 
  CircularProgress,
  Grid, 
} from '@mui/material';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
}

const SearchPage: React.FC<SearchPageProps> = ({ selectedTags, selectedAuthors }) => {
 
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchGames = useCallback(async () => {
    if (!hasMore) return;

    setLoading(true);
    try {
      const filterArray = [
        ...selectedTags.map(tag => `tags.name ?~ "${tag}"`),
        ...selectedAuthors.map(author => `authors_via_games.name ?~ "${author}"`)
      ];
      
      const filterString = filterArray.length > 0 ? filterArray.join(' && ') : '';

      const fetchedGames = await gamesCollection.getList(page, ITEMS_PER_PAGE, {
        sort: '-created',
        expand: 'tags.tag_categories_via_tags,authors_via_games',
        filter: filterString,
      });

      setGames(prevGames => {
        const newGames = [...prevGames, ...fetchedGames.items];
        return Array.from(new Map(newGames.map(game => [game.id, game])).values());
      });
      setHasMore(fetchedGames.totalPages > page);
      setPage(prevPage => prevPage + 1);
    } catch (error) {
      console.error('Error fetching games:', error);
    } finally {
      setLoading(false);
    }
  }, [page, hasMore, selectedTags, selectedAuthors]);

  useEffect(() => {
    setGames([]);
    setPage(1);
    setHasMore(true);
  }, [selectedTags, selectedAuthors]);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Grid container spacing={2} justifyContent="center">
        {games.map((game) => (
          <Grid item xs={12} sm={6} md={4} lg={2.4} key={`search-${game.id}`}>
            <GameCard game={game} />
          </Grid>
        ))}
      </Grid>
      
      {loading && <CircularProgress sx={{ mt: 2, display: 'block', margin: 'auto' }} />}
      {!loading && !hasMore && games.length > 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>No more games to load</Typography>
      )}
      {!loading && games.length === 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>No games found matching your search criteria</Typography>
      )}
    </Box>
  );
};

export default SearchPage;