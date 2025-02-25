import React from 'react';
import { Chip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote } from '../../pocketbase/pocketbase';
import { PROPOSED_TAG_VOTE_VALUE, HIDDEN_TAG_THRESHOLD } from './TagDisplay';

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
  
  // Добавим лог для диагностики
  console.log(`Tag ${tag.name}, votes: ${vote?.votes}, user: ${user ? 'logged in' : 'not logged in'}`);
  
  const getTagStyle = () => {
    // Проверяем, есть ли данные о голосах
    const votes = vote?.votes || 0;
    
    // Определяем голосование пользователя только если пользователь авторизован
    const isUserVoted = user ? vote?.upVoters?.includes(user.id || '') : false;
    const isUserDownVoted = user ? vote?.downVoters?.includes(user.id || '') : false;
    
    let style: React.CSSProperties = {
      height: CHIP_HEIGHT,
      borderRadius: CHIP_BORDER_RADIUS,
      backgroundColor: theme.palette.grey[800],
      color: theme.palette.text.primary,
      cursor: user ? 'pointer' : 'default',
      opacity: isUpdating ? 0.7 : 1,
    };

    // Применяем стили на основе голосов для всех пользователей
    if (votes >= 50 && votes !== PROPOSED_TAG_VOTE_VALUE) {
      style.fontWeight = 'bold';
      style.fontSize = '0.875rem';
      style.letterSpacing = '0.02em';
      style.color = '#ffec85'; // Золотой цвет текста
      style.backgroundColor = 'rgba(72, 72, 72, 1)';
    } else if (votes >= 1 && votes !== PROPOSED_TAG_VOTE_VALUE) {
      style.fontWeight = 'bold';
      style.color = '#ffffff'; // Делаем более заметным
    } else if (votes <= -1 && votes > HIDDEN_TAG_THRESHOLD && votes !== PROPOSED_TAG_VOTE_VALUE) {
      style.opacity = 0.7;
      style.color = theme.palette.text.secondary; // Приглушенный цвет
    }

    // Личные стили для авторизованных пользователей (переопределяем предыдущие стили)
    if (user) {
      if (isUserVoted || (votes === PROPOSED_TAG_VOTE_VALUE && isUserVoted)) {
        style.color = '#67ad5b';
      } else if (isUserDownVoted) {
        style.color = '#c02c1f';
      }
    }

    return {
      ...style,
      '& .MuiChip-label': {
        fontSize: CHIP_FONT_SIZE,
        padding: CHIP_PADDING,
      },
      '&:hover': {
        backgroundColor: user ? theme.palette.grey[700] : theme.palette.grey[800],
        boxShadow: user ? '0 1px 3px rgba(0, 0, 0, 0.2)' : undefined,
      },
    };
  };

  // Применяем стили независимо от состояния пользователя
  const styles = getTagStyle();

  return (
    <Chip
      label={tag.name}
      size="small"
      onClick={user ? onClick : undefined}
      sx={styles}
      disabled={isUpdating}
    />
  );
}