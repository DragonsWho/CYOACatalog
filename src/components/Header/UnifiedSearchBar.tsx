import React, { useState, useEffect } from 'react';
import { Box, TextField, Autocomplete, Chip, IconButton, Popover, useTheme, createFilterOptions } from '@mui/material';
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
  // Новые пропсы для консистентного размера и отступов иконки
  currentBreakpointIconSize?: string;
  currentBreakpointPadding?: string | number;
}

const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_BORDER_RADIUS = '4px';

const positiveTagColor = 'success';
const negativeTagColor = 'error';
const authorTagColor = 'info';

const defaultFilter = createFilterOptions<string>();

export default function UnifiedSearchBar({
  tags,
  authors,
  selectedTags,
  selectedAuthors,
  onTagChange,
  onAuthorChange,
  currentBreakpointIconSize, // Например "1.1rem"
  currentBreakpointPadding,  // Например "4px"
}: UnifiedSearchBarProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagInputValue, setTagInputValue] = useState('');
  const [searchResults, setSearchResults] = useState<Game[]>([]);
  const navigate = useNavigate();
  const theme = useTheme();

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
    setTagInputValue('');
    setSearchQuery('');
  };

  const open = Boolean(anchorEl);

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (searchQuery) {
        (async () => {
            try {
                const fetchedGames = await gamesCollection.getList(1, 10, { filter: `title ~ "${searchQuery}"`, sort: '-created', fields: 'id,title', });
                setSearchResults(fetchedGames.items);
            } catch (error) { console.error("Error fetching game titles:", error); setSearchResults([]); }
        })();
      } else { setSearchResults([]); }
    }, 300);
    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  const commonStyles = {
    backgroundColor: theme.palette.background.paper,
    '& .MuiOutlinedInput-root': {
      '& fieldset': {
        // borderColor: theme.palette.divider,
      },
      '&:hover fieldset': {
        // borderColor: theme.palette.primary.light,
      },
      '&.Mui-focused fieldset': {
        // borderColor: theme.palette.primary.main,
      },
    },
  };

  function renderTags( value: string[], getTagProps: (params: { index: number }) => Record<string, any>, isTag: boolean,) {
      return value.map((option: string, index: number) => {
        const { key, ...otherProps } = getTagProps({ index });
        const isNegative = isTag && option.startsWith('-');
        const label = isNegative ? option.substring(1) : option;

        let chipColor: 'success' | 'error' | 'info' | 'default' = 'default';
        let chipVariant: 'filled' | 'outlined' = 'filled';
        if (isTag) {
          chipColor = isNegative ? negativeTagColor : positiveTagColor;
          chipVariant = 'outlined';
        } else {
          chipColor = authorTagColor;
          chipVariant = 'filled';
        }
        const baseTagName = isNegative ? option.substring(1) : option;
        const isValid = isTag ? tags.includes(baseTagName) : authors.includes(baseTagName);

        return ( <Chip key={option} label={label} size="small" color={isValid ? chipColor : 'default'} variant={isValid ? chipVariant : 'outlined'} title={!isValid ? `Invalid ${isTag ? 'tag' : 'author'}` : undefined} {...otherProps} onDelete={() => { if (isTag) { onTagChange(selectedTags.filter((t) => t !== option)); } else { onAuthorChange(selectedAuthors.filter((a) => a !== option)); } }} sx={{ height: CHIP_HEIGHT, fontSize: CHIP_FONT_SIZE, borderRadius: CHIP_BORDER_RADIUS, textDecoration: !isValid ? 'line-through' : 'none', opacity: !isValid ? 0.7 : 1, '& .MuiChip-deleteIcon': { fontSize: '0.8rem', color: !isValid ? theme.palette.action.disabled : (chipVariant === 'outlined' ? theme.palette[chipColor]?.main : theme.palette[chipColor]?.contrastText), '&:hover': { color: !isValid ? theme.palette.action.disabled : (chipVariant === 'outlined' ? theme.palette[chipColor]?.dark : undefined), } } }} /> );
      });
    }

  const filterTagOptions = (options: string[], params: { inputValue: string; getOptionLabel: (option: string) => string; }) => {
    const cleanedInput = params.inputValue.startsWith('-')
      ? params.inputValue.substring(1)
      : params.inputValue;
    const filtered = defaultFilter(options, { ...params, inputValue: cleanedInput });
    return filtered;
  };

  const handleAddTag = (tagToAdd: string | null) => {
    if (!tagToAdd) return;
    const trimmedItem = tagToAdd.trim();
    if (!trimmedItem) return;
    const isNegative = trimmedItem.startsWith('-');
    const baseTagName = isNegative ? trimmedItem.substring(1) : trimmedItem;
    if (tags.includes(baseTagName)) {
        const newSelection = [...new Set([...selectedTags, trimmedItem])];
        onTagChange(newSelection);
    }
    setTagInputValue('');
  };

  return (
    <>
      <IconButton
        onClick={handleClick}
        color="inherit"
        sx={{
            padding: currentBreakpointPadding // Используем переданный padding
        }}
        aria-label="Open search"
      >
        <SearchIcon sx={{
            fontSize: currentBreakpointIconSize // Используем переданный размер иконки
        }}/>
      </IconButton>
      <Popover
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        PaperProps={{ sx: { p: 0, mt: 0.5, borderRadius: theme.shape.borderRadius } }}
      >
        <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: { xs: 260, sm: 280 } }}>
          <Autocomplete
            freeSolo
            options={searchResults}
            getOptionLabel={(option) => (typeof option === 'object' ? option.title : option)}
            inputValue={searchQuery}
            onInputChange={(_, v, r) => {if (r === 'input') setSearchQuery(v);}}
            renderInput={(params) => (
                <TextField {...params} variant="outlined" size="small" placeholder="Search titles..." sx={commonStyles} />
            )}
            onChange={(_, v) => { if (typeof v === 'object' && v?.id) { navigate(`/game/${v.id}`); handleClose(); } else if (typeof v === 'string') { setSearchQuery(''); }}}
            PaperComponent={(props) => <Box {...props} sx={{ bgcolor: 'background.paper' }} />}
          />

          <Autocomplete
            multiple
            freeSolo
            value={selectedTags}
            options={tags}
            inputValue={tagInputValue}
            onInputChange={(_event, newInputValue) => {
                setTagInputValue(newInputValue);
            }}
            onChange={(_event, newValue, reason, details) => {
                if (reason === 'selectOption' && details?.option) {
                    const selectedOption = details.option;
                    const addNegative = tagInputValue.trim().startsWith('-');
                    const tagToAdd = addNegative ? `-${selectedOption}` : selectedOption;
                    handleAddTag(tagToAdd);
                    // return false; // Эта строка вызывала ошибку типов, т.к. onChange не должен возвращать boolean
                } else if (reason === 'removeOption' || reason === 'clear') {
                     onTagChange(newValue as string[]);
                     if (reason === 'clear') setTagInputValue('');
                }
            }}
            filterOptions={filterTagOptions}
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedTags.length === 0 ? 'Filter tags (+/-)...' : ''}
                sx={commonStyles}
                 onKeyDown={(event) => {
                    if (event.key === 'Enter' && tagInputValue.trim()) {
                         event.preventDefault();
                         event.stopPropagation();
                         handleAddTag(tagInputValue);
                    }
                 }}
              />
            )}
            renderTags={(value, getTagProps) => renderTags(value, getTagProps, true)}
            disableCloseOnSelect
            limitTags={-1}
            getOptionLabel={(option) => option}
            PaperComponent={(props) => <Box {...props} sx={{ bgcolor: 'background.paper' }} />}
          />

          <Autocomplete
            multiple
            options={authors}
            value={selectedAuthors}
            onChange={(_, value) => onAuthorChange(value)}
            renderInput={(params) => (
                <TextField {...params} variant="outlined" size="small" placeholder={selectedAuthors.length === 0 ? 'Filter authors...' : ''} sx={commonStyles} />
            )}
            renderTags={(value, getTagProps) => renderTags(value, getTagProps, false)}
            disableCloseOnSelect
            limitTags={-1}
            PaperComponent={(props) => <Box {...props} sx={{ bgcolor: 'background.paper' }} />}
          />
        </Box>
      </Popover>
    </>
  );
}