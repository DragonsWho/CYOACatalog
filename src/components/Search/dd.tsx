// src/components/Search/SearchFilters.tsx
// v1.3
// Updated chip styling and truncated chip labels

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











const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 4px';
const CHIP_BORDER_RADIUS = '4px';
const MAX_LABEL_LENGTH = 6;

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
    flexBasis: 'auto',
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
        
        // padding: '110px 141px', // Уменьшим вертикальные отступы ввода
        // height: '100%', // Растягиваем поле ввода на всю высоту
      },
    },
    '& .MuiInputBase-input::placeholder': {
      color: theme.palette.text.secondary,
      opacity: 0.8,
    },
  };

  const chipStyles = {
    height: CHIP_HEIGHT,
    fontSize: CHIP_FONT_SIZE, 
    padding: '0 2px',
    margin: '-21px',
    borderRadius: CHIP_BORDER_RADIUS,
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
    '& .MuiChip-deleteIcon': {
      color: theme.palette.error.contrastText,
      marginRight: '0px',  
      marginLeft: '-3px',  
    },
    '& .MuiChip-label': {
      paddingRight: '4px',   
      paddingLeft: '2px',  
    }
  };

  const autocompleteStyles = { 
    '& .MuiAutocomplete-tag': {
      margin: '1px 2px 3px 2px', // Уменьшаем отступы между чипами
    },
  };




  const truncateLabel = (label: string) => {
    return label.length > MAX_LABEL_LENGTH
      ? `${label.substring(0, MAX_LABEL_LENGTH)}...`
      : label;
  };

  return (
<Box sx={{ display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap',   }}>
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
        sx={{ ...commonStyles, ...autocompleteStyles }}
        renderTags={(value: string[], getTagProps) =>
          value.map((option: string, index: number) => (
            <Chip
              label={truncateLabel(option)}
              {...getTagProps({ index })}
              sx={chipStyles}
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
        sx={{ ...commonStyles, ...autocompleteStyles }}
        renderTags={(value: string[], getTagProps) =>
          value.map((option: string, index: number) => (
            <Chip
              label={truncateLabel(option)}
              {...getTagProps({ index })}
              sx={chipStyles}
            />
          ))
        }
      />
    </Box>
  );
};

export default SearchFilters;