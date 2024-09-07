// src/components/Search/SearchPage.tsx
// v1.3
// Updated to use separate SearchFilters component

import React, { useState, useEffect } from 'react';
import { 
  Box, 
  Typography, 
  CircularProgress,
  Grid,
  useTheme
} from '@mui/material';
import { fetchGames, getAuthors, getTags, getTagCategories } from '../../services/api';
import GameCard from '../GameCard';
import SearchFilters from './SearchFilters';

interface Game {
    id: string;
    title: string;
    description: any;
    image: string;
    tags: any[];
    authors: { name: string }[];
    Upvotes: any[];
    commentCount: number;
}

interface TagCategory {
    attributes: {
        Name: string;
        tags: {
            data: any[];
        };
    };
}

const SearchPage: React.FC = () => {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [authors, setAuthors] = useState<any[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [gamesData, tagsData, authorsData, categoriesData] = await Promise.all([
          fetchGames(1, 1000), // Fetch all games, adjust page size as needed
          getTags(),
          getAuthors(),
          getTagCategories()
        ]);
        setGames(gamesData.games);
        setTags(tagsData);
        setAuthors(authorsData);
        setTagCategories(categoriesData);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching data:', error);
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  const handleTagChange = (event: React.SyntheticEvent, value: string[]) => {
    setSelectedTags(value);
  };

  const handleAuthorChange = (event: React.SyntheticEvent, value: string[]) => {
    setSelectedAuthors(value);
  };

  const filterGames = (game: Game) => {
    const gameTags = game.tags.map(tag => tag.attributes.Name);
    const gameAuthors = game.authors.map(author => author.name);

    const includedTags = selectedTags.filter(tag => !tag.startsWith('-'));
    const excludedTags = selectedTags.filter(tag => tag.startsWith('-')).map(tag => tag.slice(1));

    const hasAllIncludedTags = includedTags.every(tag => gameTags.includes(tag));
    const hasNoExcludedTags = excludedTags.every(tag => !gameTags.includes(tag));
    const hasSelectedAuthors = selectedAuthors.length === 0 || selectedAuthors.some(author => gameAuthors.includes(author));

    return hasAllIncludedTags && hasNoExcludedTags && hasSelectedAuthors;
  };

  const filteredGames = games.filter(filterGames);

  return (
    <Box sx={{ width: '100%', p: 3 }}>
 
      <SearchFilters
        tags={tags}
        authors={authors}
        selectedTags={selectedTags}
        selectedAuthors={selectedAuthors}
        onTagChange={handleTagChange}
        onAuthorChange={handleAuthorChange}
      />
      {loading ? (
        <CircularProgress />
      ) : (
        <Grid container spacing={2} justifyContent="center">
          {filteredGames.map((game) => (
            <Grid item xs={12} sm={6} md={4} lg={2.4} key={game.id}>
              <GameCard game={game} tagCategories={tagCategories} />
            </Grid>
          ))}
        </Grid>
      )}
      {!loading && filteredGames.length === 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center' }}>No games found matching your search criteria</Typography>
      )}
    </Box>
  );
};

export default SearchPage;