// src/services/api.jsx
// v1.2

import axios from 'axios';

const API_URL = 'http://localhost:1337';

export const fetchGames = async () => {
    try {
        const response = await axios.get(`${API_URL}/api/games?populate=*`);
        console.log('Raw response:', response.data);
        return response.data.data.map(game => ({
            id: game.id,
            title: game.attributes.Title,
            description: Array.isArray(game.attributes.Description)
                ? game.attributes.Description[0]
                : game.attributes.Description,
            image: game.attributes.Image?.data?.attributes?.url
                ? `${API_URL}${game.attributes.Image.data.attributes.url}`
                : null,
            tags: game.attributes.tags?.data?.map(tag => tag.attributes.Name) || []
        }));
    } catch (error) {
        console.error('Error fetching games:', error);
        throw error;
    }
};

export const fetchGameById = async (id) => {
    try {
        const response = await axios.get(`${API_URL}/api/games/${id}?populate=*`);
        const game = response.data.data;
        return {
            id: game.id,
            title: game.attributes.Title,
            description: game.attributes.Description,
            image: `${API_URL}${game.attributes.Image.data.attributes.url}`,
            tags: game.attributes.tags.data.map(tag => tag.attributes.Name)
        };
    } catch (error) {
        console.error('Error fetching game:', error);
        throw error;
    }
};
 



export const createGame = async (formData) => {
    try {
        const response = await axios.post(`${API_URL}/api/games`, formData, {
            headers: {
                'Content-Type': 'multipart/form-data',
            }
        });

        console.log('API response:', response.data);
        return response.data;
    } catch (error) {
        console.error('API error:', error.response ? error.response.data : error);
        throw error;
    }
};

export const getTags = async () => {
    const response = await axios.get(`${API_URL}/api/tags`);
    return response.data.data;
};