// src/services/cacheService.js
// v 1.0

const CACHE_KEY = 'gameList';
const CACHE_TIMESTAMP_KEY = 'gameListTimestamp';
const CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

export const saveToCache = (data) => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString());
};

export const getFromCache = () => {
    const cachedData = localStorage.getItem(CACHE_KEY);
    const timestamp = localStorage.getItem(CACHE_TIMESTAMP_KEY);

    if (!cachedData || !timestamp) {
        return null;
    }

    // Check if cache is older than CACHE_DURATION
    if (Date.now() - parseInt(timestamp) > CACHE_DURATION) {
        return null;
    }

    return JSON.parse(cachedData);
};

export const clearCache = () => {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(CACHE_TIMESTAMP_KEY);
};