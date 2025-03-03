// src/components/CyoaPage/AddTagPopover.tsx
// v1.3
// Компонент для добавления новых тегов с обновленной логикой предложения тегов, ограничением ширины и всплывающими подсказками

import React from 'react';
import { Box, Chip, Typography, Popover, Tooltip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag } from '../../pocketbase/pocketbase';

interface AddTagPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  currentCategory: string; // Keeping this prop as it's needed in the parent component
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
  // We'll keep currentCategory in the props but we're not using it directly in this component
  // It's used in the parent component to filter available tags
  availableTags,
  onClose,
  onTagSelect,
  isUpdating,
}) => {
  const theme = useTheme();

  // Функция для рендеринга тега с всплывающей подсказкой
  const renderTagWithTooltip = (tag: Tag) => (
    <Tooltip 
      key={tag.id} 
      title={tag.description || 'No description available'} 
      arrow 
      placement="top"
      enterDelay={500}
      leaveDelay={200}
    >
      <Chip
        label={tag.name}
        size="small"
        onClick={() => onTagSelect(tag)}
        disabled={isUpdating[tag.id]}
        sx={{
          height: CHIP_HEIGHT,
          borderRadius: CHIP_BORDER_RADIUS,
          backgroundColor: theme.palette.grey[700], // Lightened background
          color: theme.palette.grey[100], // Much lighter text for contrast
          cursor: 'pointer',
          opacity: isUpdating[tag.id] ? 0.7 : 1,
          '&:hover': {
            backgroundColor: theme.palette.grey[600], // Lighter hover state
            color: 'white', // White text on hover
          },
          '& .MuiChip-label': {
            fontSize: CHIP_FONT_SIZE,
            padding: CHIP_PADDING,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }}
      />
    </Tooltip>
  );

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
          width: 'auto',
          maxWidth: '600px', // Ограничиваем максимальную ширину
          maxHeight: '600px',
          overflowY: 'auto',
        }
      }}
    >
      <Box sx={{ 
        display: 'flex', 
        flexWrap: 'wrap', 
        gap: 0.75,
        width: '100%'
      }}>
        {availableTags.length > 0 ? (
          availableTags.map((tag) => renderTagWithTooltip(tag))
        ) : (
          <Typography variant="body2" sx={{ color: theme.palette.grey[300], fontStyle: 'italic', width: '100%' }}>
            No available tags
          </Typography>
        )}
      </Box>
    </Popover>
  );
};

export default AddTagPopover;