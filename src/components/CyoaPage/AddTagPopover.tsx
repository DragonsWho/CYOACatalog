// src/components/CyoaPage/AddTagPopover.tsx
// v1.1
// Компонент для добавления новых тегов с обновленной логикой предложения тегов

import React from 'react';
import { Box, Chip, Typography, Popover, Divider } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag } from '../../pocketbase/pocketbase';

interface AddTagPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  currentCategory: string;
  availableTags: Tag[];
  onClose: () => void;
  onTagSelect: (tag: Tag) => void;
  isUpdating: Record<string, boolean>;
}

// Константы стилей
const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';

const AddTagPopover: React.FC<AddTagPopoverProps> = ({
  open,
  anchorEl,
  currentCategory,
  availableTags,
  onClose,
  onTagSelect,
  isUpdating,
}) => {
  const theme = useTheme();

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{
        vertical: 'bottom',
        horizontal: 'left',
      }}
      transformOrigin={{
        vertical: 'top',
        horizontal: 'left',
      }}
      PaperProps={{
        sx: {
          mt: 0.5,
          p: 1.5,
          backgroundColor: theme.palette.grey[900],
          border: `1px solid ${theme.palette.grey[800]}`,
          boxShadow: '0 4px 8px rgba(0, 0, 0, 0.5)',
          maxWidth: '80vw',
          maxHeight: '300px',
          overflowY: 'auto',
        }
      }}
    >
 
      
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
        {availableTags.length > 0 ? (
          availableTags.map((tag) => (
            <Chip
              key={tag.id}
              label={tag.name}
              size="small"
              onClick={() => onTagSelect(tag)}
              disabled={isUpdating[tag.id]}
              sx={{
                height: CHIP_HEIGHT,
                borderRadius: CHIP_BORDER_RADIUS,
                backgroundColor: theme.palette.grey[800],
                color: theme.palette.grey[400],
                cursor: 'pointer',
                opacity: isUpdating[tag.id] ? 0.7 : 1,
                '&:hover': {
                  backgroundColor: theme.palette.grey[700],
                },
                '& .MuiChip-label': {
                  fontSize: CHIP_FONT_SIZE,
                  padding: CHIP_PADDING,
                },
              }}
            />
          ))
        ) : (
          <Typography variant="body2" sx={{ color: theme.palette.grey[500], fontStyle: 'italic' }}>
            Нет доступных тегов
          </Typography>
        )}
      </Box>
      
 
    </Popover>
  );
};

// Константы, соответствующие значениям в TagDisplay
const ACTIVATION_THRESHOLD = 5;
const INITIAL_ACTIVE_VOTE = -30;

export default AddTagPopover;