// src/components/AdCard.tsx

import React from 'react';
import { Card, Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

// Мы импортируем константы прямо из вашего файла GameCard, чтобы стили совпадали 1 в 1.
// Для этого их нужно экспортировать из GameCard.tsx.
// Пример: export const CARD_ASPECT_RATIO = '133.33%';
import { CARD_ASPECT_RATIO } from './GameCard'; 

interface AdCardProps {
  adId: string; // Уникальный ID для этого рекламного блока, например "ad-container-9"
}

const AdCard: React.FC<AdCardProps> = ({ adId }) => {
  const theme = useTheme();

  return (
    // Мы используем те же самые стили для Card, что и в GameCard, чтобы не сломать сетку
    <Card
      sx={{
        // Копируем основные стили контейнера из GameCard.tsx
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.palette.background.paper,
        paddingTop: CARD_ASPECT_RATIO, // Ключевой стиль для сохранения пропорций
        boxShadow: theme.shadows[3],
        height: 0,
      }}
    >
      {/* Это и есть тот самый контейнер, который найдет рекламный скрипт */}
      <Box
        id={adId} // Используем уникальный ID, переданный через props
        className="in-content-ad" // Добавим и общий класс для удобства
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Добавим фоновый шум, как у вас на карточках без картинки
          backgroundImage: theme.custom?.cardNoiseBackground,
          backgroundRepeat: 'repeat',
          backgroundSize: '300px 300px',
        }}
      >
        {/* Можно добавить заглушку, пока реклама грузится */}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Advertisement
        </Typography>
      </Box>
    </Card>
  );
};

export default AdCard;