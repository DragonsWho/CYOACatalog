// src/components/CyoaPage/CustomTagPopover.tsx
import React, { useState, KeyboardEvent, ChangeEvent, useEffect } from 'react';
import { 
  Box, 
  TextField, 
  Button, 
  Typography, 
  Popover, 
  Chip,
  CircularProgress,
  Divider,
  Tooltip
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote } from '../../pocketbase/pocketbase';
import { ACTIVATION_THRESHOLD, PROPOSED_TAG_VOTE_VALUE } from './TagDisplay';

interface CustomTagPopoverProps {
  open: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onTagCreate: (tagName: string) => Promise<void>;
  availableTags: Tag[];
  isCreating: boolean;
  gameId: string;
  tagVotes: Record<string, GameTagVote>;
  userId?: string;
}

// Function to calculate Levenshtein distance for tag similarity
function levenshteinDistance(a: string, b: string, maxDistance: number = 3): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    let minDistanceInRow = Infinity;
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
      minDistanceInRow = Math.min(minDistanceInRow, matrix[i][j]);
    }
    if (minDistanceInRow > maxDistance) {
      return Infinity;
    }
  }

  return matrix[b.length][a.length];
}

// Find similar tags based on input
function findSimilarTags(input: string, availableTags: Tag[], maxResults: number = 3): Tag[] {
  if (!input.trim()) return [];
  
  const normalizedInput = input.toLowerCase().trim();

  const tagDistances = availableTags.map((tag) => ({
    ...tag,
    distance: levenshteinDistance(normalizedInput, tag.name.toLowerCase()),
  }));

  const filteredTags = tagDistances.filter((tag) => tag.distance <= 3);
  filteredTags.sort((a, b) => a.distance - b.distance);

  return filteredTags.slice(0, maxResults);
}

const CustomTagPopover: React.FC<CustomTagPopoverProps> = ({
  open,
  anchorEl,
  onClose,
  onTagCreate,
  availableTags,
  isCreating,
  gameId,
  tagVotes,
  userId
}) => {
  const theme = useTheme();
  const [inputValue, setInputValue] = useState<string>('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);
  const [localIsCreating, setLocalIsCreating] = useState<boolean>(false);
  const [proposedTags, setProposedTags] = useState<Tag[]>([]);
 
  // Функция для рендеринга тега с всплывающей подсказкой
  const renderTagWithTooltip = (
    tag: Tag, 
    onClick: () => void, 
    disabled: boolean = false, 
    extraLabel: string = '',
    customStyle: React.CSSProperties = {}
  ) => (
    <Tooltip 
      key={tag.id} 
      title={tag.description || 'No description available'} 
      arrow 
      placement="top"
      enterDelay={500}
      leaveDelay={200}
    >
      <div> {/* Wrapper div needed because disabled Chip can't receive events */}
        <Chip
          label={extraLabel ? `${tag.name} ${extraLabel}` : tag.name}
          size="small"
          onClick={onClick}
          disabled={disabled}
          sx={{
            backgroundColor: customStyle.backgroundColor || theme.palette.grey[700],
            color: theme.palette.grey[100],
            cursor: disabled ? 'default' : 'pointer',
            '&:hover': {
              backgroundColor: disabled 
                ? (customStyle.backgroundColor || theme.palette.grey[700])
                : theme.palette.grey[600],
              color: 'white',
            },
            ...customStyle
          }}
        />
      </div>
    </Tooltip>
  );

  // Находим все предложенные кастомные теги, которые еще не прошли порог активации
  useEffect(() => {
    if (open) {
      // Фильтруем теги, которые имеют votes равное PROPOSED_TAG_VOTE_VALUE и относятся к текущей игре
      const proposedTagIds = Object.keys(tagVotes).filter(tagId => 
        tagVotes[tagId].votes === PROPOSED_TAG_VOTE_VALUE && 
        tagVotes[tagId].gameId === gameId
      );
      
      // Находим информацию о тегах из доступных тегов
      const proposedTagsList = proposedTagIds
        .map(tagId => {
          const tag = availableTags.find(t => t.id === tagId);
          if (tag) {
            // Добавляем информацию о количестве голосов
            return {
              ...tag,
              voteCount: tagVotes[tagId].upVoters?.length || 0,
              // Проверяем, проголосовал ли текущий пользователь за этот тег
              userVoted: userId ? (tagVotes[tagId].upVoters?.includes(userId) || false) : false
            };
          }
          return null;
        })
        .filter((tag): tag is Tag & { voteCount: number, userVoted: boolean } => tag !== null);
      
      // Сортируем по количеству голосов (по убыванию)
      proposedTagsList.sort((a, b) => b.voteCount - a.voteCount);
      
      setProposedTags(proposedTagsList);
    }
  }, [open, tagVotes, gameId, availableTags, userId]);

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const newValue = event.target.value;
    setInputValue(newValue);
    
    // Find suggestions based on input
    if (newValue.trim()) {
      const autoSuggestions = availableTags
        .filter((tag) => tag.name.toLowerCase().includes(newValue.toLowerCase()))
        .slice(0, 5);
      
      if (autoSuggestions.length > 0) {
        setSuggestions(autoSuggestions);
      } else {
        // If no direct matches, try finding similar tags
        const similar = findSimilarTags(newValue, availableTags);
        setSuggestions(similar);
      }
    } else {
      setSuggestions([]);
    }
  };

  const handleKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && inputValue.trim() !== '' && !isCreating && !localIsCreating) {
      await handleCreateTag();
    }
  };

  const handleCreateTag = async () => {
    if (inputValue.trim() === '' || isCreating || localIsCreating) return;
    
    try {
      setLocalIsCreating(true);
      await onTagCreate(inputValue.trim());
      setInputValue('');
      setSuggestions([]);
    } finally {
      setLocalIsCreating(false);
    }
  };

  const handleSuggestionClick = async (tag: Tag) => {
    if (isCreating || localIsCreating) return;
    
    try {
      setLocalIsCreating(true);
      // Here we're using the existing tag instead of creating a new one
      await onTagCreate(tag.name);
      setInputValue('');
      setSuggestions([]);
    } finally {
      setLocalIsCreating(false);
    }
  };

  const handleProposedTagClick = async (tag: Tag) => {
    if (isCreating || localIsCreating) return;
    
    try {
      setLocalIsCreating(true);
      // Используем существующий предложенный тег вместо создания нового
      await onTagCreate(tag.name);
      setInputValue('');
      setSuggestions([]);
    } finally {
      setLocalIsCreating(false);
    }
  };

  // Check if the input represents a new tag
  const isNewTag = inputValue.trim() !== '' && 
    !availableTags.some((tag) => tag.name.toLowerCase() === inputValue.trim().toLowerCase());

  // When the popover closes, reset the state
  React.useEffect(() => {
    if (!open) {
      setInputValue('');
      setSuggestions([]);
      setLocalIsCreating(false);
    }
  }, [open]);

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
          width: '300px', // Fixed width for the input
          maxHeight: '400px',
          overflowY: 'auto',
        }
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <TextField
          fullWidth
          variant="outlined"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Enter custom tag name..."
          size="small"
          disabled={isCreating || localIsCreating}
          sx={{
            backgroundColor: theme.palette.grey[800],
            borderRadius: 1,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: theme.palette.grey[700],
              },
              '&:hover fieldset': {
                borderColor: theme.palette.grey[600],
              },
              '&.Mui-focused fieldset': {
                borderColor: theme.palette.primary.main,
              },
            },
            '& .MuiInputBase-input': {
              color: theme.palette.grey[100],
            },
          }}
        />
        
        {isNewTag && (
          <Button 
            variant="contained" 
            color="primary" 
            onClick={handleCreateTag} 
            disabled={isCreating || localIsCreating || !inputValue.trim()}
            sx={{ mt: 1 }}
          >
            {isCreating || localIsCreating ? 
              <CircularProgress size={24} /> : 
              `Create Tag: ${inputValue}`}
          </Button>
        )}
        
        {suggestions.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2" sx={{ color: theme.palette.grey[300], mb: 1 }}>
              Suggestions:
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {suggestions.map((suggestion) => 
                renderTagWithTooltip(
                  suggestion, 
                  () => handleSuggestionClick(suggestion), 
                  isCreating || localIsCreating
                )
              )}
            </Box>
          </Box>
        )}
        
        {/* Раздел с предложенными тегами */}
        {proposedTags.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Divider sx={{ mb: 1, backgroundColor: theme.palette.grey[700] }} />
            <Typography variant="subtitle2" sx={{ color: theme.palette.grey[300], mb: 1 }}>
              Proposed Custom Tags:
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {proposedTags.map((tag: any) => 
                renderTagWithTooltip(
                  tag,
                  () => handleProposedTagClick(tag),
                  isCreating || localIsCreating || tag.userVoted,
                  `(${tag.voteCount}/${ACTIVATION_THRESHOLD})`,
                  {
                    backgroundColor: tag.userVoted 
                      ? theme.palette.primary.dark 
                      : theme.palette.grey[700]
                  }
                )
              )}
            </Box>
            <Typography variant="caption" sx={{ color: theme.palette.grey[400], mt: 0.5, display: 'block' }}>
              Tags need {ACTIVATION_THRESHOLD} votes to become visible to all users
            </Typography>
          </Box>
        )}
      </Box>
    </Popover>
  );
};

export default CustomTagPopover;