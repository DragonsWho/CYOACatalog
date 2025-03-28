// src/components/Search/VectorSearchPage.tsx
import React, { useState } from 'react';
import { Box, Typography, Container, TextField, Button, CircularProgress, Alert } from '@mui/material';

// Определим интерфейс для ответа воркера (можно вынести в отдельный файл типов)
interface VectorMatch {
    id: string;
    score: number;
    metadata: {
        game_id: string;
        title: string;
        content_preview?: string; // Добавим опционально
        url?: string; // Добавим опционально
        [key: string]: any; // Для прочих метаданных
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
  // Пока не храним результаты, просто выводим в консоль
  // const [results, setResults] = useState<WorkerSearchResponse | null>(null);

  const workerUrl = 'https://my-game-search-worker.dragonswho.workers.dev/search'; // Вынесем URL

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setError("Please enter a search query.");
      return;
    }
    setIsLoading(true);
    setError(null);
    // setResults(null); // Сбрасываем предыдущие результаты

    try {
      const response = await fetch(`${workerUrl}?q=${encodeURIComponent(searchQuery)}`);

      if (!response.ok) {
        // Попробуем прочитать текст ошибки от воркера
        const errorText = await response.text();
        console.error('Worker Error Response:', errorText);
        throw new Error(`Search worker failed: ${response.status} ${response.statusText}. ${errorText || ''}`);
      }

      const data: WorkerSearchResponse = await response.json();
      console.log("Worker Response:", data); // Выводим ответ в консоль
      // setResults(data); // Сохраним результаты для следующего шага

      // --- Имитация задержки для теста лоадера ---
      // await new Promise(resolve => setTimeout(resolve, 1500));
      // -----------------------------------------

    } catch (err: any) {
      console.error("Error during vector search:", err);
      setError(err.message || "An unexpected error occurred during search.");
    } finally {
      setIsLoading(false);
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
        handleSearch();
    }
   };

  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Box sx={{ my: 2 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Vector Search (Moderator Tool)
        </Typography>
         <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
           <TextField
             fullWidth
             variant="outlined"
             label="Search Query (e.g., simulation, sci-fi)"
             value={searchQuery}
             onChange={handleInputChange}
             onKeyPress={handleKeyPress} // Добавляем обработку Enter
             disabled={isLoading}
             error={!!error && !searchQuery.trim()} // Показываем ошибку если поле пустое при попытке поиска
             helperText={!!error && !searchQuery.trim() ? error : ''}
           />
           <Button
             variant="contained"
             onClick={handleSearch}
             disabled={isLoading || !searchQuery.trim()} // Блокируем кнопку, если пусто или идет загрузка
             sx={{ height: '56px' }} // Выравниваем высоту с TextField
           >
             {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Search'}
           </Button>
         </Box>

         {error && searchQuery.trim() && ( // Показываем ошибку, если она есть и запрос не пустой
            <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
         )}

         {/* Здесь позже будут результаты */}
         <Typography sx={{ mt: 3 }}>
            (Search results will appear here in the next steps)
         </Typography>

      </Box>
    </Container>
  );
}