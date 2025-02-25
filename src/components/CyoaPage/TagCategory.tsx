import React from 'react';
import { Box, Typography, IconButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote } from '../../pocketbase/pocketbase';
import TagChip from './TagChip';

const CATEGORY_FONT_WEIGHT = '500';
const GAP = 0.75;

interface TagCategoryProps {
  category: string;
  tags: Tag[];
  tagVotes: Record<string, GameTagVote>;
  isUpdating: Record<string, boolean>;
  onTagClick: (tag: Tag) => void;
  onAddTagClick: (event: React.MouseEvent<HTMLElement>, category: string) => void;
  user: any; // Тип для пользователя
}

export default function TagCategory({
  category,
  tags,
  tagVotes,
  isUpdating,
  onTagClick,
  onAddTagClick,
  user
}: TagCategoryProps) {
  const theme = useTheme();

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP }}>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: CATEGORY_FONT_WEIGHT,
            display: 'inline-flex',
            alignItems: 'center',
            mr: 1,
            minWidth: 'max-content',
            color: theme.palette.text.primary,
          }}
        >
          {category}:
        </Typography>
        {user && (
          <IconButton 
            size="small" 
            onClick={(e) => onAddTagClick(e, category)}
            sx={{ 
              ml: 0.5, 
              color: theme.palette.grey[500],
              padding: '2px',
              '&:hover': {
                backgroundColor: theme.palette.grey[800],
                color: theme.palette.grey[300],
              }
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        )}
      </Box>
      
      {tags.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          vote={tagVotes[tag.id]}
          isUpdating={isUpdating[tag.id]}
          user={user}
          onClick={() => onTagClick(tag)}
        />
      ))}
    </Box>
  );
}