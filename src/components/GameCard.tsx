import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, Typography, Chip, Box, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game, Tag } from '../pocketbase/pocketbase'; // Добавил импорт Tag
import DOMPurify from 'dompurify';

// Design variables
const CARD_ASPECT_RATIO = '133.33%';
const DESCRIPTION_TOP = '60%';
const TAG_SECTION_HEIGHT = '80px';
const TAG_DISPLAY_LIMIT = 12;
const OVERLAY_OPACITY = 0.5;

// Spacing variables
const CARD_PADDING = 16;
const TITLE_MARGIN_BOTTOM = 8;
const TAGS_MARGIN_TOP = 8;
const BOTTOM_INFO_MARGIN_TOP = 8;
const BOTTOM_INFO_MARGIN_BOTTOM = 0; // Не использовалось, но оставлю

const CATEGORY_ORDER = [
  'Rating',
  'Interactivity',
  'POV',
  'Player Sexual Role',
  'Playtime',
  'Status',
  'Genre',
  'Setting',
  'Tone',
  'Extra',
  'Kinks',
];

const CATEGORY_COLORS: Record<string, string> = { // Уточнил тип
  Rating: 'rgba(0, 0, 0, 0.4)',
  Interactivity: 'rgba(0, 0, 0, 0.4)',
  POV: 'rgba(0, 0, 0, 0.4)',
  'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
  Playtime: 'rgba(255, 140, 0, 0.4)',
  Status: 'rgba(0, 0, 0, 0.4)',
  Genre: 'rgba(138, 43, 226, 0.4)',
  Setting: 'rgba(0, 0, 0, 0.4)',
  Tone: 'rgba(0, 0, 0, 0.4)',
  Extra: 'rgba(0, 0, 0, 0.4)',
  Kinks: 'rgba(255, 69, 0, 0.4)',
};

// Global image cache
const imageCache = new Map<string, string>();

interface GameCardProps {
  game: Game;
  variant?: 'standard' | 'simplified';
}

function GameCard({ game, variant = 'standard' }: GameCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Убрал логи монтирования/размонтирования, можно вернуть при отладке
  // useEffect(() => { ... }, [game.id]);

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const imageURL = game.image
    ? `/api/files/${collectionId}/${game.id}/${game.image}`
    : 'public/placeholder.jpg';

  const [imageSrc, setImageSrc] = useState<string>(
    game.image_base64
      ? game.image_base64.startsWith('data:')
        ? game.image_base64
        : `data:image/jpeg;base64,${game.image_base64}`
      : imageURL
  );
  const [isBase64, setIsBase64] = useState<boolean>(!!game.image_base64);

  const loadImage = useCallback(() => {
    if (!isBase64 && imageSrc === imageURL) return;

    if (imageCache.has(imageURL)) {
      setImageSrc(imageCache.get(imageURL) as string);
      setIsBase64(false);
    } else {
      setImageSrc(imageURL);
      setIsBase64(false);
    }
  }, [imageURL, imageSrc, isBase64]); // Убрал game.id, т.к. imageURL его содержит

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadImage();
          // Отключаем observer после первой загрузки
          if (cardRef.current) observer.unobserve(cardRef.current);
        }
      },
      { rootMargin: '200px', threshold: 0.01 }
    );

    const currentCardRef = cardRef.current;
    if (currentCardRef) {
      observer.observe(currentCardRef);
    }

    return () => {
      if (currentCardRef) observer.unobserve(currentCardRef);
      observer.disconnect(); // Добавил disconnect для чистоты
    };
  }, [loadImage]); // Зависимость только от loadImage

  // Убрал кэширование в imageCache через onload, т.к. оно дублировалось в loadImage
  // useEffect(() => { ... }, [imageSrc, imageURL, game.id]);

  const sortedTags = useMemo(() => {
     // Используем расширенные теги, если они есть, или пустой массив
     const tagsToSort = game.expand?.tags ?? [];
     // Убедимся, что каждый тег имеет expand.tag_categories_via_tags
     const validTags = tagsToSort.filter(tag => tag.expand?.tag_categories_via_tags?.[0]?.name);

     return CATEGORY_ORDER.flatMap((categoryName) =>
       validTags.filter((tag) => tag.expand!.tag_categories_via_tags![0].name === categoryName)
     ).slice(0, TAG_DISPLAY_LIMIT);
  }, [game.expand?.tags]); // Зависимость от game.expand.tags

  // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
  // Используем upvotes_count, если оно есть, иначе 0
  const gameUpvoteCount = game.upvotes_count ?? 0;
  // --- КОНЕЦ ИЗМЕНЕНИЯ ---

  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description ?? ''), [game.description]); // Добавил ?? ''

  // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
  // Используем длину массива comments, если он есть, иначе 0
  const gameCommentCount = Array.isArray(game.comments) ? game.comments.length : 0;
  // --- КОНЕЦ ИЗМЕНЕНИЯ ---

  return (
    <Link to={`/game/${game.id}`} style={{ textDecoration: 'none' }}>
      <Card
        ref={cardRef}
        sx={{
          cursor: 'pointer',
          transition: '0.3s',
          '&:hover': { transform: 'scale(1.03)' },
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: theme.palette.background.paper,
          paddingTop: CARD_ASPECT_RATIO, // Используем padding-top для соотношения сторон
          boxShadow: theme.shadows[3],
          height: 0, // Необходимо для работы paddingTop
        }}
      >
        {/* Абсолютно позиционированный контейнер для всего контента */}
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
          <img
            ref={imgRef}
            src={imageSrc}
            alt={game.title || 'Game image'}
            loading="lazy" // Добавил lazy loading
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              transition: 'opacity 0.3s ease-in-out, filter 0.3s ease-in-out', // Добавил filter в transition
              filter: isBase64 ? 'blur(4px)' : 'none',
            }}
          />
          {/* Оверлей */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
            }}
          />
          {/* Контент карточки */}
          <CardContent
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between', // Распределяем контент
              p: `${CARD_PADDING}px`,
              boxSizing: 'border-box',
              // Убираем padding-bottom: 0, т.к. justify-content распределяет
              '&:last-child': { paddingBottom: `${CARD_PADDING}px` },
            }}
          >
            {/* Верхняя часть: Заголовок */}
            <Typography
              variant="h3"
              component="div"
              align="center"
              sx={{
                fontWeight: 'bold',
                fontSize: { xs: '1.2rem', sm: '1.5rem', md: '1.8rem' },
                // @ts-expect-error custom theme property
                ...theme.custom.cardTitle,
                mb: `${TITLE_MARGIN_BOTTOM}px`,
                 // Добавим ограничение по высоте и обрезку текста
                 overflow: 'hidden',
                 textOverflow: 'ellipsis',
                 display: '-webkit-box',
                 WebkitLineClamp: 2, // Ограничение в 2 строки
                 WebkitBoxOrient: 'vertical',
              }}
            >
              {game.title || 'Untitled'}
            </Typography>

            {/* Средняя часть: Описание и Теги (только для standard) */}
            {variant === 'standard' && (
              <Box sx={{ flexGrow: 1, overflow: 'hidden', position: 'relative' /* Для позиционирования тегов снизу */ }}>
                {/* Описание (позиционируется абсолютно внутри среднего блока) */}
                <Box
                  sx={{
                    position: 'absolute',
                    top: 0, // Начинается сверху среднего блока
                    left: 0,
                    right: 0,
                    bottom: `calc(${TAG_SECTION_HEIGHT} + ${TAGS_MARGIN_TOP}px)`, // Оставляет место для тегов снизу
                    overflow: 'hidden',
                    fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' },
                    maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)', // Более плавный градиент
                    WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                    // @ts-expect-error custom theme property
                    ...theme.custom.cardText,
                     // Убираем лишние стили позиционирования отсюда
                  }}
                >
                  <div dangerouslySetInnerHTML={{ __html: sanitizedDescription }} />
                </Box>

                {/* Теги (позиционируются абсолютно снизу среднего блока) */}
                <Box
                  sx={{
                    position: 'absolute',
                    bottom: 0, // Прижаты к низу среднего блока
                    left: 0,
                    right: 0,
                    mt: `${TAGS_MARGIN_TOP}px`, // Отступ сверху от описания
                    maxHeight: TAG_SECTION_HEIGHT,
                    overflow: 'hidden',
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 0.5,
                      fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.8rem' }, // Убрал maxHeight и overflow отсюда
                    }}
                  >
                    {sortedTags.map((tag) => { // Имя переменной изменено для ясности
                      const category = tag.expand?.tag_categories_via_tags?.[0].name;
                      return (
                        <Chip
                          key={tag.id} // Используем tag.id как ключ
                          label={tag.name}
                          size="small"
                          sx={{
                            backgroundColor: `${
                              CATEGORY_COLORS[category ?? ''] || 'transparent' // Добавил ?? ''
                            }`,
                            color: theme.palette.text.primary,
                            textShadow: '1px 1px 2px rgba(0,0,0,0.5)',
                          }}
                        />
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            )}

            {/* Нижняя часть: Автор и Счетчики */}
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                 // Убрали position: absolute, т.к. используем flex для основного CardContent
                 // Добавим отступ сверху, если нет описания/тегов
                 mt: variant !== 'standard' ? 'auto' : `${BOTTOM_INFO_MARGIN_TOP}px`,
              }}
            >
              <Typography
                variant="body2"
                sx={{
                  fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                  // @ts-expect-error custom theme property
                  ...theme.custom.cardText,
                  textShadow: '1px 1px 3px rgba(3, 3, 3, 1)',
                   // Добавим обрезку текста для автора
                   whiteSpace: 'nowrap',
                   overflow: 'hidden',
                   textOverflow: 'ellipsis',
                   maxWidth: '50%', // Ограничим ширину имени автора
                }}
              >
                {game.expand?.authors_via_games?.[0]?.name || 'Anonymous'}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 /* Предотвращаем сжатие счетчиков */ }}>
                <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                    color: 'white',
                    fontWeight: 'bold',
                    textShadow: '1px 1px 2px rgba(3,3,3,1)',
                    mr: 1,
                  }}
                >
                  {gameCommentCount} {/* Используем счетчик комментариев */}
                </Typography>
                <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                    color: 'white',
                    fontWeight: 'bold',
                    textShadow: '1px 1px 2px rgba(3,3,3,1)',
                  }}
                >
                  {gameUpvoteCount} {/* Используем счетчик лайков */}
                </Typography>
              </Box>
            </Box>
          </CardContent>
        </Box>
      </Card>
    </Link>
  );
}

// Мемоизация остается без изменений
export default React.memo(GameCard, (prevProps, nextProps) => {
    // Сравниваем только ID, вариант и счетчик лайков (как основное изменяемое поле)
    return prevProps.game.id === nextProps.game.id &&
           prevProps.variant === nextProps.variant &&
           prevProps.game.upvotes_count === nextProps.game.upvotes_count &&
           (prevProps.game.comments?.length ?? 0) === (nextProps.game.comments?.length ?? 0); // Добавил сравнение комментов
});