import React, { useMemo } from 'react';
import { Grid2, useMediaQuery, useTheme } from '@mui/material';
import GameCard from '../GameCard';
import { Game } from '../../pocketbase/pocketbase';
import { useLocalizedGames } from '../../utils/useLocalizedGames';

interface GameGridProps {
  games: Game[];
  scores?: Map<string, number>;
  lastElementRef?: (node: HTMLElement | null) => void;
}

const GameGrid: React.FC<GameGridProps> = ({ games, scores, lastElementRef }) => {
  // Swap title/description for the user's language (if game_variants{pref} exists).
  const localizedGames = useLocalizedGames(games);
  // Dedupe by id, not index in the key: pagination could return a game twice (sort shift between
  // pages); index keys kept the duplicate on screen and remounted the whole grid on every re-sort.
  // Now the duplicate is dropped and keys are stable.
  const memoizedGames = useMemo(() => {
    const seen = new Set<string>();
    return localizedGames.filter((g) => !seen.has(g.id) && seen.add(g.id));
  }, [localizedGames]);

  // Cards per row at the current breakpoint (size={{ xs:12, sm:6, md:4, lg:2.4 }}). noSsr:
  // matchMedia computed immediately on mount, no extra render with the default.
  const theme = useTheme();
  const isLg = useMediaQuery(theme.breakpoints.up('lg'), { noSsr: true });
  const isMd = useMediaQuery(theme.breakpoints.up('md'), { noSsr: true });
  const isSm = useMediaQuery(theme.breakpoints.up('sm'), { noSsr: true });
  const columns = isLg ? 5 : isMd ? 3 : isSm ? 2 : 1;
  // First 3 rows = first screen: no lazy. First row is LCP → fetchpriority=high.
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
            // Shared sizing for all modes; lg={2.4} = 5 per row (12 / 2.4).
            size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
            key={game.id}
            ref={isLast && lastElementRef ? lastElementRef : null}
          >
            <GameCard
              game={game}
              variant="standard"
              relevanceScore={scores?.get(game.id)}
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