// src/components/Search/SearchPage.tsx
// v1.9
// Dynamic width Autocomplete without extra space

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Box, 
  Typography, 
  CircularProgress,
  Grid,
  useTheme,
  Autocomplete,
  TextField,
  Chip
} from '@mui/material';
import { Game, Tag, Author, gamesCollection, tagsCollection, authorsCollection } from '../../pocketbase/pocketbase';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_BORDER_RADIUS = '4px';

interface SearchPageProps {}

const SearchPage: React.FC<SearchPageProps> = () => {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchTags = useCallback(async () => {
    try {
      const fetchedTags = await tagsCollection.getFullList({
        sort: 'name',
        expand: 'tag_categories_via_tags',
      });
      setTags(fetchedTags);
    } catch (error) {
      console.error('Error fetching tags:', error);
    }
  }, []);

  const fetchAuthors = useCallback(async () => {
    try {
      const fetchedAuthors = await authorsCollection.getFullList({
        sort: 'name',
      });
      setAuthors(fetchedAuthors);
    } catch (error) {
      console.error('Error fetching authors:', error);
    }
  }, []);

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
    fetchTags();
    fetchAuthors();
  }, [fetchTags, fetchAuthors]);

  useEffect(() => {
    setGames([]);
    setPage(1);
    setHasMore(true);
  }, [selectedTags, selectedAuthors]);

  useEffect(() => {
    fetchGames();
  }, [fetchGames]);

  const handleTagChange = (_event: React.SyntheticEvent, value: string[]) => {
    setSelectedTags(value);
  };

  const handleAuthorChange = (_event: React.SyntheticEvent, value: string[]) => {
    setSelectedAuthors(value);
  };

  const commonStyles = useMemo(() => ({
    minWidth: 184,
    maxWidth: 400,
    minHeight: 38,
    mr: 2,
    backgroundColor: theme.palette.grey[800],
    borderRadius: 1,
    transition: 'width 0.3s',
    '& .MuiOutlinedInput-root': {
      padding: '3px !important', 
      
    paddingRight: '1x !important',
      flexWrap: 'wrap',
      '& fieldset': {
        borderColor: 'transparent',
      },
      '&:hover fieldset': {
        borderColor: 'transparent',
      },
      '&.Mui-focused fieldset': {
        borderColor: 'transparent',
      },
    },
    '& .MuiAutocomplete-input': {
      padding: '1px 6px !important',
      color: theme.palette.text.primary,
      fontSize: '0.875rem',
    },
    '& .MuiInputBase-input::placeholder': {
      color: theme.palette.text.secondary,
      opacity: 0.8,
    },
    '& .MuiAutocomplete-popupIndicator': {
      display: 'none',
    },
    '& .MuiAutocomplete-endAdornment': {
      display: 'none',
      
    right: '1px !important', 
    },
    // Настройте отступы для контейнера чипов здесь
    '& .MuiAutocomplete-tag': {
      margin: '2px',
    },
    // Добавьте эти стили для выравнивания содержимого
    '& .MuiInputBase-root': {
      alignItems: 'center', // Выравнивание по центру
      minHeight: '38px', // Минимальная высота поля ввода
    },
  }), [theme]);
  
  const chipStyles = useMemo(() => ({
    height: CHIP_HEIGHT, // Вы можете изменить это значение
    fontSize: CHIP_FONT_SIZE,
    borderRadius: CHIP_BORDER_RADIUS,
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
    '& .MuiChip-label': {
      paddingRight: '8px',
      paddingLeft: '8px',
      fontSize: '0.75rem',
      // Добавьте эти стили для выравнивания текста внутри чипа
      lineHeight: '24px', // Должно соответствовать высоте чипа
    },
    '&:hover': {
      backgroundColor: theme.palette.error.dark,
      cursor: 'pointer',
    },
  }), [theme]);

  const renderTags = (value: string[], getTagProps: (params: { index: number }) => any) =>
    value.map((option: string, index: number) => {
      const { key, ...otherProps } = getTagProps({ index });
      return (
        <Chip
          key={key}
          label={option}
          {...otherProps}
          onDelete={undefined}
          onClick={() => {
            if (value === selectedTags) {
              setSelectedTags(selectedTags.filter(tag => tag !== option));
            } else if (value === selectedAuthors) {
              setSelectedAuthors(selectedAuthors.filter(author => author !== option));
            }
          }}
          sx={chipStyles}
        />
      );
    });

    return (
      <Box sx={{ width: '100%', p: 3 }}>
        <Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Autocomplete
            multiple
            options={tags.map(tag => tag.name)}
            value={selectedTags}
            onChange={handleTagChange}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedTags.length === 0 ? "Tags..." : ""}
                sx={commonStyles}
              />
            )}
            renderTags={renderTags}
            disableCloseOnSelect
            limitTags={-1}
          />
          <Autocomplete
            multiple
            options={authors.map(author => author.name)}
            value={selectedAuthors}
            onChange={handleAuthorChange}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedAuthors.length === 0 ? "Authors..." : ""}
                sx={commonStyles}
              />
            )}
            renderTags={renderTags}
            disableCloseOnSelect
            limitTags={-1}
          />
        </Box>
      
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