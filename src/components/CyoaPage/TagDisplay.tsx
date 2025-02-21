// src/components/CyoaPage/TagDisplay.tsx
// v2.3
// tag upvotes

import React, { useState, useContext, useEffect } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote, pb, AuthContext, gameTagVotesCollection } from '../../pocketbase/pocketbase';

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
  gameId, // Добавляем ID игры
  chipProps = {},
}: {
  tags: Tag[];
  gameId: string; // Новый пропс
  chipProps?: { size?: 'small' | 'medium'; sx?: React.CSSProperties };
}) {
  const theme = useTheme();
  const { user } = useContext(AuthContext);
  const [tagVotes, setTagVotes] = useState<Record<string, GameTagVote>>({});

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

    const userId = user.id;
    const vote = tagVotes[tag.id] || {
      gameId,
      tagId: tag.id,
      votes: 0,
      upVoters: [],
      downVoters: [],
    };
    let newVote = 0;

    if (vote.upVoters.includes(userId)) newVote = -1; // Был за, станет против
    else if (vote.downVoters.includes(userId)) newVote = 0; // Был против, станет нейтрально
    else newVote = 1; // Нейтрально, станет за

    const updatedVote = { ...vote };
    if (newVote === 1) {
      updatedVote.upVoters = [...(vote.upVoters || []), userId];
      updatedVote.downVoters = (vote.downVoters || []).filter((id) => id !== userId);
    } else if (newVote === -1) {
      updatedVote.downVoters = [...(vote.downVoters || []), userId];
      updatedVote.upVoters = (vote.upVoters || []).filter((id) => id !== userId);
    } else {
      updatedVote.upVoters = (vote.upVoters || []).filter((id) => id !== userId);
      updatedVote.downVoters = (vote.downVoters || []).filter((id) => id !== userId);
    }
    updatedVote.votes = (updatedVote.upVoters || []).length - (updatedVote.downVoters || []).length;

    setTagVotes((prev) => ({
      ...prev,
      [tag.id]: updatedVote,
    }));

    setTimeout(async () => {
      try {
        if (vote.id) {
          await gameTagVotesCollection.update(vote.id, {
            votes: updatedVote.votes,
            upVoters: updatedVote.upVoters,
            downVoters: updatedVote.downVoters,
          });
        } else {
          await gameTagVotesCollection.create({
            gameId,
            tagId: tag.id,
            votes: updatedVote.votes,
            upVoters: updatedVote.upVoters,
            downVoters: updatedVote.downVoters,
          });
        }
      } catch (error) {
        console.error('Ошибка при голосовании:', error);
        setTagVotes((prev) => {
          const newVotes = { ...prev };
          delete newVotes[tag.id];
          return newVotes;
        });
      }
    }, 2000);
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
              />
            );
          })}
        </Box>
      ))}
    </Box>
  );
}