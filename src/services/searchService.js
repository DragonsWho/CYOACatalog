// src/services/searchService.js
// v 1.9
// Changes: Added error handling, logging, and API URL fallback

import { getFromCache, saveToCache } from './cacheService'

const API_URL = process.env.REACT_APP_API_URL || 'https://api.cyoa.cafe'

export const fetchAllGames = async () => {
    const cachedGames = getFromCache()
    if (cachedGames) {
        return cachedGames
    }

    try {
        console.log('Fetching games from API:', `${API_URL}/api/games`)
        const response = await fetch(`${API_URL}/api/games`)
        if (!response.ok) {
            const errorText = await response.text()
            console.error('API response not OK:', response.status, errorText)
            throw new Error(`Failed to fetch games: ${response.status} ${errorText}`)
        }
        const data = await response.json()
        console.log('Received data from API:', data)
        if (!data.data) {
            console.error('Unexpected API response structure:', data)
            throw new Error('Unexpected API response structure')
        }
        saveToCache(data.data)
        return data.data
    } catch (error) {
        console.error('Error fetching games:', error)
        throw error
    }
}

export const searchGames = async (query) => {
    try {
        const allGames = await fetchAllGames()
        return allGames.filter(game =>
            game.attributes.Title.toLowerCase().includes(query.toLowerCase())
        )
    } catch (error) {
        console.error('Error in searchGames:', error)
        throw error
    }
}