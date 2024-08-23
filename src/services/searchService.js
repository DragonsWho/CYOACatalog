// src/services/searchService.js
// v 1.8

import { getFromCache, saveToCache } from './cacheService';

const API_URL = process.env.REACT_APP_API_URL || 'https://cyoa.cafe';

export const fetchAllGames = async () => {
    const cachedGames = getFromCache();
    if (cachedGames) {
        return cachedGames;
    }

    try {
        const response = await fetch(`${API_URL}/games`);
        if (!response.ok) {
            throw new Error('Failed to fetch games');
        }
        const data = await response.json();
        saveToCache(data.data);
        return data.data;
    } catch (error) {
        console.error('Error fetching games:', error);
        throw error;
    }
};

export const searchGames = async (query) => {
    const allGames = await fetchAllGames();
    return allGames.filter(game =>
        game.attributes.Title.toLowerCase().includes(query.toLowerCase())
    );
};