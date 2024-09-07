// src/components/Search/SearchFilters.tsx
// v1.2
// Updated author fetching to load all authors, fixed pagination issue

import React, { useState, useEffect } from 'react';
import { TextField, Autocomplete, CircularProgress, Box, Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import axios from 'axios';

interface Author {
  id: number;
  attributes: {
    Name: string;
  };
}

interface Tag {
  id: number;
  attributes: {
    Name: string;
  };
}

interface SearchFiltersProps {
  tags: Tag[];
  authors: Author[];
  selectedTags: string[];
  selectedAuthors: string[];
  onTagChange: (event: React.SyntheticEvent, value: string[]) => void;
  onAuthorChange: (event: React.SyntheticEvent, value: string[]) => void;
}

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:1337';

const fetchAllAuthors = async (): Promise<Author[]> => {
  let allAuthors: Author[] = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await axios.get(`${API_URL}/api/authors`, {
        params: {
          'pagination[page]': page,
          'pagination[pageSize]': 100,
        },
      });

      const { data, meta } = response.data;
      allAuthors = [...allAuthors, ...data];

      if (meta.pagination.page >= meta.pagination.pageCount) {
        hasMorePages = false;
      } else {
        page++;
      }
    } catch (error) {
      console.error('Error fetching authors:', error);
      hasMorePages = false;
    }
  }

  return allAuthors;
};

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
  const [allAuthors, setAllAuthors] = useState<Author[]>([]);

  useEffect(() => {
    const loadAllAuthors = async () => {
      setIsLoadingAuthors(true);
      const fetchedAuthors = await fetchAllAuthors();
      setAllAuthors(fetchedAuthors);
      setIsLoadingAuthors(false);
    };

    loadAllAuthors();
  }, []);

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
        options={allAuthors.map(author => author.attributes.Name)}
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