// src/components/CyoaPage/GameDetails.tsx

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress, Grid2, Paper, Theme } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import SimpleComments from './SimpleComments';
import GameAdditionalInfo from './GameAdditionalInfo';
import { Game, gamesCollection } from '../../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

interface CustomTheme extends Theme {
  custom?: {
    borderRadius?: string;
    boxShadow?: string;
    comments?: {
      backgroundColor?: string;
      borderRadius?: string;
    };
  };
}

export default function GameDetails() {
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [imageSrc, setImageSrc] = useState<string>(''); 
  const imgRef = useRef<HTMLImageElement>(null);
  const { id } = useParams<{ id: string }>();
  const theme = useTheme<CustomTheme>();
  const sanitizedDescription = useMemo(() => (game ? DOMPurify.sanitize(game.description) : ''), [game]);

  useEffect(() => {
    (async () => {
      try {
        const game = await gamesCollection.getOne(id as string, {
          expand: 'tags.tag_categories_via_tags,authors_via_games,comments.author',
        });
        setGame(game);
        setLoading(false);
      } catch (error) {
        console.error('Ошибка при загрузке игры:', error);
        setLoading(false);
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!game) return;
    
    const collectionId = game.collectionId || '5kxdvx071c10s2t';
    const imageURL = game.image 
      ? `/api/files/${collectionId}/${game.id}/${game.image}` 
      : '';

    // Устанавливаем сначала base64 как заполнитель, если он есть
    if (game.image_base64) {
      setImageSrc(
        game.image_base64.startsWith('data:')
          ? game.image_base64
          : `data:image/jpeg;base64,${game.image_base64}`
      );
    }

    // Если есть полноценное изображение, загружаем его
    if (imageURL && game.image_base64) {
      const img = new Image();
      img.onload = () => {
        setImageSrc(imageURL); // Заменяем base64 на полноценное изображение
      };
      img.onerror = () => {
        console.error('Failed to load full image, keeping base64');
      };
      img.src = imageURL;
    } else if (imageURL && !game.image_base64) {
      // Если нет base64, сразу используем полноценное изображение
      setImageSrc(imageURL);
    }
  }, [game]);

  if (loading) return <CircularProgress />;
  if (!game) return <Typography>Game not found</Typography>;

  return (
    <Container maxWidth="lg" disableGutters>
      <Paper
        elevation={3}
        sx={{
          p: 2,
          mb: 0,
          bgcolor: theme.palette.background.paper,
          color: theme.palette.common.white,
        }}
      >
        <Box
          sx={{
            mb: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
          }}
        >
          <Typography variant="h4" component="h1" sx={{ mr: 1, color: theme.palette.text.primary }}>
            {game.title || 'Untitled Game'}
          </Typography>
          {game.expand?.authors_via_games?.length && game.expand.authors_via_games?.length > 0 && (
            <Typography variant="subtitle1" sx={{ mb: '0.05em', color: theme.palette.text.primary }}>
              by {game.expand.authors_via_games.map((author) => author.name).join(', ')}
            </Typography>
          )}
        </Box>

        <Grid2 container spacing={3}>
          <Grid2 size={{ xs: 12, md: 6 }}>
            {imageSrc && (
              <Box
                sx={{
                  width: '100%',
                  height: '500px', // Фиксированная высота контейнера (можно настроить)
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  position: 'relative', // Для правильного позиционирования изображения
                }}
              >
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt={game.title || "Game image"}
                  style={{ 
                    width: '100%', // Растягиваем до ширины контейнера
                    height: '100%', // Растягиваем до высоты контейнера
                    objectFit: 'contain', // Сохраняем пропорции
                    transition: 'opacity 0.3s ease-in-out',
                    filter: imageSrc.startsWith('data:') ? 'blur(4px)' : 'none' // Размытие для base64
                  }}
                />
              </Box>
            )}
          </Grid2>

          <Grid2 size={{ xs: 12, md: 6 }}>
            {game.expand?.tags?.length && game.expand.tags?.length > 0 && (
              <Box>
                <TagDisplay
                  tags={game.expand.tags}
                  gameId={id as string}
                />
              </Box>
            )}

            <GameAdditionalInfo
              gameId={id as string}
              upvotes={game.upvotes}
            />
          </Grid2>
        </Grid2>

        <Box sx={{ mt: 1 }}>
          <Typography variant="h6" gutterBottom textAlign="center" sx={{ color: theme.palette.text.primary }}>
            Description
          </Typography>
          <div
            style={{ paddingLeft: 12, paddingRight: 12, color: theme.palette.text.primary }}
            dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
          />
        </Box>
      </Paper>

      <Box sx={{ mb: 3, mt: 3 }}>
        <GameContent game={game} />
      </Box>

      <Box sx={{}}>
        <SimpleComments game={game} />
      </Box>
    </Container>
  );
}