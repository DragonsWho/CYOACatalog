// src/components/ModeratorPanel/ModeratorPanel.tsx
import React, { useState, useEffect, useContext } from 'react';
import { Container, Typography, Paper, Box, Button, TextField, Autocomplete, CircularProgress } from '@mui/material';
import { styled } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import { AuthContext, Game, gamesCollection } from '../../pocketbase/pocketbase';
import TagDisplay from '../CyoaPage/TagDisplay';

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

export default function ModeratorPanel() {
  const { signedIn, isModerator } = useContext(AuthContext);
  const navigate = useNavigate();
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [editedGame, setEditedGame] = useState<Partial<Game>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!signedIn || !isModerator) {
      navigate('/');
    }
  }, [signedIn, isModerator, navigate]);

  useEffect(() => {
    if (signedIn && isModerator) {
      setIsLoading(true);
      gamesCollection
        .getFullList({
          sort: '-created',
          expand: 'tags,authors_via_games',
        })
        .then((res) => {
          setGames(res);
          setIsLoading(false);
        })
        .catch((err) => {
          console.error('Ошибка загрузки игр:', err);
          setIsLoading(false);
        });
    }
  }, [signedIn, isModerator]);

  const handleSelectGame = (game: Game | null) => {
    if (game) {
      setSelectedGame(game);
      setEditedGame({
        title: game.title,
        description: game.description,
        image: game.image,
        iframe_url: game.iframe_url,
        tags: game.tags,
      });
    } else {
      setSelectedGame(null);
      setEditedGame({});
    }
  };

  const handleInputChange = (field: keyof Game) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setEditedGame((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleSave = async () => {
    if (!selectedGame || !editedGame) return;
    try {
      await gamesCollection.update(selectedGame.id, editedGame);
      setGames((prev) =>
        prev.map((g) => (g.id === selectedGame.id ? { ...g, ...editedGame } : g))
      );
      setSelectedGame((prev) => prev && { ...prev, ...editedGame });
      alert('Игра успешно обновлена!');
    } catch (err) {
      console.error('Ошибка сохранения:', err);
      alert('Не удалось сохранить изменения.');
    }
  };

  const filteredGames = games.filter((game) =>
    game.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (!signedIn || !isModerator) return null;

  return (
    <Container maxWidth="md">
      <Typography
        variant="h4"
        component="h1"
        gutterBottom
        sx={{
          mt: 4,
          color: '#e0e0e0',
          textAlign: 'center',
          fontSize: { xs: '2rem', sm: '2.5rem' },
        }}
      >
        Moderator Panel
      </Typography>

      <StyledPaper elevation={3}>
        <Typography variant="h6" gutterBottom>
          Выберите игру для редактирования
        </Typography>
        <Autocomplete
          options={games}
          getOptionLabel={(option) => option.title || 'Без названия'}
          renderInput={(params) => (
            <TextField
              {...params}
              variant="outlined"
              label="Поиск игры"
              placeholder="Введите название..."
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {isLoading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
                style: { color: '#e0e0e0' },
              }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  '& fieldset': { borderColor: '#e0e0e0' },
                  '&:hover fieldset': { borderColor: '#e0e0e0' },
                  '&.Mui-focused fieldset': { borderColor: '#e0e0e0' },
                },
              }}
            />
          )}
          onChange={(_, newValue) => handleSelectGame(newValue)}
          value={selectedGame}
          loading={isLoading}
          sx={{ width: '100%', mb: 2 }}
        />
      </StyledPaper>

      {selectedGame && (
        <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom>
            Редактирование: {selectedGame.title}
          </Typography>
          <Box component="form" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Название"
              value={editedGame.title || ''}
              onChange={handleInputChange('title')}
              fullWidth
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />
            <TextField
              label="Описание"
              value={editedGame.description || ''}
              onChange={handleInputChange('description')}
              fullWidth
              multiline
              rows={4}
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />
            <TextField
              label="URL iframe (если есть)"
              value={editedGame.iframe_url || ''}
              onChange={handleInputChange('iframe_url')}
              fullWidth
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />
            <Box>
              <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                Теги
              </Typography>
              <TagDisplay tags={selectedGame.expand?.tags || []} gameId={selectedGame.id} />
            </Box>
            <Button variant="contained" color="primary" onClick={handleSave}>
              Сохранить изменения
            </Button>
          </Box>
        </StyledPaper>
      )}
    </Container>
  );
}