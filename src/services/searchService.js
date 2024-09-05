// src/services/searchService.js
// v 2.0
// Changes: Implemented pagination to fetch all games, improved error handling and logging

import { getFromCache, saveToCache } from './cacheService'

const API_URL = import.meta.env.VITE_API_URL || 'https://api.cyoa.cafe'
const PAGE_SIZE = 100 // Adjust this value based on your API's capabilities

export const fetchAllGames = async () => {
    const cachedGames = getFromCache()
    if (cachedGames) {
        return cachedGames
    }

    try {
        let allGames = []
        let page = 1
        let hasMore = true

        while (hasMore) {
            console.log(`Fetching games from API: ${API_URL}/api/games?pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`)
            const response = await fetch(`${API_URL}/api/games?pagination[page]=${page}&pagination[pageSize]=${PAGE_SIZE}`)
            
            if (!response.ok) {
                const errorText = await response.text()
                console.error('API response not OK:', response.status, errorText)
                throw new Error(`Failed to fetch games: ${response.status} ${errorText}`)
            }

            const data = await response.json()
            console.log('Received data from API:', data)

            if (!data.data || !Array.isArray(data.data)) {
                console.error('Unexpected API response structure:', data)
                throw new Error('Unexpected API response structure')
            }

            allGames = allGames.concat(data.data)

            if (data.meta && data.meta.pagination) {
                hasMore = data.meta.pagination.page < data.meta.pagination.pageCount
                page++
            } else {
                hasMore = false
            }
        }

        console.log(`Total games fetched: ${allGames.length}`)
        saveToCache(allGames)
        return allGames
    } catch (error) {
        console.error('Error fetching games:', error)
        throw error
    }
}

export const searchGames = async (query) => {
    try {
        const allGames = await fetchAllGames()
        const results = allGames.filter(game =>
            game.attributes.Title.toLowerCase().includes(query.toLowerCase())
        )
        console.log(`Search results for "${query}":`, results.length)
        return results
    } catch (error) {
        console.error('Error in searchGames:', error)
        throw error
    }
}