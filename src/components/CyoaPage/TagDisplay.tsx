import React, { useState, useContext, useEffect } from 'react';
import { Box, Chip, Typography, IconButton } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, gamesCollection } from '../../pocketbase/pocketbase';
import AddTagPopover from './AddTagPopover';

// Constants remain the same
const CATEGORY_ORDER = [
  'Rating',
  'Interactivity',
  'POV',
  'Player Sexual Role',
  'Playtime',
  'Status',
  'Genre',
  'Setting',
  'Tone',
  'Extra',
  'Narrative Structure',
  'Power Level',
  'Visual Style',
  'Language',
  'Kinks',
];

const PROPOSED_TAG_VOTE_VALUE = -1000;
const ACTIVATION_THRESHOLD = 5;
const INITIAL_ACTIVE_VOTE = -30;
const HIDDEN_TAG_THRESHOLD = -50;
const LOW_IMPORTANCE_THRESHOLD = -20;

const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';
const GAP = 0.75;
const CATEGORY_FONT_WEIGHT = '500';
const SECTION_GAP = 0.5;

export default function TagDisplay({
  tags,
  gameId,
}: {
  tags: Tag[];
  gameId: string;
}) {
  const theme = useTheme();
  const { user } = useContext(AuthContext);
  const [tagVotes, setTagVotes] = useState<Record<string, GameTagVote>>({});
  const [isUpdating, setIsUpdating] = useState<Record<string, boolean>>({});
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [currentCategory, setCurrentCategory] = useState<string>('');
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [categoryTags, setCategoryTags] = useState<Record<string, Tag[]>>({});
  // Add a new state to track selected tags that need to be displayed
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);

  useEffect(() => {
    const loadVotes = async () => {
      const votes = await gameTagVotesCollection.getFullList({
        filter: `gameId = "${gameId}"`,
      });
      
      const voteMap: Record<string, GameTagVote> = {};
      votes.forEach((vote) => {
        voteMap[vote.tagId] = vote;
        
        if (vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters && vote.upVoters.length >= ACTIVATION_THRESHOLD) {
          activateProposedTag(vote);
        }
      });
      setTagVotes(voteMap);
    };
    loadVotes();
  }, [gameId]);

  const activateProposedTag = async (vote: GameTagVote) => {
    if (!vote.id) return;
    
    try {
      // Обновляем запись голосования
      const updatedVote = {
        ...vote,
        votes: INITIAL_ACTIVE_VOTE,
      };
      
      await gameTagVotesCollection.update(vote.id, {
        votes: INITIAL_ACTIVE_VOTE,
      });
      
      // Добавляем тег в список тегов игры
      const game = await gamesCollection.getOne(vote.gameId);
      const tagIds = [...new Set([...game.tags, vote.tagId])];
      
      await gamesCollection.update(vote.gameId, {
        tags: tagIds
      });
      
      setTagVotes(prev => ({
        ...prev,
        [vote.tagId]: updatedVote
      }));
    } catch (error) {
      console.error('Ошибка при активации тега:', error);
    }
  };

  useEffect(() => {
    const loadCategoryTags = async () => {
      const categories = await tagCategoriesCollection.getFullList({
        expand: 'tags',
      });
      
      const catTags: Record<string, Tag[]> = {};
      categories.forEach((category) => {
        if (category.expand?.tags) {
          catTags[category.name] = category.expand.tags;
        }
      });
      
      setCategoryTags(catTags);
    };
    loadCategoryTags();
  }, []);

  if (!tags || tags.length === 0) {
    return null;
  }

  // Group tags by categories
  const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0].name ?? 'Uncategorized';
    if (!acc[categoryName]) acc[categoryName] = [];
    acc[categoryName].push(tag);
    return acc;
  }, {});

  // Add the selected tags to their respective categories
  selectedTags.forEach(tag => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0].name ?? 'Uncategorized';
    if (!groupedTags[categoryName]) groupedTags[categoryName] = [];
    // Check if the tag is already in the group before adding
    if (!groupedTags[categoryName].some(t => t.id === tag.id)) {
      groupedTags[categoryName].push(tag);
    }
  });

  // Sort categories
  const sortedCategories = Object.keys(groupedTags).sort((a, b) => {
    const indexA = CATEGORY_ORDER.indexOf(a);
    const indexB = CATEGORY_ORDER.indexOf(b);
    if (indexA === -1 && indexB === -1) return 0;
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  const handleTagClick = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;
  
    const userId = user.id;
    const currentVote = tagVotes[tag.id];
    
    if (currentVote && currentVote.votes === PROPOSED_TAG_VOTE_VALUE) {
      return;
    }
    
    if ((currentVote?.votes || 0) <= HIDDEN_TAG_THRESHOLD && currentVote?.votes !== PROPOSED_TAG_VOTE_VALUE) return;
    
    let userVoteStatus = 0;
    if (currentVote) {
      if (currentVote.upVoters?.includes(userId)) {
        userVoteStatus = 1;
      } else if (currentVote.downVoters?.includes(userId)) {
        userVoteStatus = -1;
      }
    }
    
    let newUserVoteStatus: number;
    if (userVoteStatus === 0) {
      newUserVoteStatus = 1;
    } else if (userVoteStatus === 1) {
      newUserVoteStatus = -1;
    } else {
      newUserVoteStatus = 0;
    }
    
    setIsUpdating(prev => ({
      ...prev,
      [tag.id]: true
    }));
    
    try {
      if (currentVote?.id) {
        if (newUserVoteStatus === 0) {
          await gameTagVotesCollection.delete(currentVote.id);
          setTagVotes(prev => {
            const newState = { ...prev };
            delete newState[tag.id];
            return newState;
          });
        } else {
          const upVoters = [...(currentVote.upVoters || [])];
          const downVoters = [...(currentVote.downVoters || [])];
          const filteredUpVoters = upVoters.filter(id => id !== userId);
          const filteredDownVoters = downVoters.filter(id => id !== userId);
          
          if (newUserVoteStatus === 1) {
            filteredUpVoters.push(userId);
          } else if (newUserVoteStatus === -1) {
            filteredDownVoters.push(userId);
          }
          
          const newVote = {
            ...currentVote,
            votes: filteredUpVoters.length - filteredDownVoters.length,
            upVoters: filteredUpVoters,
            downVoters: filteredDownVoters
          };
          
          setTagVotes(prev => ({
            ...prev,
            [tag.id]: newVote
          }));
          
          await gameTagVotesCollection.update(currentVote.id, {
            votes: newVote.votes,
            upVoters: newVote.upVoters,
            downVoters: newVote.downVoters
          });
        }
      } else if (newUserVoteStatus !== 0) {
        // Use Partial<GameTagVote> to fix the TypeScript error
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tag.id,
          votes: newUserVoteStatus,
          upVoters: newUserVoteStatus === 1 ? [userId] : [],
          downVoters: newUserVoteStatus === -1 ? [userId] : []
        };
        
        // Create the vote and get the created record with id
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        // Update the state with the complete vote record
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: createdVote as GameTagVote
        }));
      }
    } catch (error) {
      console.error('Ошибка при голосовании:', error);
      setTagVotes(prev => {
        const newState = { ...prev };
        if (currentVote) {
          newState[tag.id] = currentVote;
        } else {
          delete newState[tag.id];
        }
        return newState;
      });
    } finally {
      setTimeout(() => {
        setIsUpdating(prev => ({
          ...prev,
          [tag.id]: false
        }));
      }, 100);
    }
  };

  const handleAddTagClick = (event: React.MouseEvent<HTMLElement>, category: string) => {
    setAnchorEl(event.currentTarget);
    setCurrentCategory(category);
    
    // Filter available tags for the category
    const existingTagIds = tags.map(tag => tag.id);
    const selectedTagIds = selectedTags.map(tag => tag.id);
    const existingProposedTagIds = Object.keys(tagVotes).filter(tagId => 
      tagVotes[tagId].votes === PROPOSED_TAG_VOTE_VALUE && 
      tagVotes[tagId].upVoters?.includes(user?.id || ''));
    
    const allExistingIds = [...existingTagIds, ...existingProposedTagIds, ...selectedTagIds];
    
    const availableCategoryTags = categoryTags[category]?.filter(
      tag => !allExistingIds.includes(tag.id)
    ) || [];
    
    setAvailableTags(availableCategoryTags);
  };

  const handleClosePopover = () => {
    setAnchorEl(null);
  };

  const handleTagSelect = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;
    
    setIsUpdating(prev => ({
      ...prev,
      [tag.id]: true
    }));
    
    try {
      // Сначала проверяем, существует ли уже запись для этого тега в игре
      let existingVote: GameTagVote | null = null;
      
      try {
        // Пытаемся найти существующую запись для этого тега
        existingVote = await gameTagVotesCollection.getFirstListItem(`gameId="${gameId}" && tagId="${tag.id}"`);
      } catch (error) {
        // Если запись не найдена, existingVote останется null
        console.log('No existing vote found for this tag');
      }
      
      if (existingVote) {
        // Если запись существует, добавляем пользователя в upVoters
        const upVoters = [...(existingVote.upVoters || [])];
        
        // Добавляем пользователя в upVoters только если его там еще нет
        if (!upVoters.includes(user.id)) {
          upVoters.push(user.id);
        }
        
        // Обновляем запись
        const updatedVote = await gameTagVotesCollection.update(existingVote.id, {
          upVoters: upVoters,
          // Не меняем votes, оно должно оставаться PROPOSED_TAG_VOTE_VALUE
        });
        
        // Проверяем, достигли ли мы порога для активации тега
        if (upVoters.length >= ACTIVATION_THRESHOLD) {
          await activateProposedTag(updatedVote);
        }
        
        // Обновляем локальное состояние
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: updatedVote
        }));
      } else {
        // Если записи нет, создаем новую
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tag.id,
          votes: PROPOSED_TAG_VOTE_VALUE,
          upVoters: [user.id],
          downVoters: []
        };
        
        // Создаем запись в базе данных
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        // Обновляем состояние
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: createdVote as GameTagVote
        }));
      }
      
      // Добавляем тег в selectedTags для отображения
      setSelectedTags(prev => {
        // Добавляем тег только если его еще нет в списке
        if (!prev.some(t => t.id === tag.id)) {
          return [...prev, tag];
        }
        return prev;
      });
      
    } catch (error) {
      console.error('Ошибка при добавлении тега:', error);
    } finally {
      setIsUpdating(prev => ({
        ...prev,
        [tag.id]: false
      }));
    }
    
    handleClosePopover();
  };

  const getTagStyle = (tag: Tag) => {
    const vote = tagVotes[tag.id] || { votes: 0, upVoters: [], downVoters: [] };
    const votes = vote.votes || 0;
    const userVote = vote.upVoters?.includes(user?.id || '') ? 1 : vote.downVoters?.includes(user?.id || '') ? -1 : 0;
    
    let style: React.CSSProperties = {
      height: CHIP_HEIGHT,
      borderRadius: CHIP_BORDER_RADIUS,
      backgroundColor: theme.palette.grey[800],
      color: theme.palette.text.primary,
      cursor: user ? 'pointer' : 'default',
      opacity: isUpdating[tag.id] ? 0.7 : 1,
    };

    if (votes === PROPOSED_TAG_VOTE_VALUE) {
      style.backgroundColor = theme.palette.info.dark;
      style.borderStyle = 'dashed';
      style.borderColor = theme.palette.info.light;
    }
    else if (userVote === 1) style.color = 'green';
    else if (userVote === -1) style.color = 'red';

    if (votes >= 50) style.boxShadow = '0 0 5px rgba(255, 215, 0, 0.8)';
    else if (votes >= 20) style.fontWeight = 'bold';
    else if (votes <= LOW_IMPORTANCE_THRESHOLD && votes > HIDDEN_TAG_THRESHOLD) {
      style.fontSize = '0.7em';
      style.opacity = 0.7;
    }

    return {
      ...style,
      '& .MuiChip-label': {
        fontSize: CHIP_FONT_SIZE,
        padding: CHIP_PADDING,
      },
      '&:hover': {
        backgroundColor: theme.palette.grey[700],
      },
    };
  };

  const popoverOpen = Boolean(anchorEl);

  const shouldShowTag = (tag: Tag) => {
    const vote = tagVotes[tag.id];
    
    // For proposed tags, always show to the proposer
    if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
      return user && vote.upVoters?.includes(user.id);
    }
    
    // If tag is in selectedTags, always show it to the current user
    if (selectedTags.some(t => t.id === tag.id) && user) {
      return true;
    }
    
    // Hide tags below threshold
    if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD) {
      return false;
    }
    
    return true;
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const visibleTags = groupedTags[category].filter(tag => shouldShowTag(tag));
        
        if (visibleTags.length === 0) return null;
        
        return (
          <Box key={category} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP }}>
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
                  onClick={(e) => handleAddTagClick(e, category)}
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
            
            {visibleTags.map((tag) => {
              const vote = tagVotes[tag.id];
              
              return (
                <Chip
                  key={tag.id}
                  label={vote?.votes === PROPOSED_TAG_VOTE_VALUE ? `${tag.name} (предложен)` : tag.name}
                  size="small"
                  onClick={() => handleTagClick(tag)}
                  sx={getTagStyle(tag)}
                  disabled={isUpdating[tag.id]}
                />
              );
            })}
          </Box>
        );
      })}

      <AddTagPopover 
        open={popoverOpen}
        anchorEl={anchorEl}
        currentCategory={currentCategory}
        availableTags={availableTags}
        onClose={handleClosePopover}
        onTagSelect={handleTagSelect}
        isUpdating={isUpdating}
      />
    </Box>
  );
}