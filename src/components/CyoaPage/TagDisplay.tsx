// src/components/CyoaPage/TagDisplay.tsx
// v3.0
// Упрощенная система голосования с циклическим переключением

import React, { useState, useContext, useEffect } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection } from '../../pocketbase/pocketbase';

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

  useEffect(() => {
    const loadVotes = async () => {
      const votes = await gameTagVotesCollection.getFullList({
        filter: `gameId = "${gameId}"`,
      });
      const voteMap: Record<string, GameTagVote> = {};
      votes.forEach((vote) => {
        voteMap[vote.tagId] = vote;
      });
      setTagVotes(voteMap);
    };
    loadVotes();
  }, [gameId]);

  if (!tags || tags.length === 0) {
    return null;
  }

  const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0].name ?? 'Uncategorized';
    if (!acc[categoryName]) acc[categoryName] = [];
    acc[categoryName].push(tag);
    return acc;
  }, {});

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
    if ((tagVotes[tag.id]?.votes || 0) <= -50) return;
    if (isUpdating[tag.id]) return; // Предотвращаем клик во время обновления
  
    const userId = user.id;
    const currentVote = tagVotes[tag.id];
    
    // Определяем, как пользователь проголосовал (если вообще голосовал)
    let userVoteStatus = 0; // 0 = нейтрально, 1 = за, -1 = против
    if (currentVote) {
      if (currentVote.upVoters?.includes(userId)) {
        userVoteStatus = 1;
      } else if (currentVote.downVoters?.includes(userId)) {
        userVoteStatus = -1;
      }
    }
    
    // Циклическое переключение голоса: 0 -> 1 -> -1 -> 0
    let newUserVoteStatus: number;
    if (userVoteStatus === 0) {
      newUserVoteStatus = 1; // нейтрально -> за
    } else if (userVoteStatus === 1) {
      newUserVoteStatus = -1; // за -> против
    } else {
      newUserVoteStatus = 0; // против -> нейтрально
    }
    
    // Отмечаем что идет обновление
    setIsUpdating(prev => ({
      ...prev,
      [tag.id]: true
    }));
    
    try {
      if (currentVote?.id) {
        if (newUserVoteStatus === 0) {
          // Если новый статус нейтральный и запись существует - удаляем её
          await gameTagVotesCollection.delete(currentVote.id);
          
          // Удаляем из локального состояния
          setTagVotes(prev => {
            const newState = { ...prev };
            delete newState[tag.id];
            return newState;
          });
        } else {
          // Иначе обновляем списки голосующих
          const upVoters = [...(currentVote.upVoters || [])];
          const downVoters = [...(currentVote.downVoters || [])];
          
          // Сначала удаляем пользователя из обоих списков
          const filteredUpVoters = upVoters.filter(id => id !== userId);
          const filteredDownVoters = downVoters.filter(id => id !== userId);
          
          // Затем добавляем в нужный список в зависимости от нового голоса
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
          
          // Обновляем UI сразу
          setTagVotes(prev => ({
            ...prev,
            [tag.id]: newVote
          }));
          
          // Обновляем существующую запись
          await gameTagVotesCollection.update(currentVote.id, {
            votes: newVote.votes,
            upVoters: newVote.upVoters,
            downVoters: newVote.downVoters
          });
        }
      } else if (newUserVoteStatus !== 0) {
        // Создаем новую запись только если голос не нейтральный
        const newVote = {
          gameId,
          tagId: tag.id,
          votes: newUserVoteStatus, // Начальное значение голоса
          upVoters: newUserVoteStatus === 1 ? [userId] : [],
          downVoters: newUserVoteStatus === -1 ? [userId] : []
        } as GameTagVote;
        
        // Обновляем UI сразу
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: newVote
        }));
        
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        // Обновляем ID в локальном состоянии
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: {
            ...prev[tag.id],
            id: createdVote.id
          }
        }));
      }
    } catch (error) {
      console.error('Ошибка при голосовании:', error);
      // В случае ошибки возвращаем предыдущее состояние
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
      // Снимаем флаг обновления
      setTimeout(() => {
        setIsUpdating(prev => ({
          ...prev,
          [tag.id]: false
        }));
      }, 100); // Небольшая задержка для предотвращения случайных двойных кликов
    }
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
      opacity: isUpdating[tag.id] ? 0.7 : 1, // Визуальный индикатор обновления
    };

    if (userVote === 1) style.color = 'green';
    else if (userVote === -1) style.color = 'red';

    if (votes >= 50) style.boxShadow = '0 0 5px rgba(255, 215, 0, 0.8)';
    else if (votes >= 20) style.fontWeight = 'bold';
    else if (votes <= -20) {
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

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => (
        <Box key={category} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: GAP }}>
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
          {groupedTags[category].map((tag) => {
            if ((tagVotes[tag.id]?.votes || 0) <= -50) return null;
            return (
              <Chip
                key={tag.id}
                label={tag.name}
                size="small"
                onClick={() => handleTagClick(tag)}
                sx={getTagStyle(tag)}
                disabled={isUpdating[tag.id]}
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}