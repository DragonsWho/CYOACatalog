// src/services/searchService.js
// v 1.10
// Changes: Simplified to fetch all games once and perform filtering in memory

import { getFromCache, saveToCache } from './cacheService'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.cyoa.cafe'

let allGames = null

export const fetchAllGames = async () => {
    if (allGames) {
        return allGames
    }

    const cachedGames = getFromCache()
    if (cachedGames) {
        allGames = cachedGames
        return allGames
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
        allGames = data.data
        saveToCache(allGames)
        return allGames
    } catch (error) {
        console.error('Error fetching games:', error)
        throw error
    }
}

export const searchGames = async (query) => {
    try {
        if (!allGames) {
            await fetchAllGames()
        }
        if (query === '') {
            return allGames
        }
        return allGames.filter(game =>
            game.attributes.Title.toLowerCase().includes(query.toLowerCase())
        )
    } catch (error) {
        console.error('Error in searchGames:', error)
        throw error
    }
}