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
  GameRelationship, // Тип теперь включает языки
  gameRelationshipsCollection, 
} from '../../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

 

export default function GameDetails() {
  const [game, setGame] = useState<Game | null>(null);
  // Массив будет содержать объекты GameRelationship с новыми полями языков
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






      const requestedFields = [
        // --- Поля основной записи 'game' ---
        'id',                            // Идентификатор игры (нужен почти всегда, для ключей, запросов)
        'collectionId',                  // ID коллекции (нужен для формирования URL файлов/изображений)
        'title',                         // Заголовок игры (отображается в GameDetails)
        'description',                   // Описание игры (отображается в GameDetails после sanitization)
        'image',                         // Имя файла основного изображения игры (для GameDetails)
        'image_base64',                  // Base64 превью основного изображения (для GameDetails, если используется)
        'upvotes',                       // Массив ID пользователей, лайкнувших игру (для GameAdditionalInfo, возможно можно заменить на upvotes_count)
        'img_or_link',                   // Тип контента: 'img' или 'link' (для GameContent)
        'iframe_url',                    // URL для iframe, если img_or_link === 'link' (для GameContent)
        'cyoa_pages',                    // Массив имен файлов страниц/изображений игры (для GameContent)
        'cyoa_pages_preview',            // Массив имен файлов превью страниц/изображений (для GameContent)
        // 'created',                    // Дата создания (если нужна где-то)
        // 'updated',                    // Дата обновления (если нужна где-то)
        // 'uploader',                   // ID пользователя, загрузившего игру (если нужно)
        // 'comments_count',             // Счетчик комментариев (если не нужны сами комменты сразу)
        // 'upvotes_count',              // Счетчик лайков (если не нужны ID лайкнувших)
      
        // --- Поля из 'expand.authors_via_games' (связь с авторами) ---
        'expand.authors_via_games.id',   // ID автора (может понадобиться для ключей или ссылок)
        'expand.authors_via_games.name', // Имя автора (отображается в GameDetails)
        // 'expand.authors_via_games.username', // Имя пользователя автора (если имя не задано)
      
        // --- Поля из 'expand.tags' (связь с тегами) ---
        'expand.tags.id',                // ID тега (нужен для ключей, возможно для TagDisplay)
        'expand.tags.name',              // Имя тега (отображается в TagDisplay)
        // 'expand.tags.description',    // Описание тега (если TagDisplay показывает подсказки)
      
        // --- Поля из 'expand.tags.expand.tag_categories_via_tags' (связь тега с его категориями) ---
        // Эти поля КЛЮЧЕВЫЕ для разделения тегов по категориям в TagDisplay
        'expand.tags.expand.tag_categories_via_tags.id',    // ID категории тега
        'expand.tags.expand.tag_categories_via_tags.name',  // Имя категории тега (для группировки/отображения в TagDisplay)
        // 'expand.tags.expand.tag_categories_via_tags.description', // Описание категории (если нужно)
      
        // --- Поля из 'expand.comments' (связь с комментариями) ---
        'expand.comments.id',            // ID комментария (для ключей, ответов, редактирования в SimpleComments)
        'expand.comments.author',        // ID автора комментария (для SimpleComments, проверки прав)
        'expand.comments.content',       // Текст комментария (для SimpleComments)
        'expand.comments.children',      // Массив ID дочерних комментариев (для построения дерева в SimpleComments)
        'expand.comments.parent',        // ID родительского комментария (для построения дерева в SimpleComments)
        // 'expand.comments.created',    // Дата создания комментария (если нужно отображать)
      
        // --- Поля из 'expand.comments.expand.author' (связь комментария с его автором) ---
        'expand.comments.expand.author.id',       // ID автора комментария (дублирует expand.comments.author, но может быть удобно)
        'expand.comments.expand.author.name',     // Имя автора комментария (для SimpleComments)
        'expand.comments.expand.author.username', // Имя пользователя автора (если имя не задано, для SimpleComments)
        'expand.comments.expand.author.avatar',   // Аватар автора комментария (для SimpleComments)
      
      ].join(','); // Собираем все строки в одну через запятую






      try {
        const gamePromise = gamesCollection.getOne(id, {
          expand: 'tags.tag_categories_via_tags,authors_via_games,comments.author', // Оставляем expand!
          fields: requestedFields
        });

        // Запрос связей. Новые поля (source_language, target_language)
        // будут получены автоматически, так как они часть самой записи relationship.





        
        const outgoingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `source_game = "${id}"`,
          expand: 'target_game', // Expand остается тем же
        }).catch(err => {
            console.error("Failed to fetch outgoing relationships:", err); 
            return [];
        });





        

        const incomingRelationshipsPromise = gameRelationshipsCollection.getFullList({
          filter: `target_game = "${id}"`,
          expand: 'source_game', // Expand остается тем же
        }).catch(err => {
            console.error("Failed to fetch incoming relationships:", err); 
            return [];
        });

        const [gameData, outgoingRelationships, incomingRelationships] = await Promise.all([
          gamePromise,
          outgoingRelationshipsPromise,
          incomingRelationshipsPromise,
        ]);

        setGame(gameData);
        const validOutgoing = Array.isArray(outgoingRelationships) ? outgoingRelationships : [];
        const validIncoming = Array.isArray(incomingRelationships) ? incomingRelationships : [];
        setRelatedGames([...validOutgoing, ...validIncoming]); // Здесь теперь будут объекты с языками

      } catch (error) {
        console.error('Ошибка при загрузке основной информации игры:', error); 
      } finally {
        setLoading(false);
      }
    };

    fetchGameData();
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
  if (!game) return <Typography>Game not found or failed to load.</Typography>;

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
              relatedGames={relatedGames} // Передаем связи с возможными языками
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