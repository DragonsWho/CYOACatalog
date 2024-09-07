// src/components/Search/SearchFilters.tsx
// v1.1
// Updated to match SearchBar styling and functionality

import React, { useState, useEffect } from 'react';
import { TextField, Autocomplete, CircularProgress, Box, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';

interface SearchFiltersProps {
  tags: any[];
  authors: any[];
  selectedTags: string[];
  selectedAuthors: string[];
  onTagChange: (event: React.SyntheticEvent, value: string[]) => void;
  onAuthorChange: (event: React.SyntheticEvent, value: string[]) => void;
}

const SearchFilters: React.FC<SearchFiltersProps> = ({
    tags,
    authors,
    selectedTags,
    selectedAuthors,
    onTagChange,
    onAuthorChange
  }) => {
    const theme = useTheme();
    const [tagQuery, setTagQuery] = useState('');
    const [authorQuery, setAuthorQuery] = useState('');
    const [isLoadingTags, setIsLoadingTags] = useState(false);
    const [isLoadingAuthors, setIsLoadingAuthors] = useState(false);

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (tagQuery) {
        setIsLoadingTags(true);
        // Здесь можно добавить логику поиска тегов
        setTimeout(() => setIsLoadingTags(false), 300);
      }
    }, 300);

    return () => clearTimeout(delayDebounce);
  }, [tagQuery]);

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (authorQuery) {
        setIsLoadingAuthors(true);
        // Здесь можно добавить логику поиска авторов
        setTimeout(() => setIsLoadingAuthors(false), 300);
      }
    }, 300);

    return () => clearTimeout(delayDebounce);
  }, [authorQuery]);

  const commonStyles = {
    minWidth: 100,
    maxWidth: 400,
    flexGrow: 1,
    mr: 2,
    backgroundColor: theme.palette.grey[800],
    borderRadius: 1,
    transition: 'width 0.3s',
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
  };

  // Стили для тегов
  const tagStyles = {
    margin: '2px',
    backgroundColor: theme.palette.primary.main,
    color: theme.palette.primary.contrastText,
    '& .MuiChip-deleteIcon': {
      color: theme.palette.primary.contrastText,
    },
  };

  return (
    <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
      <Autocomplete
        multiple
        freeSolo
        options={tags.map(tag => tag.attributes.Name)}
        value={selectedTags}
        onChange={onTagChange}
        renderInput={(params) => (
          <TextField
            {...params}
            variant="outlined"
            size="small"
            placeholder="Tags..."
            onChange={(e) => setTagQuery(e.target.value)}
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <React.Fragment>
                  {isLoadingTags ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </React.Fragment>
              ),
            }}
            sx={commonStyles}
          />
        )}
        renderTags={(value: string[], getTagProps) =>
          value.map((option: string, index: number) => (
            <Chip
              label={option}
              {...getTagProps({ index })}
              sx={tagStyles}
            />
          ))
        }
      />
      <Autocomplete
        multiple
        freeSolo
        options={authors.map(author => author.attributes.Name)}
        value={selectedAuthors}
        onChange={onAuthorChange}
        renderInput={(params) => (
          <TextField
            {...params}
            variant="outlined"
            size="small"
            placeholder="Authors..."
            onChange={(e) => setAuthorQuery(e.target.value)}
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <React.Fragment>
                  {isLoadingAuthors ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </React.Fragment>
              ),
            }}
            sx={commonStyles}
          />
        )}
        renderTags={(value: string[], getTagProps) =>
          value.map((option: string, index: number) => (
            <Chip
              label={option}
              {...getTagProps({ index })}
              sx={tagStyles}
            />
          ))
        }
      />
    </Box>
  );
};

export default SearchFilters;