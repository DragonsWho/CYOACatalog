// src/components/Profile/BlockedTagsSettings.tsx
import React, { useState, useEffect, useContext, useRef } from 'react';
import { Box, Typography, Autocomplete, TextField, Chip, Button, CircularProgress, Alert } from '@mui/material';
import { Tag, User, pb, usersCollection } from '../../pocketbase/pocketbase'; // Убедимся что User импортирован
import { AuthContext } from '../../pocketbase/pocketbase';

interface BlockedTagsSettingsProps {
  allTags: string[]; // Список имен всех тегов
  initialBlockedTags: Tag[]; // Текущие заблокированные теги (объекты)
  onBlockedTagsUpdate: () => void; // Функция для вызова после обновления
}

// Убедись, что эти ИМЕНА тегов существуют в твоей базе данных!
const DEFAULT_BLOCKED_TAGS: string[] = ['scat', 'guro', 'diapers', 'vomit'];

export default function BlockedTagsSettings({
  allTags,
  initialBlockedTags,
  onBlockedTagsUpdate,
}: BlockedTagsSettingsProps) {
  // --- ИСПРАВЛЕНИЕ: Явно типизируем user ---
  const { user }: { user: User | null } = useContext(AuthContext);
  const [selectedBlockedTagNames, setSelectedBlockedTagNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const initialSetupDone = useRef(false);

  // --- useEffect для установки НАЧАЛЬНОГО состояния и дефолтов ---
  useEffect(() => {
    // Выполняем только если user загружен
    if (!user) return;

    // Проверяем, была ли уже начальная установка
    if (!initialSetupDone.current) {
        // --- ИСПРАВЛЕНИЕ: Проверяем флаг пользователя ---
        // Используем ?. для безопасного доступа, user может быть null теоретически
        if (!user.blocked_tags_customized && initialBlockedTags.length === 0) {
            // --- ИСПРАВЛЕНИЕ: Правильная фильтрация и маппинг ---
            const validDefaultTags = DEFAULT_BLOCKED_TAGS.filter(defaultTag =>
                allTags.some(existingTag => existingTag.toLowerCase() === defaultTag.toLowerCase())
            );
            // Находим оригинальный регистр
            const validDefaultTagsOriginalCase = validDefaultTags
                .map(defaultTag =>
                     allTags.find(existingTag => existingTag.toLowerCase() === defaultTag.toLowerCase())
                )
                // Отфильтровываем undefined, если find ничего не нашел (хотя не должно быть из-за filter выше)
                .filter((tag): tag is string => tag !== undefined);
            // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

            console.log("Applying default blocked tags (initial, user hasn't customized):", validDefaultTagsOriginalCase);
            setSelectedBlockedTagNames(validDefaultTagsOriginalCase.sort());
        } else {
            // Используем сохраненные теги
            const currentBlockedNames = initialBlockedTags.map(tag => tag.name);
            console.log("Setting initial state from saved tags (or user customized empty):", currentBlockedNames);
            setSelectedBlockedTagNames(currentBlockedNames.sort());
        }
        initialSetupDone.current = true; // Помечаем установку выполненной
    } else {
        // Синхронизация после сохранения (без применения дефолтов)
        // Этот блок может быть и не нужен, если App.tsx стабильно передает initialBlockedTags
         const currentBlockedNames = initialBlockedTags.map(tag => tag.name);
         if (JSON.stringify(selectedBlockedTagNames.sort()) !== JSON.stringify(currentBlockedNames.sort())) {
            console.log("Syncing state with externally changed initialBlockedTags:", currentBlockedNames);
            setSelectedBlockedTagNames(currentBlockedNames.sort());
         }
    }
  }, [initialBlockedTags, allTags, user]); // Убрали selectedBlockedTagNames из зависимостей useEffect

  // Функция для экранирования кавычек
  const escapeQuotes = (str: string): string => str.replace(/"/g, '\\"');

  // Функция сохранения
  const handleSave = async () => {
    if (!user) { setError("User not logged in."); return; }
    setLoading(true); setError(null); setSuccess(null);
    try {
      let tagIdsToBlock: string[] = [];
      if (selectedBlockedTagNames.length > 0) {
        console.log("Getting IDs for selected names:", selectedBlockedTagNames);
        const filterString = selectedBlockedTagNames.map(name => `name = "${escapeQuotes(name)}"`).join(' || ');
        console.log("Generated filter string:", filterString);
        const fullTagObjects = await pb.collection('tags').getFullList({ filter: filterString, fields: 'id' });
        tagIdsToBlock = fullTagObjects.map(tag => tag.id);
        if (tagIdsToBlock.length !== selectedBlockedTagNames.length) {
             console.warn("Warning: Not all selected tag names were found in the database. Some might be invalid.");
        }
      } else {
        console.log("No blocked tags selected, saving empty array.");
      }
      console.log("Saving blocked tags. Final IDs to block:", tagIdsToBlock);

      // Обновляем ОБА поля
      await usersCollection.update(user.id, {
        blocked_tags: tagIdsToBlock,
        blocked_tags_customized: true, // Всегда ставим true при сохранении
      });

      setSuccess("Blocked tags updated successfully!");
      onBlockedTagsUpdate(); // Сообщаем App.tsx обновить данные

    } catch (err: any) {
      console.error("Error updating blocked tags:", err);
      console.error("PocketBase error details:", err.data);
      setError(`Failed to update blocked tags: ${err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
      setTimeout(() => { setSuccess(null); setError(null); }, 3000);
    }
  };

  // --- JSX рендеринг ---
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="h6" gutterBottom>
        Blocked Tags Management
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Games containing any of these tags will always be hidden. Some potentially disturbing tags might be blocked by default. You can remove any tags from this list and save your preferences.
      </Typography>

      <Autocomplete
        multiple
        // Используем allTags для опций, сортируем
        options={allTags.sort()}
        // Контролируем значение через наше состояние
        value={selectedBlockedTagNames}
        // Обновляем состояние при изменении выбора в Autocomplete
        onChange={(event, newValue) => {
          console.log("Autocomplete onChange:", newValue);
          setSelectedBlockedTagNames(newValue.sort()); // Обновляем состояние и сортируем
        }}
        // Рендер поля ввода
        renderInput={(params) => (
          <TextField
            {...params}
            variant="outlined"
            label="Select tags to block"
            placeholder={selectedBlockedTagNames.length === 0 ? 'Search and select tags...' : ''}
            fullWidth
          />
        )}
        // Рендер чипов
        renderTags={(value, getTagProps) =>
          value.map((option, index) => {
             const { key, ...tagProps } = getTagProps({ index });
             return (
                  <Chip
                    key={option}
                    label={option}
                    variant="outlined"
                    color="error" // Всегда красный для заблокированных
                    size="small"
                    {...tagProps} // Передает стандартный onDelete и другие атрибуты
                 />
             );
         })
        }
        // Не закрывать список при выборе
        disableCloseOnSelect
        // Отступы
        sx={{ mb: 2 }}
      />
       {/* Кнопка и сообщения */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
         <Button variant="contained" onClick={handleSave} disabled={loading} startIcon={loading ? <CircularProgress size={20} color="inherit" /> : null} >
            Save Blocked Tags
         </Button>
         {success && <Alert severity="success" sx={{py: 0.5}}>{success}</Alert>}
         {error && <Alert severity="error" sx={{py: 0.5}}>{error}</Alert>}
      </Box>
    </Box>
  );
}