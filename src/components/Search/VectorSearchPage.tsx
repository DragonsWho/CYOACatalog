// src/components/Search/VectorSearchPage.tsx
import React, { useState } from 'react';
import {
  Box,
  Typography,
  Container,
  TextField,
  Button,
  CircularProgress,
  Alert,
  Grid2 // Импортируем Grid2
  // useTheme больше не нужен, так как не используется
} from '@mui/material';
import { Game, gamesCollection } from '../../pocketbase/pocketbase'; // Импортируем Game и gamesCollection
import GameCard from '../GameCard'; // Импортируем GameCard

// Интерфейс для ответа воркера
interface VectorMatch {
  id: string; // Это ID вектора, не ID игры
  score: number;
  metadata: {
    game_id: string; // Вот ID игры из PocketBase
    title: string;
    content_preview?: string;
    url?: string;
    [key: string]: any;
  };
}

interface WorkerSearchResponse {
  query: string;
  matches: VectorMatch[];
}

export default function VectorSearchPage() {
  // const theme = useTheme(); // Удалено, так как не используется
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Game[]>([]); // Состояние для хранения найденных игр
  const [searchAttempted, setSearchAttempted] = useState<boolean>(false); // Флаг, что поиск был выполнен

  // Убедись, что URL верный и доступен из твоего окружения
  const workerUrl = 'https://my-game-search-worker.dragonswho.workers.dev/search';

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setError('Please enter a search query.');
      return;
    }
    setIsLoading(true);
    setError(null);
    setSearchResults([]); // Сбрасываем предыдущие результаты
    setSearchAttempted(true); // Отмечаем, что поиск был запущен

    try {
      // --- Шаг 1: Запрос к воркеру ---
      const workerResponse = await fetch(`${workerUrl}?q=${encodeURIComponent(searchQuery)}`);

      if (!workerResponse.ok) {
        const errorText = await workerResponse.text();
        console.error('Worker Error Response:', errorText);
        // Попытка показать более понятную ошибку, если есть текст от воркера
        throw new Error(`Search worker failed: ${workerResponse.status} ${workerResponse.statusText}. ${errorText || ''}`);
      }

      const workerData: WorkerSearchResponse = await workerResponse.json();
      console.log('Worker Response:', workerData);

      if (!workerData.matches || workerData.matches.length === 0) {
        console.log('Worker returned no matches.');
        setIsLoading(false);
        return; // Завершаем, так как нет совпадений для поиска в PB
      }

      // --- Шаг 2: Извлечение ID игр ---
      const gameIds = workerData.matches
        .map(match => match.metadata?.game_id) // Добавили ?. на случай отсутствия metadata
        .filter((id): id is string => !!id); // Извлекаем и фильтруем null/undefined/пустые ID

      if (gameIds.length === 0) {
        console.log('No valid game_ids found in worker metadata.');
        // Возможно, стоит показать сообщение пользователю?
        // setError("Search results found, but couldn't identify games.");
        setIsLoading(false);
        return;
      }
      console.log('Extracted game IDs:', gameIds);

      // --- Шаг 3: Формирование фильтра для PocketBase ---
      const pbFilter = gameIds.map(id => `id = "${id}"`).join(' || ');
      console.log('PocketBase Filter:', pbFilter);

      // --- Шаг 4: Запрос к PocketBase ---
      const pbGames = await gamesCollection.getFullList<Game>({ // getFullList<Game> типизирует результат
        filter: pbFilter,
        expand: 'tags.tag_categories_via_tags,authors_via_games', // Необходимые expand для GameCard
      });
      console.log('PocketBase Response (unordered):', pbGames);

      // --- Шаг 5: Сохранение порядка из воркера ---
      const gameMap = new Map(pbGames.map(game => [game.id, game]));
      const orderedGames = gameIds
        .map(id => gameMap.get(id))
        .filter((game): game is Game => !!game); // Отфильтровываем, если игра не нашлась в PB

      console.log('PocketBase Response (ordered):', orderedGames);

      setSearchResults(orderedGames);

    } catch (err: any) {
      console.error('Error during vector search process:', err);
      setError(err.message || 'An unexpected error occurred.');
      setSearchResults([]); // Очищаем результаты при ошибке
    } finally {
      setIsLoading(false); // Завершаем загрузку в любом случае
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(event.target.value);
    if (error && event.target.value.trim()) {
      setError(null); // Сбрасываем ошибку при начале ввода
    }
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch(); // Запускаем поиск по Enter
    }
  };

  return (
    // Используем maxWidth="xl" для большего пространства под карточки
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
      <Box sx={{ my: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Vector Search (Moderator Tool)
        </Typography>
        {/* Форма поиска */}
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 3 }}>
          <TextField
            fullWidth
            variant="outlined"
            label="Search Query (e.g., simulation, sci-fi)"
            value={searchQuery}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            disabled={isLoading}
            // Показываем ошибку только если было взаимодействие и поле пустое
            error={!!error && !searchQuery.trim()}
            helperText={error && !searchQuery.trim() ? error : ''}
            sx={{ flexGrow: 1 }} // Поле ввода растягивается
          />
          <Button
            variant="contained"
            onClick={handleSearch}
            disabled={isLoading || !searchQuery.trim()} // Блокируем если загрузка или поле пустое
            sx={{ height: '56px', flexShrink: 0 }} // Фикс. высота, не сжимается
          >
            {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Search'}
          </Button>
        </Box>

        {/* Отображение ошибки запроса (если она есть и не связана с пустым полем) */}
        {error && searchQuery.trim() && (
           <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        )}

        {/* --- Область результатов --- */}
        {/* Индикатор загрузки */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {/* Сообщение "Ничего не найдено" */}
        {!isLoading && searchAttempted && searchResults.length === 0 && !error && (
           <Typography sx={{ mt: 4, textAlign: 'center' }}>
             No games found for your query "{searchQuery}".
           </Typography>
        )}

        {/* Сетка с результатами */}
        {!isLoading && searchResults.length > 0 && (
           <Box sx={{ width: '100%', mt: 4 }}>
            <Grid2 container spacing={2} justifyContent="center">
                {searchResults.map((game) => (
                <Grid2
                    // Размеры колонок как в GameList/SearchPage
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                    key={`vector-search-${game.id}`} // Уникальный ключ
                >
                    <GameCard game={game} variant="standard" />
                </Grid2>
                ))}
            </Grid2>
           </Box>
        )}
        {/* --- Конец области результатов --- */}

      </Box>
    </Container>
  );
}