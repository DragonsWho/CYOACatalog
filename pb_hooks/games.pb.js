/// <reference path="../pb_data/types.d.ts" />

// onRecordBeforeUpdateRequest УДАЛЕН или ЗАКОММЕНТИРОВАН

/**
 * Хук, срабатывающий *перед* созданием записи в коллекции 'games'.
 * Устанавливает начальное значение 'upvotes_count'.
 */
onRecordBeforeCreateRequest((e) => {
    if (e.collection.name !== "games") {
        return;
    }
    if ('upvotes' in e.data) {
        const initialUpvotes = Array.isArray(e.data.upvotes) ? e.data.upvotes : [];
        e.data.upvotes_count = initialUpvotes.length;
        console.log(`[Hook Create] Initial upvotes provided. Setting upvotes_count to: ${e.data.upvotes_count}`);
    } else {
        e.data.upvotes_count = 0;
        console.log(`[Hook Create] No initial upvotes. Initializing upvotes_count to 0.`);
    }
}, "games");

console.log("Hook 'onRecordBeforeCreateRequest' for 'games' collection loaded.");