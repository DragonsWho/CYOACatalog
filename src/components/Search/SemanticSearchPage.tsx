import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Typography,
  TextField,
  Button,
  CircularProgress,
  Container,
  Grid2,
  Alert,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import { Game, gamesCollectionPublic } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';
import { analytics } from '../../utils/analytics';

interface SemanticResult {
  id: string;
  title: string;
  url: string;
  score: number;
  match_type: 'summary' | 'text';
  snippet: string;
}

interface SemanticApiResponse {
  results: SemanticResult[];
  total_found: number;
}

const SemanticSearchPage: React.FC = () => {
  const [query, setQuery] = useState('');
  // Search mode hidden and defaulted to 'mixed' (see runSearch).
  const [games, setGames] = useState<Game[]>([]);
  const [scores, setScores] = useState<Map<string, number>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [searchParams] = useSearchParams();

  const runSearch = useCallback(async (rawQuery: string) => {
    const searchQuery = rawQuery.trim();
    if (searchQuery.length < 2) return;

    analytics.semanticSearch({ source: 'page', query_len: searchQuery.length });
    setIsLoading(true);
    setError(null);
    setGames([]);
    setScores(new Map());
    setSearched(true);

    try {
      const response = await fetch(`/api/semantic-search?q=${encodeURIComponent(searchQuery)}&mode=mixed`);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `Server error: ${response.status}`);
      }

      const data: SemanticApiResponse = await response.json();

      if (!data.results || data.results.length === 0) {
        setIsLoading(false);
        return;
      }

      const scoreMap = new Map<string, number>();
      const gameIds: string[] = [];

      data.results.forEach((result) => {
        scoreMap.set(result.id, result.score);
        gameIds.push(result.id);
      });

      setScores(scoreMap);

      // Fetch full records from PocketBase via an id OR filter. Truncate to one screen of results
      // BEFORE building the filter: the semantic backend can return ~100 ids, and a hundred-term OR
      // filter risks hitting Cloudflare/PocketBase URL/body length limits; only the first screen is
      // worth rendering anyway.
      const PAGE_SIZE = 40;
      const pageIds = gameIds.slice(0, PAGE_SIZE);
      const filter = pageIds.map(id => `id="${id}"`).join(' || ');

      const pbGames = await gamesCollectionPublic.getFullList<Game>({
        filter: filter,
        expand: 'authors,tags',
      });

      // PocketBase doesn't preserve OR-filter order: re-sort pbGames in semantic relevance order.
      // Map instead of .find() (O(N²) otherwise).
      const byId = new Map(pbGames.map(g => [g.id, g]));
      const sortedGames = pageIds
        .map(id => byId.get(id))
        .filter((g): g is Game => !!g);

      setGames(sortedGames);

    } catch (err) {
      console.error("Semantic search error:", err);
      setError(err instanceof Error ? err.message : 'An unknown error occurred');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };

  // Deep link: ?q=… (e.g. from the header's "open full semantic search") prefills and runs once.
  useEffect(() => {
    const q = searchParams.get('q');
    if (q && q.trim().length >= 2) {
      setQuery(q);
      runSearch(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 }, py: 4 }}>
      
      <Container maxWidth="md" sx={{ mb: 5 }}>
        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="h3" component="h1" gutterBottom sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
            <TravelExploreIcon fontSize="large" color="primary" /> 
            Semantic Search
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 600, mx: 'auto', mb: 4 }}>
            Find games by describing them in plain English. <br/>
            Try: <i>"Isekai with kingdom building"</i> or <i>"Horror game about being trapped in a loop"</i>.
          </Typography>
        </Box>

        <Box 
          component="form" 
          onSubmit={handleSearch} 
          sx={{ 
            display: 'flex', 
            gap: 1, 
            width: '100%', 
            alignItems: 'flex-start'
          }}
        >
          <TextField
            fullWidth
            variant="outlined"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Describe the game you are looking for..."
            disabled={isLoading}
            sx={{
              '& .MuiOutlinedInput-root': {
                backgroundColor: 'background.paper',
              }
            }}
          />
          <Button
            type="submit"
            variant="contained"
            size="large"
            sx={{ height: 56, px: 4 }}
            disabled={isLoading || query.trim().length < 2}
          >
            {isLoading ? <CircularProgress size={24} color="inherit" /> : <SearchIcon />}
          </Button>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </Container>

      <Box>
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {searched && !isLoading && games.length === 0 && !error && (
          <Typography variant="h6" color="text.secondary" align="center" sx={{ mt: 4 }}>
            No games found matching your description. Try using different keywords.
          </Typography>
        )}

        {!isLoading && games.length > 0 && (
          <Grid2 
            container 
            spacing={{ xs: 1, sm: 2 }} 
            justifyContent="center"
          >
            {games.map((game) => (
              <Grid2
                size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                key={game.id}
              >
                <GameCard 
                  game={game} 
                  variant="standard" 
                  relevanceScore={scores.get(game.id)}
                />
              </Grid2>
            ))}
          </Grid2>
        )}
      </Box>
    </Box>
  );
};

export default SemanticSearchPage;