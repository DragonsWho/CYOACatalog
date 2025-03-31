// src/components/Header/UnifiedSearchBar.tsx

import React, { useState, useEffect } from 'react';
import { Box, TextField, Autocomplete, Chip, IconButton, Popover, useTheme, createFilterOptions } from '@mui/material'; // Вернули createFilterOptions
import SearchIcon from '@mui/icons-material/Search';
import { useNavigate } from 'react-router-dom';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';

interface UnifiedSearchBarProps {
  tags: string[];
  authors: string[];
  selectedTags: string[];
  selectedAuthors: string[];
  onTagChange: (value: string[]) => void;
  onAuthorChange: (value: string[]) => void;
}

const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_BORDER_RADIUS = '4px';

const positiveTagColor = 'success';
const negativeTagColor = 'error';
const authorTagColor = 'info';

// Используем стандартный фильтр MUI как основу
const defaultFilter = createFilterOptions<string>();

export default function UnifiedSearchBar({
  tags,
  authors,
  selectedTags,
  selectedAuthors,
  onTagChange,
  onAuthorChange,
}: UnifiedSearchBarProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [tagInputValue, setTagInputValue] = useState(''); // Отдельное состояние для поля ввода тегов
  const [searchResults, setSearchResults] = useState<Game[]>([]);
  const navigate = useNavigate();
  const theme = useTheme();

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
    setTagInputValue('');
    setSearchQuery('');
  };

  const open = Boolean(anchorEl);

  useEffect(() => {
    const delayDebounce = setTimeout(() => {
      if (searchQuery) {
        (async () => { /* ... поиск заголовков ... */
            try {
                const fetchedGames = await gamesCollection.getList(1, 10, { filter: `title ~ "${searchQuery}"`, sort: '-created', fields: 'id,title', });
                setSearchResults(fetchedGames.items);
            } catch (error) { console.error("Error fetching game titles:", error); setSearchResults([]); }
        })();
      } else { setSearchResults([]); }
    }, 300);
    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  const commonStyles = { /* ... без изменений ... */ };

  function renderTags( value: string[], getTagProps: (params: { index: number }) => Record<string, any>, isTag: boolean,) {
      return value.map((option: string, index: number) => { /* ... без изменений ... */
        const { key, ...otherProps } = getTagProps({ index });
        const isNegative = isTag && option.startsWith('-');
        const label = isNegative ? option.substring(1) : option;

        let chipColor: 'success' | 'error' | 'info' | 'default' = 'default';
        let chipVariant: 'filled' | 'outlined' = 'filled';
        if (isTag) {
          chipColor = isNegative ? negativeTagColor : positiveTagColor;
          chipVariant = 'outlined';
        } else {
          chipColor = authorTagColor;
          chipVariant = 'filled';
        }
        const baseTagName = isNegative ? option.substring(1) : option;
        const isValid = isTag ? tags.includes(baseTagName) : authors.includes(baseTagName);

        return ( <Chip key={option} label={label} size="small" color={isValid ? chipColor : 'default'} variant={isValid ? chipVariant : 'outlined'} title={!isValid ? `Invalid ${isTag ? 'tag' : 'author'}` : undefined} {...otherProps} onDelete={() => { if (isTag) { onTagChange(selectedTags.filter((t) => t !== option)); } else { onAuthorChange(selectedAuthors.filter((a) => a !== option)); } }} sx={{ height: CHIP_HEIGHT, fontSize: CHIP_FONT_SIZE, borderRadius: CHIP_BORDER_RADIUS, textDecoration: !isValid ? 'line-through' : 'none', opacity: !isValid ? 0.7 : 1, '& .MuiChip-deleteIcon': { fontSize: '0.8rem', color: !isValid ? theme.palette.action.disabled : (chipVariant === 'outlined' ? theme.palette[chipColor]?.main : theme.palette[chipColor]?.contrastText), '&:hover': { color: !isValid ? theme.palette.action.disabled : (chipVariant === 'outlined' ? theme.palette[chipColor]?.dark : undefined), } } }} /> );
      });
    }

  // --- НАЧАЛО ИЗМЕНЕНИЙ: Кастомный filterOptions ---
  const filterTagOptions = (options: string[], params: { inputValue: string; getOptionLabel: (option: string) => string; }) => {
    // Убираем минус из ввода ПЕРЕД фильтрацией
    const cleanedInput = params.inputValue.startsWith('-')
      ? params.inputValue.substring(1)
      : params.inputValue;

    // Используем стандартный фильтр MUI с очищенным вводом
    const filtered = defaultFilter(options, { ...params, inputValue: cleanedInput });

    // Важно: Не добавляем опцию "Create..." для freeSolo здесь,
    // обработка ввода будет в onChange/onKeyDown
    return filtered;
  };
  // --- КОНЕЦ ИЗМЕНЕНИЙ ---

  // --- НАЧАЛО ИЗМЕНЕНИЙ: Обработка добавления тега (Enter/Выбор) ---
  const handleAddTag = (tagToAdd: string | null) => {
    if (!tagToAdd) return;

    const trimmedItem = tagToAdd.trim();
    if (!trimmedItem) return;

    const isNegative = trimmedItem.startsWith('-');
    const baseTagName = isNegative ? trimmedItem.substring(1) : trimmedItem;

    // Валидация: базовое имя тега должно существовать
    if (tags.includes(baseTagName)) {
        const newSelection = [...new Set([...selectedTags, trimmedItem])]; // Добавляем и убираем дубликаты
        onTagChange(newSelection);
        console.log(`[handleAddTag] Added "${trimmedItem}". New selection:`, newSelection);
    } else {
       console.log(`[handleAddTag] Tag validation failed: Base tag "${baseTagName}" not found for input "${trimmedItem}". Ignoring.`);
    }
     // Очищаем поле ввода после попытки добавления
     setTagInputValue('');
  };
  // --- КОНЕЦ ИЗМЕНЕНИЙ ---


  return (
    <>
      <IconButton onClick={handleClick} color="inherit"><SearchIcon /></IconButton>
      <Popover open={open} anchorEl={anchorEl} onClose={handleClose} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }} PaperProps={{ sx: { p: 0 } }}>
        <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 280 }}>
          {/* Поиск по названию */}
          <Autocomplete freeSolo options={searchResults} getOptionLabel={(option) => (typeof option === 'object' ? option.title : option)} inputValue={searchQuery} onInputChange={(_, v, r) => {if (r === 'input') setSearchQuery(v);}} renderInput={(params) => (<TextField {...params} variant="outlined" size="small" placeholder="Search titles..." sx={{ ...commonStyles, backgroundColor: theme.palette.grey[800] }} />)} onChange={(_, v) => { if (typeof v === 'object' && v?.id) { navigate(`/game/${v.id}`); handleClose(); } else if (typeof v === 'string') { setSearchQuery(''); }}} />

          {/* Поиск по тегам */}
          <Autocomplete
            multiple
            freeSolo
            value={selectedTags}
            options={tags}
            inputValue={tagInputValue}
            onInputChange={(event, newInputValue, reason) => {
                // Всегда обновляем inputValue state
                setTagInputValue(newInputValue);
                console.log("[onInputChange Tag]", { newInputValue, reason });
            }}
            // --- НАЧАЛО ИЗМЕНЕНИЙ в onChange ---
            onChange={(event, newValue, reason, details) => {
                console.log("[onChange Tag]", { newValue, reason, details, currentTagInputValue: tagInputValue });

                if (reason === 'selectOption' && details?.option) {
                    // --- Логика для выбора из списка ---
                    const selectedOption = details.option; // Базовый тег, например "Free Use"

                    // Проверяем ИМЕННО tagInputValue, т.к. он содержит то, что вводил юзер ДО выбора
                    const addNegative = tagInputValue.trim().startsWith('-');

                    const tagToAdd = addNegative ? `-${selectedOption}` : selectedOption;
                    console.log(`[onChange selectOption] Input was: "${tagInputValue}", Selected: "${selectedOption}", addNegative: ${addNegative}, tagToAdd: "${tagToAdd}"`);

                    handleAddTag(tagToAdd); // Добавляем тег и очищаем ввод

                    // **Критически важно:** Предотвращаем стандартную обработку Autocomplete,
                    // которая добавила бы `selectedOption` в `newValue`.
                    // Возвращаем `false` или просто выходим, чтобы Autocomplete
                    // не изменял `value` на основе своего `newValue`.
                    // Состояние `selectedTags` обновится через `onTagChange` из `handleAddTag`.
                    return false; // Попробуем вернуть false

                } else if (reason === 'removeOption') {
                    // Позволяем Autocomplete обновить value при удалении чипа
                    // `newValue` будет содержать массив без удаленного элемента
                     onTagChange(newValue as string[]);
                } else if (reason === 'clear') {
                    // Полная очистка
                    onTagChange([]);
                    setTagInputValue(''); // Очищаем и поле ввода
                }
                // Для 'createOption' (Enter/Blur) ничего не делаем здесь, это в onKeyDown/onBlur
            }}
            // --- НАЧАЛО ИЗМЕНЕНИЙ: Используем кастомный фильтр ---
            filterOptions={filterTagOptions}
            // --- КОНЕЦ ИЗМЕНЕНИЙ ---
            renderInput={(params) => (
              <TextField
                {...params}
                variant="outlined"
                size="small"
                placeholder={selectedTags.length === 0 ? 'Filter tags (+/-)...' : ''}
                sx={commonStyles}
                 // --- НАЧАЛО ИЗМЕНЕНИЙ: Добавляем обработку Enter ---
                 onKeyDown={(event) => {
                    if (event.key === 'Enter' && tagInputValue.trim()) {
                         // Предотвращаем стандартное поведение формы/Autocomplete
                         event.preventDefault();
                         event.stopPropagation();
                         console.log("[onKeyDown Enter Tag]", tagInputValue);
                         handleAddTag(tagInputValue); // Пытаемся добавить текущий ввод
                    }
                 }}
                 // --- КОНЕЦ ИЗМЕНЕНИЙ ---
              />
            )}
            renderTags={(value, getTagProps) => renderTags(value, getTagProps, true)}
            disableCloseOnSelect
            limitTags={-1}
            getOptionLabel={(option) => option} // Просто возвращаем строку
            // --- Убрали clearOnBlur, selectOnFocus, handleHomeEndKeys, т.к. freeSolo и ручная обработка ---
          />

          {/* Поиск по авторам */}
          <Autocomplete multiple options={authors} value={selectedAuthors} onChange={(_, value) => onAuthorChange(value)} renderInput={(params) => (<TextField {...params} variant="outlined" size="small" placeholder={selectedAuthors.length === 0 ? 'Filter authors...' : ''} sx={commonStyles} />)} renderTags={(value, getTagProps) => renderTags(value, getTagProps, false)} disableCloseOnSelect limitTags={-1}/>
        </Box>
      </Popover>
    </>
  );
}