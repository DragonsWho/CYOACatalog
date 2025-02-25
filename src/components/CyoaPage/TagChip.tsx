import React from 'react';
import { Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote } from '../../pocketbase/pocketbase';
import { PROPOSED_TAG_VOTE_VALUE, LOW_IMPORTANCE_THRESHOLD, HIDDEN_TAG_THRESHOLD } from './TagDisplay';

const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';

interface TagChipProps {
  tag: Tag;
  vote?: GameTagVote;
  isUpdating?: boolean;
  user: any; // Тип для пользователя
  onClick: () => void;
}

export default function TagChip({ tag, vote, isUpdating, user, onClick }: TagChipProps) {
  const theme = useTheme();
  
  const getTagStyle = () => {
    const votes = vote?.votes || 0;
    const isUserVoted = vote?.upVoters?.includes(user?.id || '');
    const isUserDownVoted = vote?.downVoters?.includes(user?.id || '');
    
    let style: React.CSSProperties = {
      height: CHIP_HEIGHT,
      borderRadius: CHIP_BORDER_RADIUS,
      backgroundColor: theme.palette.grey[800],
      color: theme.palette.text.primary,
      cursor: user ? 'pointer' : 'default',
      opacity: isUpdating ? 0.7 : 1,
    };

    // Если пользователь предложил тег или проголосовал за него, показываем как выбранный (зеленый)
    if (isUserVoted || (votes === PROPOSED_TAG_VOTE_VALUE && isUserVoted)) {
      style.color = '#67ad5b';
    } else if (isUserDownVoted) {
      style.color = '#c02c1f';
    }

    // Остальные стили на основе количества голосов (для обычных тегов)
    if (votes >= 50 && votes !== PROPOSED_TAG_VOTE_VALUE) {
      style.boxShadow = '0 0 5px rgba(255, 215, 0, 0.8)';
    } else if (votes >= 20 && votes !== PROPOSED_TAG_VOTE_VALUE) {
      style.fontWeight = 'bold';
    } else if (votes <= LOW_IMPORTANCE_THRESHOLD && votes > HIDDEN_TAG_THRESHOLD && votes !== PROPOSED_TAG_VOTE_VALUE) {
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
    <Chip
      label={tag.name}
      size="small"
      onClick={onClick}
      sx={getTagStyle()}
      disabled={isUpdating}
    />
  );
}