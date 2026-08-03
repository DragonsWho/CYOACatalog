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
  goldTagIds?: Set<string>;
  isUpdating: Record<string, boolean>;
  editing?: boolean;
  onTagClick: (tag: Tag) => void;
  onAddTagClick: (event: React.MouseEvent<HTMLElement>, category: string) => void;
  user: any; // Тип для пользователя
}

export default function TagCategory({
  category,
  tags,
  tagVotes,
  goldTagIds,
  isUpdating,
  editing = false,
  onTagClick,
  onAddTagClick,
  user
}: TagCategoryProps) {
  const theme = useTheme();

  return (
    // display:flex делает каждую строку категории независимым форматирующим контекстом —
    // строки аккуратно обтекают плавающую справа инструкцию (компактные верхние — рядом,
    // широкие нижние — на всю ширину). mb заменяет gap родителя (он стал block-flow).
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP, mb: 0.5 }}>
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
          isGold={goldTagIds?.has(tag.id)}
          isUpdating={isUpdating[tag.id]}
          editing={editing}
          user={user}
          onClick={() => onTagClick(tag)}
        />
      ))}

      {user && editing && (
        <IconButton
          size="small"
          onClick={(e) => onAddTagClick(e, category)}
          sx={{
            color: theme.palette.text.secondary,
            padding: '2px',
            opacity: 0.6,
            transition: 'opacity .15s, color .15s, background .15s',
            '&:hover': {
              backgroundColor: theme.palette.mode === 'dark'
                ? theme.palette.grey[800]
                : theme.palette.grey[200],
              color: theme.palette.text.primary,
              opacity: 1,
            }
          }}
          aria-label={`Suggest a tag in ${category}`}
        >
          <AddIcon sx={{ fontSize: '1rem' }} />
        </IconButton>
      )}
    </Box>
  );
}
