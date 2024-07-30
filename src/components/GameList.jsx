import React, { useState, useEffect } from 'react';
import { Grid, Typography, Box } from '@mui/material';
import GameCard from './GameCard';
import { fetchGames } from '../services/api';

function GameList() {
    const [games, setGames] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const loadGames = async () => {
            try {
                const fetchedGames = await fetchGames();
                console.log('Fetched games:', fetchedGames); // Добавим логирование
                setGames(fetchedGames);
            } catch (error) {
                console.error('Error fetching games:', error);
                setError('Failed to load games. Please try again later.');
            } finally {
                setLoading(false);
            }
        };
        loadGames();
    }, []);

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
        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
            <Grid container spacing={3} maxWidth="xl">
                {games.map((game) => (
                    <Grid item xs={12} sm={6} md={4} lg={3} key={game.id}>
                        <GameCard game={game} />
                    </Grid>
                ))}
            </Grid>
        </Box>
    );
}

export default GameList;