// src/components/Header/TagAuthorSelector.tsx

import React from 'react';
import { Box, Autocomplete, TextField, Chip, useTheme } from '@mui/material';

interface TagAuthorSelectorProps {
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

const TagAuthorSelector: React.FC<TagAuthorSelectorProps> = ({
  tags,
  authors,
  selectedTags,
  selectedAuthors,
  onTagChange,
  onAuthorChange,
}) => {
  const theme = useTheme();

  const commonStyles = {
    minWidth: 184,
    maxWidth: 400,
    minHeight: 38,
    mr: 2,
    backgroundColor: theme.palette.grey[800],
    borderRadius: 1,
    transition: 'width 0.3s',
    '& .MuiOutlinedInput-root': {
      padding: '3px !important',
      paddingRight: '1px !important',
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
    '& .MuiAutocomplete-tag': {
      margin: '2px',
    },
    '& .MuiInputBase-root': {
      alignItems: 'center',
      minHeight: '38px',
    },
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
              onTagChange(selectedTags.filter(tag => tag !== option));
            } else if (value === selectedAuthors) {
              onAuthorChange(selectedAuthors.filter(author => author !== option));
            }
          }}
          sx={chipStyles}
        />
      );
    });

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
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
        renderTags={renderTags}
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
        renderTags={renderTags}
        disableCloseOnSelect
        limitTags={-1}
        sx={{ width: 250 }}
      />
    </Box>
  );
};

export default TagAuthorSelector;