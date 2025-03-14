// src/components/CyoaPage/GameDetails.tsx

import { useState, useEffect, useMemo } from 'react';
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
  const [imageSrc, setImageSrc] = useState<string>(''); // Для хранения URL изображения
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
        
        // Изначально не устанавливаем изображение, это будет сделано во втором useEffect
      } catch (error) {
        console.error('Ошибка при загрузке игры:', error);
        setLoading(false);
      }
    })();
  }, [id]);

  // Управление загрузкой AVIF и WebP изображений
  useEffect(() => {
    if (!game) return;
    
    const collectionId = game.collectionId || '5kxdvx071c10s2t';
    
    // Формируем URL для AVIF изображения
    const avifURL = game.image_avif 
      ? `/api/files/${collectionId}/${game.id}/${game.image_avif}` 
      : '';
      
    // Формируем URL для WebP изображения
    const webpURL = game.image 
      ? `/api/files/${collectionId}/${game.id}/${game.image}` 
      : '';
    
    // Проверяем наличие AVIF версии
    if (avifURL) {
      // Сначала пытаемся загрузить AVIF
      console.log("Attempting to load AVIF first:", avifURL);
      
      // Создаем и загружаем AVIF изображение
      const avifImg = new Image();
      avifImg.onload = () => {
        console.log("AVIF loaded, displaying it");
        setImageSrc(avifURL); // Устанавливаем AVIF для отображения
        
        // Затем загружаем WebP для последующей замены
        if (webpURL) {
          console.log("Now loading WebP for better quality:", webpURL);
          const webpImg = new Image();
          webpImg.onload = () => {
            console.log("WebP loaded, replacing AVIF");
            setImageSrc(webpURL); // Заменяем на WebP для лучшего качества
          };
          webpImg.src = webpURL;
        }
      };
      
      avifImg.onerror = () => {
        console.error("Failed to load AVIF, falling back to WebP");
        if (webpURL) {
          setImageSrc(webpURL); // Если AVIF не загрузился, используем WebP
        }
      };
      
      avifImg.src = avifURL; // Запускаем загрузку AVIF
    } else if (webpURL) {
      // Если нет AVIF, сразу используем WebP
      console.log("No AVIF available, using WebP directly:", webpURL);
      setImageSrc(webpURL);
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
                  height: '100%',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <img
                  src={imageSrc}
                  alt={game.title || "Game image"}
                  style={{ 
                    maxWidth: '60%', 
                    height: 'auto', 
                    objectFit: 'contain',
                    transition: 'opacity 0.3s ease-in-out' // Плавный переход
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