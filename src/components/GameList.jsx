// src/components/GameList.jsx
// v2.7
// Changes: Reduced space between header and "Recent Uploads" title, added comment for manual adjustment

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Typography, Box, Grid, useTheme } from '@mui/material';
import GameCard from './GameCard';
import { fetchGames, getTagCategories } from '../services/api';

const ITEMS_PER_PAGE = 25; // 5 cards per row, 5 rows

function GameList() {
    const theme = useTheme();
    const [games, setGames] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [page, setPage] = useState(1);
    const [hasMore, setHasMore] = useState(true);
    const [totalCount, setTotalCount] = useState(0);
    const [tagCategories, setTagCategories] = useState([]);

    const observer = useRef();
    const lastGameElementRef = useCallback(node => {
        if (loading) return;
        if (observer.current) observer.current.disconnect();
        observer.current = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting && hasMore) {
                setPage(prevPage => prevPage + 1);
            }
        });
        if (node) observer.current.observe(node);
    }, [loading, hasMore]);

    useEffect(() => {
        const fetchTagCategories = async () => {
            try {
                const categories = await getTagCategories();
                setTagCategories(categories);
            } catch (error) {
                console.error('Error fetching tag categories:', error);
            }
        };

        fetchTagCategories();
    }, []);

    useEffect(() => {
        const loadGames = async () => {
            if (!hasMore || loading) return;

            try {
                setLoading(true);
                const { games: fetchedGames, totalCount: fetchedTotalCount } = await fetchGames(page, ITEMS_PER_PAGE);

                setGames(prevGames => {
                    const newGames = fetchedGames.filter(
                        newGame => !prevGames.some(existingGame => existingGame.id === newGame.id)
                    );
                    return [...prevGames, ...newGames];
                });

                setTotalCount(fetchedTotalCount);
                setHasMore(games.length + fetchedGames.length < fetchedTotalCount);
            } catch (error) {
                console.error('Error fetching games:', error);
                setError('Failed to load games. Please try again later.');
            } finally {
                setLoading(false);
            }
        };

        loadGames();
    }, [page, hasMore]);

    if (error) {
        return <Typography color="error">{error}</Typography>;
    }

    return (
        <Box sx={{ width: '100%', p: 3 }}>
            <Typography
                variant="h3"
                sx={{ 
                    mt: -4,  
                    mb: 2,
                    textAlign: 'center',
                    ...theme.custom.cardTitle,
                }}
            >
                Recent uploads
            </Typography>
            <Grid container spacing={2} justifyContent="center">
                {games.map((game, index) => (
                    <Grid item xs={12} sm={6} md={4} lg={2.4} key={game.id} ref={games.length === index + 1 ? lastGameElementRef : null}>
                        <GameCard game={game} tagCategories={tagCategories} />
                    </Grid>
                ))}
            </Grid>
            {loading && <Typography sx={{ mt: 2, textAlign: 'center' }}>Loading more games...</Typography>}
            {!loading && !hasMore && <Typography sx={{ mt: 2, textAlign: 'center' }}>No more games to load</Typography>}
        </Box>
    );
}

export default GameList;