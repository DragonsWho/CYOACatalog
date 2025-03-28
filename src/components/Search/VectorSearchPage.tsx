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
  Grid2, // Импортируем Grid2
  useTheme // Импортируем useTheme для стилей
} from '@mui/material';
import { Game, gamesCollection } from '../../pocketbase/pocketbase'; // Импортируем Game и gamesCollection
import GameCard from '../GameCard'; // Импортируем GameCard

// Интерфейс для ответа воркера (оставляем как есть)
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
 
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Game[]>([]); // Состояние для хранения найденных игр
  const [searchAttempted, setSearchAttempted] = useState<boolean>(false); // Флаг, что поиск был выполнен

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
        throw new Error(`Search worker failed: ${workerResponse.status} ${workerResponse.statusText}. ${errorText || ''}`);
      }

      const workerData: WorkerSearchResponse = await workerResponse.json();
      console.log('Worker Response:', workerData);

      if (!workerData.matches || workerData.matches.length === 0) {
        // Если воркер ничего не нашел, просто завершаем
        console.log('Worker returned no matches.');
        setIsLoading(false); // Важно остановить загрузку
        return;
      }

      // --- Шаг 2: Извлечение ID игр ---
      const gameIds = workerData.matches.map(match => match.metadata.game_id).filter(id => !!id); // Извлекаем и фильтруем пустые ID на всякий случай

      if (gameIds.length === 0) {
        // Если не удалось извлечь ID (маловероятно, но возможно)
        console.log('No valid game_ids found in worker metadata.');
        setIsLoading(false);
        return;
      }
      console.log('Extracted game IDs:', gameIds);

      // --- Шаг 3: Формирование фильтра для PocketBase ---
      // Создаем строку вида "id='id1' || id='id2' || ..."
      const pbFilter = gameIds.map(id => `id = "${id}"`).join(' || ');
      console.log('PocketBase Filter:', pbFilter);

      // --- Шаг 4: Запрос к PocketBase ---
      // Используем getFullList, т.к. ожидаем небольшое кол-во результатов (topK=5)
      // Указываем тип <Game> для типизации результата
      const pbGames = await gamesCollection.getFullList<Game>(/*{ // getFullList не принимает batch, если записей больше 500, нужно использовать getList постранично, но здесь это не нужно
        batch: gameIds.length // Можно указать batch для оптимизации, но getFullList делает это автоматически
      },*/ {
        filter: pbFilter,
        // Важно добавить expand, чтобы получить теги и авторов для GameCard
        expand: 'tags.tag_categories_via_tags,authors_via_games',
      });
      console.log('PocketBase Response (unordered):', pbGames);

      // --- Шаг 5: Сохранение порядка из воркера ---
      // PocketBase НЕ гарантирует порядок при использовании '||' в фильтре.
      // Нужно отсортировать полученные игры (pbGames) в том же порядке,
      // в котором ID пришли от воркера (gameIds).
      const gameMap = new Map(pbGames.map(game => [game.id, game]));
      const orderedGames = gameIds
        .map(id => gameMap.get(id)) // Получаем игры по ID в нужном порядке
        .filter((game): game is Game => !!game); // Отфильтровываем игры, которые могли не найтись в PB (хотя не должны)

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
      setError(null);
    }
    // Не сбрасываем searchAttempted здесь
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}> {/* Используем xl для большего пространства */}
      <Box sx={{ my: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Vector Search (Moderator Tool)
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', mb: 3 }}> {/* Изменили align-items */}
          <TextField
            fullWidth
            variant="outlined"
            label="Search Query (e.g., simulation, sci-fi)"
            value={searchQuery}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            disabled={isLoading}
            error={!!error && !searchQuery.trim()}
            helperText={error && !searchQuery.trim() ? error : ''} // Показываем helperText только при ошибке пустого поля
            sx={{ flexGrow: 1 }}
          />
          <Button
            variant="contained"
            onClick={handleSearch}
            disabled={isLoading || !searchQuery.trim()}
            sx={{ height: '56px', flexShrink: 0 }} // Фиксированная высота, не сжимается
          >
            {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Search'}
          </Button>
        </Box>

        {/* Показываем общую ошибку запроса */}
        {error && searchQuery.trim() && (
           <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        )}

        {/* --- Область результатов --- */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', my: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {!isLoading && searchAttempted && searchResults.length === 0 && !error && (
           <Typography sx={{ mt: 4, textAlign: 'center' }}>
             No games found for your query "{searchQuery}".
           </Typography>
        )}

        {!isLoading && searchResults.length > 0 && (
           <Box sx={{ width: '100%', mt: 4 }}>
            {/* Используем Grid2 как в GameList или SearchPage */}
            <Grid2 container spacing={2} justifyContent="center">
                {searchResults.map((game) => (
                <Grid2
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }} // Такие же размеры, как в GameList
                    key={`vector-search-${game.id}`} // Уникальный ключ
                >
                    {/* Передаем найденную игру в GameCard */}
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