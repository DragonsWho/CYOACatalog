/// <reference path="../pb_data/types.d.ts" />

/**
 * Хук, срабатывающий ПОСЛЕ удаления записи в коллекции 'comments'.
 * Декрементирует счетчик comments_count у связанной игры,
 * если удаляемый комментарий был верхнего уровня (не ответ).
 */
onRecordAfterDeleteRequest((e) => {
    // e = RecordDeleteEvent
    // e.record содержит данные УДАЛЕННОГО комментария

    if (e.collection.name !== "comments") {
        return; // Не наша коллекция
    }

    console.log(`[Hook Comments Delete] Triggered for deleted comment ${e.record.id}`);

    try {
        // Проверяем, был ли это ответ на другой комментарий
        const parentId = e.record.get("parent");
        if (parentId) {
            console.log(`[Hook Comments Delete] Comment ${e.record.id} was a reply (parent: ${parentId}). Skipping game count update.`);
            return; // Если был ответ, счетчик игры не меняем
        }

        // Получаем ID игры, к которой относился комментарий
        const gameId = e.record.get("game");
        if (!gameId) {
            console.warn(`[Hook Comments Delete] Deleted comment ${e.record.id} has no associated gameId. Cannot update count.`);
            return; // Не можем найти игру
        }

        // Находим запись игры
        const gameRecord = $app.dao().findRecordById("games", gameId);

        if (!gameRecord) {
             console.warn(`[Hook Comments Delete] Game record ${gameId} not found for deleted comment ${e.record.id}.`);
             return; // Игра не найдена
        }

        // Получаем текущий счетчик
        const currentCount = gameRecord.getInt("comments_count") ?? 0;

        // Декрементируем счетчик (не ниже нуля)
        const newCount = Math.max(0, currentCount - 1);

        // Обновляем только если счетчик изменился
        if (newCount !== currentCount) {
            gameRecord.set("comments_count", newCount);

            // Сохраняем изменения в записи игры
            $app.dao().saveRecord(gameRecord);
            console.log(`[Hook Comments Delete] Decremented comments_count for game ${gameId} to ${newCount}.`);
        } else {
             console.log(`[Hook Comments Delete] comments_count for game ${gameId} is already 0 or was not decremented.`);
        }

    } catch (err) {
        console.error(`[Hook Comments Delete] Error processing after delete comment ${e.record.id}:`, err);
         if (err instanceof Error && err.stack) {
              console.error("[Hook Comments Delete] Error Stack:", err.stack);
         }
         // Не бросаем ошибку здесь, т.к. комментарий уже удален
    }

}, "comments"); // Указываем коллекцию "comments"

console.log("Hook 'onRecordAfterDeleteRequest' for 'comments' collection loaded.");