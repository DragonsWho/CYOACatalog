// src/components/GameList.jsx
// Version 1.1
// Изменения: добавлена пагинация

import React, { useState, useEffect } from 'react';
import { Grid, Typography, Box, Pagination } from '@mui/material';
import GameCard from './GameCard';
import { fetchGames } from '../services/api';

function GameList() {
    const [games, setGames] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [page, setPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const gamesPerPage = 12; // Количество игр на странице

    useEffect(() => {
        const loadGames = async () => {
            try {
                setLoading(true);
                const { games: fetchedGames, totalCount } = await fetchGames(page, gamesPerPage);
                console.log('Fetched games:', fetchedGames);
                setGames(fetchedGames);
                setTotalPages(Math.ceil(totalCount / gamesPerPage));
            } catch (error) {
                console.error('Error fetching games:', error);
                setError('Failed to load games. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        loadGames();
    }, [page]);

    const handlePageChange = (event, value) => {
        setPage(value);
    };

    if (loading) {
        return (
            <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
                <Typography>Loading...</Typography>
            </Box>
        );
    }

    if (error) {
        return (
            <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
                <Typography color="error">{error}</Typography>
            </Box>
        );
    }

    if (games.length === 0) {
        return (
            <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '200px' }}>
                <Typography>No games found.</Typography>
            </Box>
        );
    }

    return (
        <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <Grid container spacing={3} maxWidth="xl">
                {games.map((game) => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={game.id}>
                        <GameCard game={game} />
                    </Grid>
                ))}
            </Grid>
            <Box sx={{ mt: 4, mb: 4 }}>
                <Pagination
                    count={totalPages}
                    page={page}
                    onChange={handlePageChange}
                    color="primary"
                />
            </Box>
        </Box>
    );
}

export default GameList;