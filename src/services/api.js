// src/services/api.js
// v1.7
// Изменения: обновлена функция fetchGameById для включения тегов и их категорий

import axios from 'axios';

const API_URL = 'http://localhost:1337';

export const fetchGames = async (page = 1, pageSize = 12) => {
    try {
        const response = await axios.get(`${API_URL}/api/games`, {
            params: {
                'pagination[page]': page,
                'pagination[pageSize]': pageSize,
                'populate': '*'
            }
        });
        console.log('Raw response:', response.data);

        const games = response.data.data.map(game => ({
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
            })) || [],
            tags: game.attributes.tags?.data || []
        }));

        return {
            games,
            totalCount: response.data.meta.pagination.total
        };
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
            })) || [],
            tags: game.attributes.tags?.data || [],
            img_or_link: game.attributes.img_or_link,
            iframe_url: game.attributes.iframe_url,
            CYOA_pages: game.attributes.CYOA_pages?.data || []
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

export const getTags = async () => {
    try {
        const response = await axios.get(`${API_URL}/api/tags?populate=tag_category`);
        console.log('Tags response:', response.data);
        return response.data.data;
    } catch (error) {
        console.error('Error fetching tags:', error);
        throw error;
    }
};

export const getTagCategories = async () => {
    try {
        const response = await axios.get(`${API_URL}/api/tag-categories?populate=tags`);
        console.log('Tag categories response:', response.data);
        return response.data.data;
    } catch (error) {
        console.error('Error fetching tag categories:', error);
        throw error;
    }
};