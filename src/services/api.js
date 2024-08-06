// src/services/api.js
// v1.3
// Изменения: заменены теги на авторов

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
            authors: game.attributes.authors?.data?.map(author => ({
                id: author.id,
                name: author.attributes.Name
            })) || []
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
            image: game.attributes.Image?.data?.attributes?.url
                ? `${API_URL}${game.attributes.Image.data.attributes.url}`
                : null,
            authors: game.attributes.authors?.data?.map(author => ({
                id: author.id,
                name: author.attributes.Name
            })) || []
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

export const getAuthors = async () => {
    const response = await axios.get(`${API_URL}/api/authors`);
    return response.data.data;
};

export const createAuthor = async (authorName) => {
    try {
        const response = await axios.post(`${API_URL}/api/authors`, {
            data: {
                Name: authorName
            }
        });
        return response.data.data;
    } catch (error) {
        console.error('Error creating author:', error);
        throw error;
    }
};