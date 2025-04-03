// src/components/CyoaPage/GameDetails.tsx

import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';

import { Container, Typography, Box, CircularProgress, Grid2, Paper } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import SimpleComments from './SimpleComments';
import GameAdditionalInfo from './GameAdditionalInfo';
import {
  Game,
  gamesCollection,
  GameRelationship,
  gameRelationshipsCollection,
  pb // Импортируем pb для доступа к authStore в SimpleComments (хотя он там напрямую не используется для этого запроса)
} from '../../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

export default function GameDetails() {
  const [game, setGame] = useState<Game | null>(null);
  const [relatedGames, setRelatedGames] = useState<GameRelationship[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [imageSrc, setImageSrc] = useState<string>('');
  const imgRef = useRef<HTMLImageElement>(null);
  const { id } = useParams<{ id: string }>();
  const theme = useTheme();
  const sanitizedDescription = useMemo(() => (game ? DOMPurify.sanitize(game.description) : ''), [game]);

  useEffect(() => {
    const fetchGameData = async () => {
      if (!id) {
          setLoading(false);
          console.error("Game ID is missing");
          return;
      };
      setLoading(true);
      setGame(null);
      setRelatedGames([]);

      try {
        // --- Оптимизированный запрос данных игры ---

        // Определяем имена полей для комментариев и пользователей (ЗАМЕНИТЕ НА ВАШИ РЕАЛЬНЫЕ ИМЕНА)
        const commentContentField = 'content'; // Поле с текстом комментария
        const userUsernameField = 'username'; // Поле с именем пользователя (логин)
        const userNameField = 'name';         // Поле с полным именем пользователя
        const userAvatarField = 'avatar';       // Поле с аватаром пользователя
        // --- --- --- --- --- --- --- --- --- --- ---

        const gamePromise = gamesCollection.getOne(id, {
          // Указываем минимально необходимые поля
          fields: `
            id,
            collectionId,
            description,
            title,
            image,
            image_base64,
            upvotes,
            cyoa_pages,
            iframe_url,
            img_or_link,
            cyoa_pages_preview,
            comments,
            tags,
            expand.authors_via_games.id,
            expand.authors_via_games.${userNameField},
            expand.tags.id,
            expand.tags.name,
            expand.tags.expand.tag_categories_via_tags.id,
            expand.tags.expand.tag_categories_via_tags.name,
            expand.comments.id,
            expand.comments.author,
            expand.comments.${commentContentField},
            expand.comments.children,
            expand.comments.expand.author.id, // Keep author ID for potential fetching later
            // Removed expansion of author details (username, name, avatar)
          `.replace(/\s/g, ''), // Убираем пробелы и переносы для API

          // Оставляем те же expand, чтобы Pocketbase знал, что разворачивать
          expand: `tags.tag_categories_via_tags,authors_via_games,comments.author(id,${userNameField},${userUsernameField},${userAvatarField})`, // Expand author but only fetch needed fields
        });

        // --- Запросы связей остаются без изменений ---
        const outgoingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `source_game = "${id}"`,
          expand: 'target_game(id,title)', // Оптимизация: Загружаем только ID и title связанной игры
        }).catch(err => {
            console.error("Failed to fetch outgoing relationships:", err);
            return [];
        });

        const incomingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `target_game = "${id}"`,
          expand: 'source_game(id,title)', // Оптимизация: Загружаем только ID и title связанной игры
        }).catch(err => {
            console.error("Failed to fetch incoming relationships:", err);
            return [];
        });
        // --- --- --- --- --- --- --- --- --- --- --- ---

        const [gameData, outgoingRelationships, incomingRelationships] = await Promise.all([
          gamePromise,
          outgoingRelationshipsPromise,
          incomingRelationshipsPromise,
        ]);

        // В gameData теперь только запрошенные поля + структура expand
        setGame(gameData);
        const validOutgoing = Array.isArray(outgoingRelationships) ? outgoingRelationships : [];
        const validIncoming = Array.isArray(incomingRelationships) ? incomingRelationships : [];
        setRelatedGames([...validOutgoing, ...validIncoming]);

      } catch (error) {
        console.error('Ошибка при загрузке основной информации игры:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchGameData();
  }, [id]);

  // Логика загрузки изображения остается без изменений
  useEffect(() => {
    if (!game) return;

    const collectionId = game.collectionId || '5kxdvx071c10s2t'; // collectionId теперь должен быть в game
    const imageURL = game.image
      ? `/api/files/${collectionId}/${game.id}/${game.image}?thumb=600x0` // Request 600px wide thumbnail
      : '';

    if (game.image_base64) {
      setImageSrc(
        game.image_base64.startsWith('data:')
          ? game.image_base64
          : `data:image/jpeg;base64,${game.image_base64}`
      );
    }

    if (imageURL && game.image_base64) {
      const img = new Image();
      img.onload = () => {
        setImageSrc(imageURL);
      };
      img.onerror = () => {
        console.error('Failed to load full image, keeping base64');
      };
      img.src = imageURL;
    } else if (imageURL && !game.image_base64) {
      setImageSrc(imageURL);
    } else if (!imageURL && !game.image_base64) {
        // Если нет ни base64, ни image, очищаем src
        setImageSrc('');
    }
  }, [game]);


  if (loading) return <CircularProgress />;
  // Проверяем, что game не просто null, а содержит необходимые поля (хотя бы title)
  if (!game?.title) return <Typography>Game not found or failed to load.</Typography>;

  // Рендеринг компонента остается без изменений
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
            flexWrap: 'wrap', // Добавим перенос для мобильных
          }}
        >
          <Typography variant="h4" component="h1" sx={{ mr: 1, color: theme.palette.text.primary, textAlign: 'center' }}>
            {game.title || 'Untitled Game'}
          </Typography>
          {/* Проверяем наличие expand и данных перед доступом */}
          {game.expand?.authors_via_games && game.expand.authors_via_games.length > 0 && (
            <Typography variant="subtitle1" sx={{ mb: '0.05em', color: theme.palette.text.primary, textAlign: 'center', width: '100%' }}>
              by {game.expand.authors_via_games.map((author) => author.name).join(', ')}
            </Typography>
          )}
        </Box>

        <Grid2 container spacing={3}>
          <Grid2 size={{ xs: 12, md: 6 }}>
            {imageSrc ? ( // Показываем контейнер только если есть imageSrc
              <Box
                sx={{
                  width: '100%',
                  height: '500px',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  position: 'relative',
                  bgcolor: imageSrc ? 'transparent' : theme.palette.grey[900] // Фон, если нет картинки
                }}
              >
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt={game.title || "Game image"}
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain',
                    transition: 'opacity 0.3s ease-in-out',
                    filter: imageSrc.startsWith('data:') ? 'blur(4px)' : 'none'
                  }}
                  // Обработка ошибки загрузки, если нужно
                  onError={(e) => {
                    console.error("Image failed to load:", e);
                    // Можно установить fallback src или скрыть img
                    // e.currentTarget.style.display = 'none';
                    // setImageSrc(''); // Или убрать src, чтобы не было иконки битого изображения
                  }}
                />
              </Box>
            ) : (
                 <Box sx={{ // Показываем плейсхолдер если нет imageSrc
                    width: '100%',
                    height: '500px',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    bgcolor: theme.palette.grey[900],
                    color: theme.palette.grey[700]
                 }}>
                    <Typography>No Image</Typography>
                 </Box>
            )}
          </Grid2>

          <Grid2 size={{ xs: 12, md: 6 }}>
            {/* Проверяем наличие expand и тегов перед рендерингом TagDisplay */}
            {game.expand?.tags && game.expand.tags.length > 0 && id && (
              <Box>
                <TagDisplay
                  tags={game.expand.tags}
                  gameId={id} // ID точно должен быть здесь, если game загружен
                />
              </Box>
            )}
            {id && ( // Убедимся, что ID есть перед рендерингом GameAdditionalInfo
                 <GameAdditionalInfo
                    gameId={id}
                    upvotes={game.upvotes} // upvotes теперь есть в game
                    relatedGames={relatedGames}
                />
            )}
          </Grid2>
        </Grid2>

        {/* Проверяем наличие description перед рендерингом */}
        {sanitizedDescription && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="h6" gutterBottom textAlign="center" sx={{ color: theme.palette.text.primary }}>
              Description
            </Typography>
            <div
              style={{ paddingLeft: 12, paddingRight: 12, color: theme.palette.text.primary }}
              dangerouslySetInnerHTML={{ __html: sanitizedDescription }}
            />
          </Box>
        )}
      </Paper>

      {/* Проверяем наличие game перед рендерингом GameContent */}
      {game && (
        <Box sx={{ mb: 3, mt: 3 }}>
          <GameContent game={game} />
        </Box>
      )}

      {/* Проверяем наличие game перед рендерингом SimpleComments */}
      {game && (
        <Box sx={{}}>
          <SimpleComments game={game} />
        </Box>
      )}
    </Container>
  );
}