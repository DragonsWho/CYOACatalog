// src/services/cacheService.js
// v 1.2
// Added cache size management

const CACHE_KEY = 'gameList';
const CACHE_TIMESTAMP_KEY = 'gameListTimestamp';
const CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

const IMAGE_CACHE_PREFIX = 'cyoa_img_cache_';
const IMAGE_CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_CACHE_ITEMS = 500;

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

export const cacheImage = (url, base64Data) => {
    try {
        const cacheKey = IMAGE_CACHE_PREFIX + url;
        const cacheData = {
            data: base64Data,
            timestamp: Date.now(),
            size: base64Data.length
        };

        // Check and manage cache size
        let totalSize = 0;
        const cacheKeys = Object.keys(localStorage).filter(key => key.startsWith(IMAGE_CACHE_PREFIX));

        if (cacheKeys.length >= MAX_CACHE_ITEMS) {
            // Remove oldest item if max items reached
            const oldestKey = cacheKeys.reduce((a, b) =>
                JSON.parse(localStorage.getItem(a)).timestamp < JSON.parse(localStorage.getItem(b)).timestamp ? a : b
            );
            localStorage.removeItem(oldestKey);
        }

        cacheKeys.forEach(key => {
            const item = JSON.parse(localStorage.getItem(key));
            totalSize += item.size;
        });

        if (totalSize + cacheData.size > MAX_CACHE_SIZE) {
            // Remove oldest items until there's enough space
            while (totalSize + cacheData.size > MAX_CACHE_SIZE && cacheKeys.length > 0) {
                const oldestKey = cacheKeys.shift();
                const oldestItem = JSON.parse(localStorage.getItem(oldestKey));
                totalSize -= oldestItem.size;
                localStorage.removeItem(oldestKey);
            }
        }

        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
    } catch (error) {
        console.error('Error caching image:', error);
    }
};

export const getCachedImage = (url) => {
    try {
        const cacheKey = IMAGE_CACHE_PREFIX + url;
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
            const { data, timestamp } = JSON.parse(cachedData);
            if (Date.now() - timestamp < IMAGE_CACHE_EXPIRATION) {
                return data;
            } else {
                localStorage.removeItem(cacheKey);
            }
        }
    } catch (error) {
        console.error('Error retrieving cached image:', error);
    }
    return null;
};

export const clearImageCache = () => {
    try {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(IMAGE_CACHE_PREFIX)) {
                localStorage.removeItem(key);
            }
        });
    } catch (error) {
        console.error('Error clearing image cache:', error);
    }
};

// Function to clear all caches
export const clearAllCaches = () => {
    clearCache();
    clearImageCache();
};