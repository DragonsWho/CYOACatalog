// src/components/Search/SearchPage.tsx
// v3.0
// Combined GameList and SearchPage functionality

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Box, 
  Typography, 
  CircularProgress,
  Grid,
  useTheme
} from '@mui/material';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';



const ITEMS_PER_PAGE = 25;

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
}

const SearchPage: React.FC<SearchPageProps> = ({ selectedTags, selectedAuthors }) => {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

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




  
  const fetchGames = useCallback(async () => {
    if (!hasMore) return;
  
    setLoading(true);
    try {
      let filterConditions = [];
  
      if (selectedTags.length > 0) {
        const tagConditions = selectedTags.map(tag => `tags.name ?~ "${tag}"`);
        filterConditions.push(`(${tagConditions.join(' || ')})`);
      }
  
      if (selectedAuthors.length > 0) {
        const authorConditions = selectedAuthors.map(author => `authors_via_games.name ?~ "${author}"`);
        filterConditions.push(`(${authorConditions.join(' || ')})`);
      }
  
      const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
  
      console.log("Filter string:", filterString);
  
      const fetchedGames = await gamesCollection.getList(page, ITEMS_PER_PAGE, {
        sort: '-created',
        expand: 'tags,authors_via_games',
        filter: filterString,
      });
  
      console.log("Fetched games:", fetchedGames.items.length);
  
      // Client-side filtering
      const filteredGames = Array.isArray(fetchedGames.items)
        ? fetchedGames.items.filter(game => {
            const gameTags = game.expand?.tags?.map(tag => tag.name?.toLowerCase()).filter(Boolean) || [];
            const gameAuthors = game.expand?.authors_via_games?.map(author => author.name?.toLowerCase()).filter(Boolean) || [];
            
            console.log("Game ID:", game.id);
            console.log("Game tags:", gameTags);
            console.log("Game authors:", gameAuthors);
  
            const tagsMatch = selectedTags.length === 0 || selectedTags.every(tag => 
              tag && gameTags.some(gameTag => gameTag && gameTag.includes(tag.toLowerCase()))
            );
            const authorsMatch = selectedAuthors.length === 0 || selectedAuthors.some(author => 
              author && gameAuthors.some(gameAuthor => gameAuthor && gameAuthor.includes(author.toLowerCase()))
            );
            
            console.log("Tags match:", tagsMatch);
            console.log("Authors match:", authorsMatch);
  
            return tagsMatch && authorsMatch;
          })
        : [];
  
      console.log("Filtered games:", filteredGames.length);
  
      setGames(prevGames => {
        const newGames = [...prevGames, ...filteredGames];
        return Array.from(new Map(newGames.map(game => [game.id, game])).values());
      });
      setHasMore(filteredGames.length > 0 && fetchedGames.totalPages > page);
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
      <Grid container spacing={2} justifyContent="center">
        {games.map((game, index) => (
          <Grid item xs={12} sm={6} md={4} lg={2.4} key={`search-${game.id}`}
               ref={games.length === index + 1 ? lastGameElementRef : null}>
            <GameCard game={game} />
          </Grid>
        ))}
      </Grid>
      
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
};

export default SearchPage;