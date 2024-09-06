// src/components/Header/SearchBar.jsx
// Version 1.5
// Description: Improved error handling and logging

import React, { useState, useEffect } from 'react';
import { TextField, Autocomplete, CircularProgress } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import { useTheme } from '@mui/material/styles';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';

export default function SearchBar() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Game[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const theme = useTheme();

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (searchQuery) {
        (async () => {
          setIsLoading(true);
          console.log('Performing search for:', searchQuery);
          const fetchedGames = await gamesCollection.getFullList({
            filter: `title ~ "${searchQuery}"`,
            sort: '-created',
            expand: 'tags.tag_categories_via_tags,authors_via_games',
          });
          console.log('Search results:', fetchedGames);
          setSearchResults(fetchedGames);
          setIsLoading(false);
        })();
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  return (
    <Autocomplete
      freeSolo
      options={searchResults}
      getOptionLabel={(option) => (typeof option === 'object' ? option.title : option) || ''}
      renderInput={(params) => (
        <TextField
          {...params}
          variant="outlined"
          size="small"
          placeholder="Search..."
          onChange={(e) => setSearchQuery(e.target.value)}
          slotProps={{
            input: {
              ...params.InputProps,
              endAdornment: (
                <React.Fragment>
                  {isLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </React.Fragment>
              ),
            },
          }}
          sx={{
            width: 200,
            mr: 2,
            backgroundColor: theme.palette.grey[800],
            borderRadius: 1,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: 'transparent',
              },
              '&:hover fieldset': {
                borderColor: 'transparent',
              },
              '&.Mui-focused fieldset': {
                borderColor: 'transparent',
              },
              '& input': {
                padding: '7px 14px',
                color: theme.palette.text.primary,
                fontSize: '0.875rem',
              },
            },
            '& .MuiInputBase-input::placeholder': {
              color: theme.palette.text.secondary,
              opacity: 0.8,
            },
          }}
        />
      )}
      onChange={(_, newValue) => {
        if (typeof newValue === 'object' && newValue && newValue.id) {
          console.log('Selected game:', newValue);
          navigate(`/game/${newValue.id}`);
        }
      }}
      renderOption={(props, option) => (
        <li {...props} key={option.id}>
          <Link to={`/game/${option.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            {option.title}
          </Link>
        </li>
      )}
    />
  );
}
