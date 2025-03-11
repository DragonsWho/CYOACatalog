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
      
      {user && (
        <IconButton 
          size="small" 
          onClick={(e) => onAddTagClick(e, category)}
          sx={{ 
            color: theme.palette.mode === 'dark' 
              ? theme.palette.grey[700]  // Более темный оттенок для темной темы
              : theme.palette.grey[400], // Более светлый оттенок для светлой темы
            padding: '2px',
            opacity: 0.25,              // Уменьшаем непрозрачность для дополнительного снижения заметности
            '&:hover': {
              backgroundColor: theme.palette.mode === 'dark'
                ? theme.palette.grey[800]
                : theme.palette.grey[200],
              color: theme.palette.mode === 'dark'
                ? theme.palette.grey[500]  // Светлее при наведении, но не слишком
                : theme.palette.grey[600], // Темнее при наведении для светлой темы
              opacity: 1,                  // Увеличиваем непрозрачность при наведении
            }
          }}
          aria-label={`Добавить тег в категорию ${category}`}
        >
          <AddIcon 
            sx={{ 
              fontSize: '1rem' // Меньший размер иконки
            }} 
          />
        </IconButton>
      )}
    </Box>
  );
}