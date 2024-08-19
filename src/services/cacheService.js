// src/services/cacheService.js
// v 1.3
// Changed image caching to use IndexedDB instead of localStorage

const CACHE_KEY = 'gameList';
const CACHE_TIMESTAMP_KEY = 'gameListTimestamp';
const CACHE_DURATION = 12 * 60 * 60 * 1000; // 12 hours in milliseconds

const IMAGE_CACHE_PREFIX = 'cyoa_img_cache_';
const IMAGE_CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_CACHE_ITEMS = 500;

const DB_NAME = 'CYOAImageCache';
const STORE_NAME = 'images';

let db;

// Open IndexedDB connection
const openDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = (event) => reject("IndexedDB error: " + event.target.error);
        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            db.createObjectStore(STORE_NAME, { keyPath: "url" });
        };
    });
};

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

export const cacheImage = async (url, base64Data) => {
    try {
        await openDB();
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const cacheData = {
            url,
            data: base64Data,
            timestamp: Date.now(),
            size: base64Data.length
        };

        // Check and manage cache size
        const allItems = await store.getAll();
        let totalSize = allItems.reduce((sum, item) => sum + item.size, 0);

        if (allItems.length >= MAX_CACHE_ITEMS || totalSize + cacheData.size > MAX_CACHE_SIZE) {
            // Remove oldest items until there's enough space
            allItems.sort((a, b) => a.timestamp - b.timestamp);
            while (allItems.length >= MAX_CACHE_ITEMS || totalSize + cacheData.size > MAX_CACHE_SIZE) {
                const oldestItem = allItems.shift();
                await store.delete(oldestItem.url);
                totalSize -= oldestItem.size;
            }
        }

        await store.put(cacheData);
    } catch (error) {
        console.error('Error caching image:', error);
    }
};

export const getCachedImage = async (url) => {
    try {
        await openDB();
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const cachedItem = await store.get(url);

        if (cachedItem && Date.now() - cachedItem.timestamp < IMAGE_CACHE_EXPIRATION) {
            return cachedItem.data;
        } else if (cachedItem) {
            // Remove expired item
            const deleteTransaction = db.transaction([STORE_NAME], 'readwrite');
            const deleteStore = deleteTransaction.objectStore(STORE_NAME);
            await deleteStore.delete(url);
        }
    } catch (error) {
        console.error('Error retrieving cached image:', error);
    }
    return null;
};

export const clearImageCache = async () => {
    try {
        await openDB();
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        await store.clear();
    } catch (error) {
        console.error('Error clearing image cache:', error);
    }
};

// Function to clear all caches
export const clearAllCaches = async () => {
    clearCache();
    await clearImageCache();
};