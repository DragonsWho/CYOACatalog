// src/components/Search/GameGrid.tsx
import React, { useMemo } from 'react';
import { Grid2, useMediaQuery, useTheme } from '@mui/material'; // Используем Grid2 (MUI v6) как в SemanticSearch
import GameCard from '../GameCard';
import { Game } from '../../pocketbase/pocketbase';
import { useLocalizedGames } from '../../utils/useLocalizedGames';

interface GameGridProps {
  games: Game[];
  scores?: Map<string, number>; // Опционально для семантического поиска
  lastElementRef?: (node: HTMLElement | null) => void; // Для бесконечного скролла
}

const GameGrid: React.FC<GameGridProps> = ({ games, scores, lastElementRef }) => {
  // Подмена title/description на язык пользователя (если есть game_variants{pref}).
  const localizedGames = useLocalizedGames(games);
  const memoizedGames = useMemo(() => localizedGames, [localizedGames]);

  // Сколько карточек в ряду при текущем брейкпоинте (size={{ xs:12, sm:6, md:4, lg:2.4 }}).
  // noSsr: matchMedia вычисляется сразу на маунте, без лишнего перерендера с дефолтом.
  const theme = useTheme();
  const isLg = useMediaQuery(theme.breakpoints.up('lg'), { noSsr: true });
  const isMd = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const isSm = useMediaQuery(theme.breakpoints.up('sm'), { noSsr: true });
  const columns = isLg ? 5 : isMd ? 3 : isSm ? 2 : 1;
  // Первые 3 ряда — первый экран: грузим без lazy. Первый ряд — LCP → fetchpriority=high.
  const eagerCount = columns * 3;
  const highCount = columns;

  return (
    <Grid2 
      container 
      spacing={{ xs: 1, sm: 2 }} 
      justifyContent="center"
      sx={{ width: '100%' }}
    >
      {memoizedGames.map((game, index) => {
        const isLast = index === memoizedGames.length - 1;
        
        return (
          <Grid2
            // ЕДИНАЯ НАСТРОЙКА РАЗМЕРОВ ДЛЯ ВСЕХ РЕЖИМОВ
            // lg={2.4} означает 5 карточек в ряд (12 / 2.4 = 5)
            size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
            key={`${game.id}-${index}`} // Добавил index для уникальности при пагинации
            ref={isLast && lastElementRef ? lastElementRef : null}
          >
            <GameCard
              game={game}
              variant="standard"
              relevanceScore={scores?.get(game.id)}
              // Первый ряд → fetchpriority=high (LCP); первые 3 ряда → без lazy.
              priority={index < highCount}
              eager={index < eagerCount}
            />
          </Grid2>
        );
      })}
    </Grid2>
  );
};

export default React.memo(GameGrid);