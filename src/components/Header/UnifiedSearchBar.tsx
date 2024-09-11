// src/components/Header/UnifiedSearchBar.tsx

import React, { useState, useEffect } from 'react';
import { Box, TextField, Autocomplete, Chip, IconButton, Popover, useTheme } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useNavigate } from 'react-router-dom';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';

interface UnifiedSearchBarProps {
  tags: string[];
  authors: string[];
  selectedTags: string[];
  selectedAuthors: string[];
  onTagChange: (value: string[]) => void;
  onAuthorChange: (value: string[]) => void;
}

const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_BORDER_RADIUS = '4px';

export default function UnifiedSearchBar({
  tags,
  authors,
  selectedTags,
  selectedAuthors,
  onTagChange,
  onAuthorChange,
}: UnifiedSearchBarProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Game[]>([]);
  const navigate = useNavigate();
  const theme = useTheme();

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (searchQuery) {
        (async () => {
          const fetchedGames = await gamesCollection.getFullList({
            filter: `title ~ "${searchQuery}"`,
            sort: '-created',
            expand: 'tags.tag_categories_via_tags,authors_via_games',
          });
          setSearchResults(fetchedGames);
        })();
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  const commonStyles = {
    minWidth: 184,
    maxWidth: 400,
    minHeight: 38,
    mr: 2,
    backgroundColor: theme.palette.grey[800],
    borderRadius: 1,
    '& .MuiOutlinedInput-root': {
      padding: '3px !important',
      paddingRight: '1px !important',
      flexWrap: 'wrap',
      '& fieldset': { borderColor: 'transparent' },
      '&:hover fieldset': { borderColor: 'transparent' },
      '&.Mui-focused fieldset': { borderColor: 'transparent' },
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
    '& .MuiAutocomplete-popupIndicator': { display: 'none' },
    '& .MuiAutocomplete-endAdornment': { display: 'none', right: '1px !important' },
    '& .MuiAutocomplete-tag': { margin: '2px' },
    '& .MuiInputBase-root': { alignItems: 'center', minHeight: '38px' },
  };

  const chipStyles = {
    height: CHIP_HEIGHT,
    fontSize: CHIP_FONT_SIZE,
    borderRadius: CHIP_BORDER_RADIUS,
    backgroundColor: theme.palette.error.main,
    color: theme.palette.error.contrastText,
    '& .MuiChip-label': {
      paddingRight: '8px',
      paddingLeft: '8px',
      fontSize: '0.75rem',
      lineHeight: '24px',
    },
    '&:hover': {
      backgroundColor: theme.palette.error.dark,
      cursor: 'pointer',
    },
  };

  const renderTags = (value: string[], getTagProps: (params: { index: number }) => any, isTag: boolean) =>
    value.map((option: string, index: number) => {
      const { key, ...otherProps } = getTagProps({ index });
      return (
        <Chip
          key={key}
          label={option}
          {...otherProps}
          onDelete={undefined}
          onClick={() => {
            if (isTag) {
              onTagChange(selectedTags.filter(tag => tag !== option));
            } else {
              onAuthorChange(selectedAuthors.filter(author => author !== option));
            }
          }}
          sx={chipStyles}
        />
      );
    });

  return (
    <>
      <IconButton onClick={handleClick} color="inherit">
        <SearchIcon />
      </IconButton>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Autocomplete
            freeSolo
            options={searchResults}
            getOptionLabel={(option) => (typeof option === 'object' ? option.title : option)}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder="Search titles..."
                onChange={(e) => setSearchQuery(e.target.value)}
                sx={commonStyles}
              />
            )}
            onChange={(_, newValue) => {
              if (typeof newValue === 'object' && newValue && newValue.id) {
                navigate(`/game/${newValue.id}`);
                handleClose();
              }
            }}
            sx={{ width: 250 }}
          />
          <Autocomplete
            multiple
            options={tags}
            value={selectedTags}
            onChange={(_, value) => onTagChange(value)}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedTags.length === 0 ? "Tags..." : ""}
                sx={commonStyles}
              />
            )}
            renderTags={(value, getTagProps) => renderTags(value, getTagProps, true)}
            disableCloseOnSelect
            limitTags={-1}
            sx={{ width: 250 }}
          />
          <Autocomplete
            multiple
            options={authors}
            value={selectedAuthors}
            onChange={(_, value) => onAuthorChange(value)}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedAuthors.length === 0 ? "Authors..." : ""}
                sx={commonStyles}
              />
            )}
            renderTags={(value, getTagProps) => renderTags(value, getTagProps, false)}
            disableCloseOnSelect
            limitTags={-1}
            sx={{ width: 250 }}
          />
        </Box>
      </Popover>
    </>
  );
}