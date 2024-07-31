// src/services/searchService.js
// v 1.5

import { fetchGames } from './api';

export const searchGames = async (query) => {
    try {
        const games = await fetchGames();

        if (!Array.isArray(games)) {
            console.error('Unexpected API response structure:', games);
            return [];
        }

        const filteredGames = games.filter(game =>
            game &&
            game.title &&
            typeof game.title === 'string' &&
            game.title.toLowerCase().includes(query.toLowerCase())
        );

        return filteredGames.slice(0, 5).map(game => ({
            id: game.id,
            attributes: {
                Title: game.title,
                Description: game.description,
                Image: game.image,
                tags: game.tags
            }
        }));
    } catch (error) {
        console.error('Error searching games:', error);
        return [];
    }
};