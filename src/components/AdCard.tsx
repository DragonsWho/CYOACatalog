// src/components/AdCard.tsx

import React from 'react';
import { Card, Box, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';

// Импортируем константы из GameCard, чтобы стили были консистентными
import { CARD_ASPECT_RATIO, OVERLAY_OPACITY } from './GameCard'; 

interface AdCardProps {
  adId: string;
}

const AdCard: React.FC<AdCardProps> = ({ adId }) => {
  const theme = useTheme();

  return (
    <Card
      sx={{
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: theme.palette.background.paper,
        paddingTop: CARD_ASPECT_RATIO,
        boxShadow: theme.shadows[3],
        height: 0,
      }}
    >
      <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
        
        {/* СЛОЙ 1: Фоновый шум */}
        <Box
          sx={{
            position: 'absolute',
            top: 0, left: 0, width: '100%', height: '100%',
            backgroundImage: theme.custom?.cardNoiseBackground,
            backgroundRepeat: 'repeat',
            backgroundSize: '300px 300px',
            zIndex: 0,
          }}
        />

        {/* СЛОЙ 2: Затемняющий эффект */}
        <Box sx={{
            position: 'absolute',
            top: 0, left: 0, width: '100%', height: '100%',
            backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
            zIndex: 1,
        }} />

        {/* 
          СЛОЙ 3: Контейнер для всего видимого контента (заголовок + рекламный блок).
          Он будет находиться поверх затемнения.
        */}
        <Box sx={{
            position: 'relative',
            zIndex: 2,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column', // Располагаем заголовок и рекламу вертикально
        }}>

            {/* Возвращаем ваш заголовок "Advertisement" */}
            <Typography
              variant="h3"
              component="div"
              align="center"
              sx={{
                pt: 2,
                px: 2,
                fontWeight: 'bold',
                fontSize: { xs: '1.2rem', sm: '1.5rem', md: '1.8rem' },
                color: 'text.secondary',
                flexShrink: 0, // Запрещаем заголовку сжиматься или растягиваться
              }}
            >
              Advertisement
            </Typography>

            {/* 
              Контейнер непосредственно для рекламы.
              Он будет центрировать вставленный блок в оставшемся пространстве.
            */}
            <Box
              id={adId}
              className="in-content-ad"
              sx={{
                flexGrow: 1, // Занимает все оставшееся свободное место
                // Снова используем flexbox для центрирования уже внутри этого блока
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* Сюда рекламный скрипт вставит свой блок. */}
              {/* Flex-стили родителя отцентрируют его. */}
            </Box>

        </Box>
      </Box>
    </Card>
  );
};

export default AdCard;