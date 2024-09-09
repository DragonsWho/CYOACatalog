// src/components/GameList.tsx
// v2.8
// Converted to TypeScript and reduced space between header and "Recent Uploads" title

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Typography, Box, Grid2, useTheme } from '@mui/material';
import GameCard from './GameCard';
import { Game, gamesCollection } from '../pocketbase/pocketbase';

const ITEMS_PER_PAGE = 25; // 5 cards per row, 5 rows

export default function GameList() {
  const theme = useTheme();
  const [gamePages, setGamePages] = useState<Game[][]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          setPage((prevPage) => prevPage + 1);
        }
      });
      if (node) observer.current.observe(node);
    },
    [loading, hasMore],
  );

  useEffect(() => {
    (async () => {
      if (!hasMore || loading || gamePages[page]) return;

      setLoading(true);
      const fetchedGames = await gamesCollection.getList(page + 1, ITEMS_PER_PAGE, {
        sort: '-created',
        expand: 'tags.tag_categories_via_tags,authors_via_games',
      });

      setGamePages((oldPages) => {
        const newPages = [...oldPages];
        newPages[page] = fetchedGames.items;
        return newPages;
      });

      setHasMore(fetchedGames.totalPages > page + 1);
      setLoading(false);
    })();
  }, [page, hasMore, loading, gamePages]);

  const games = useMemo(() => gamePages.flat(), [gamePages]);

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography
        variant="h3"
        sx={{
          mt: -4,
          mb: 2,
          textAlign: 'center',
          // @ts-expect-error custom theme property
          ...theme.custom.cardTitle,
        }}
      >
        Recent uploads
      </Typography>
      <Grid2 container spacing={2} justifyContent="center">
        {games.map((game, index) => (
          <Grid2
            size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
            key={game.id}
            ref={games.length === index + 1 ? lastGameElementRef : null}
          >
            <GameCard game={game} />
          </Grid2>
        ))}
      </Grid2>
      {loading && <Typography sx={{ mt: 2, textAlign: 'center' }}>Loading more games...</Typography>}
      {!loading && !hasMore && <Typography sx={{ mt: 2, textAlign: 'center' }}>No more games to load</Typography>}
    </Box>
  );
}
