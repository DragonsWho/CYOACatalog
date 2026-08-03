// src/components/GameCard.tsx
import React, { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { Card, CardContent, Typography, Chip, Box, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game, MyBuiltGamesContext, TagCategoryContext, isFreshOriginal, isFreshBump, gameCanonicalKey } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';
import { useTheme } from '@mui/material/styles';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'; // Иконка для AI скора
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn'; // Бейдж «у меня есть билд»
import { cfImage, cfImageSrcSet } from '../utils/cfImage';
import { getTagColor, GOLD_ACCENT } from '../utils/tagColors';

// Design variables
export const CARD_ASPECT_RATIO = '133.33%';
// Candidate widths Cloudflare resizes the card cover to; the browser picks the
// smallest one >= its slot width × DPR. Capped at 480: a card is never shown wider
// than a full-width phone (~412px), and these are dense screenshots whose AVIF size
// explodes at higher widths (240=15KB, 480=55KB, 720=135KB). Capping keeps mobile
// retina at 480 (a touch soft on a darkened background card — unnoticeable) instead
// of pulling 135KB. The list length does NOT inflate the CF quota; only the widths
// real screens request do (~3-4 buckets). Desktop 5-up slot is ~235px → 240w.
const CARD_IMG_WIDTHS = [240, 360, 480];
// Lower quality than the detail page — the card cover is a decorative background sitting
// under a 50% dark overlay + blurred title/tag panels, so AVIF artefacts are invisible.
// q50 trims ~25% off (480px: 55→40KB) vs the detail page's q70.
const CARD_IMG_QUALITY = 50;
// Plain `src` fallback for the rare browser without srcset support; a member of the
// list above so it doesn't generate an extra transformation variant.
const CARD_IMG_WIDTH = 480;
// Real rendered card width per breakpoint, gaps/padding included (kept a hair under
// the measured size so the browser rounds down to the tighter variant, not up):
// 5 cols on lg ≈ 17vw, 3 on md ≈ 31vw, 2 on sm ≈ 47vw, 1 on xs ≈ 96vw.
// MUI breakpoints: sm 600 / md 900 / lg 1200 (see GameGrid.tsx).
const CARD_IMG_SIZES = '(max-width: 600px) 96vw, (max-width: 900px) 47vw, (max-width: 1200px) 31vw, 17vw';
const TAG_SECTION_HEIGHT = '54px';
const TAG_DISPLAY_LIMIT = 20;
export const OVERLAY_OPACITY = 0.5;
const TITLE_MARGIN_BOTTOM = 8;

const CATEGORY_ORDER = [
  'Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime',
  'Status', 'Genre', 'Setting', 'Tone', 'Extra', 'Kinks',
  'Visual Style', 'Custom',
];

const imageCache = new Map<string, string>();
const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface GameCardProps {
  game: Game;
  variant?: 'standard' | 'simplified';
  relevanceScore?: number; // Новый проп для процента совпадения
  // Первый ряд (настоящий LCP-кандидат): грузим обложку сразу + fetchpriority=high.
  priority?: boolean;
  // Карточки первого экрана ниже первого ряда: тоже без lazy/IntersectionObserver,
  // но с обычным приоритетом (не плодим высокоприоритетные запросы).
  eager?: boolean;
}

function GameCard({ game, variant = 'standard', relevanceScore, priority = false, eager = false }: GameCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  // Global tagId → categoryName map (replaces the per-game tags.tag_categories_via_tags
  // expand that catalog queries used to ship). Stable after the one-time global load.
  const categoryMap = useContext(TagCategoryContext);
  // Per-user "I built this" set from the builds registry (loaded once app-wide).
  // Context updates pierce the React.memo below, so the badge appears without
  // the game prop changing.
  const myBuiltGames = useContext(MyBuiltGamesContext);
  const hasMyBuild = myBuiltGames.has(game.id);

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const finalImageURL = useMemo(() => (
    game.image
      ? `/api/files/${collectionId}/${game.id}/${game.image}`
      : null
  ), [collectionId, game.id, game.image]);

  // Cloudflare-resized variant of the cover (AVIF/WebP) shown on the card.
  const transformedURL = useMemo(() => (
    finalImageURL ? cfImage(finalImageURL, { width: CARD_IMG_WIDTH, quality: CARD_IMG_QUALITY }) : null
  ), [finalImageURL]);

  const transformedSrcSet = useMemo(() => (
    finalImageURL ? cfImageSrcSet(finalImageURL, CARD_IMG_WIDTHS, CARD_IMG_QUALITY) : undefined
  ), [finalImageURL]);

  const initialSrc = useMemo(() => (
    game.image_base64
      ? game.image_base64.startsWith('data:')
        ? game.image_base64
        : `data:image/jpeg;base64,${game.image_base64}`
      : transparentPixel
  ), [game.image_base64]);

  const hasBase64 = initialSrc !== transparentPixel;
  // Full cover has finished loading → drop the blur over the base64 placeholder.
  const [finalImageDisplayed, setFinalImageDisplayed] = useState<boolean>(false);
  // Once the card scrolls near the viewport we start fetching the full cover.
  // First-screen cards (priority/eager) start in-view so the cover loads immediately.
  const loadNow = priority || eager;
  const [inView, setInView] = useState<boolean>(loadNow);
  // Serve the CF-transformed variant by default; flip to the untouched original if
  // the transform endpoint ever errors for this image (remembered across remounts).
  const [useTransformed, setUseTransformed] = useState<boolean>(
    () => !finalImageURL || imageCache.get(finalImageURL) !== 'original'
  );

  useEffect(() => {
    if (inView || !finalImageURL) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setInView(true);
          if (cardRef.current) observer.unobserve(cardRef.current);
        }
      },
      { rootMargin: '200px', threshold: 0.01 }
    );

    const currentCardRef = cardRef.current;
    if (currentCardRef) observer.observe(currentCardRef);

    return () => {
      if (currentCardRef) observer.unobserve(currentCardRef);
      observer.disconnect();
    };
  }, [inView, finalImageURL]);

  // The <img> shows the base64 blur until it scrolls into view, then loads the
  // responsive CF variant (or the raw original on fallback) via its own onLoad/onError.
  const showFull = inView && !!finalImageURL;
  const isShowingBase64 = hasBase64 && !finalImageDisplayed;
  const displaySrc = showFull
    ? (useTransformed ? (transformedURL ?? finalImageURL!) : finalImageURL!)
    : initialSrc;
  const displaySrcSet = showFull && useTransformed ? transformedSrcSet : undefined;
  const displaySizes = showFull && useTransformed ? CARD_IMG_SIZES : undefined;

  const sortedTags = useMemo(() => {
     const tagsToSort = game.expand?.tags ?? [];
     // Drop tags with no known category (same behavior as before, now via the global map).
     const validTags = tagsToSort.filter((tag) => tag?.id && categoryMap.has(tag.id));
     const goldSet = new Set(game.gold_tags ?? []);
     return CATEGORY_ORDER.flatMap((categoryName) => {
       // Gold tags first WITHIN their category, so a "gold" Kink (a late category)
       // still lands at the head of its group and survives the TAG_DISPLAY_LIMIT /
       // clip-on-overflow on the card. Order within each tier is otherwise stable.
       const inCat = validTags.filter((tag) => categoryMap.get(tag.id) === categoryName);
       const gold = inCat.filter((tag) => goldSet.has(tag.id));
       const rest = inCat.filter((tag) => !goldSet.has(tag.id));
       return [...gold, ...rest];
     }).slice(0, TAG_DISPLAY_LIMIT);
  }, [game.expand?.tags, game.gold_tags, categoryMap]);

  // "Original" — the author released their own game through /create. Driven by
  // the games.original_release flag (no longer a tag) and time-boxed: the "New"
  // badge auto-expires PINNED_ORIGINAL_DAYS after `created`, same window as the
  // front-page pin (see SearchPage), so it never lingers forever.
  const isOriginal = useMemo(() => isFreshOriginal(game), [game.original_release, game.created]);

  // "Bump!" — the game recently won the bump-roulette draw (or got a manual
  // bump) and is riding that boost on the front page. Same time-boxed pattern
  // as isFreshOriginal, keyed off bumped_at instead of created.
  const isBumped = useMemo(() => isFreshBump(game), [game.bumped_at, game.created]);

  const gameUpvoteCount = game.upvotes_count ?? 0;
  const gameCommentCount = game.comments_count ?? 0;
  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description ?? ''), [game.description]);

  return (
    <Link to={`/game/${gameCanonicalKey(game)}`} style={{ textDecoration: 'none' }}>
      <Card
        ref={cardRef}
        sx={{
          cursor: 'pointer',
          transition: 'transform 0.3s ease-in-out',
          '&:hover': { transform: 'scale(1.03)' },
          position: 'relative',
          overflow: 'hidden',
          backgroundColor: theme.palette.background.paper,
          paddingTop: CARD_ASPECT_RATIO,
          boxShadow: theme.shadows[3],
          height: 0,
        }}
      >
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>

          {!isShowingBase64 && (
            <Box
              sx={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                backgroundImage: theme.custom?.cardNoiseBackground,
                backgroundRepeat: 'repeat',
                backgroundSize: '300px 300px',
                zIndex: 0,
              }}
            />
          )}

          <img
            src={displaySrc}
            srcSet={displaySrcSet}
            sizes={displaySizes}
            alt={game.title || 'Game image'}
            loading={loadNow ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            onLoad={() => { if (showFull) setFinalImageDisplayed(true); }}
            onError={() => {
              if (showFull && useTransformed) {
                // CF transform failed for this image — fall back to the raw original.
                if (finalImageURL) imageCache.set(finalImageURL, 'original');
                setUseTransformed(false);
              } else {
                setFinalImageDisplayed(true);
              }
            }}
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              objectFit: 'cover',
              objectPosition: 'center',
              transition: 'opacity 0.3s ease-in-out, filter 0.3s ease-in-out',
              filter: isShowingBase64 ? 'blur(4px)' : 'none',
              display: displaySrc === transparentPixel ? 'none' : 'block',
              zIndex: 1,
            }}
          />

          <Box sx={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
              zIndex: 2,
          }} />

          {/* "You made a build for this game" badge (per-user, from the builds
              registry — never part of the shared catalog payload). Top-left so
              it can coexist with the relevance badge on search pages. A bare
              icon (no chip circle); the drop-shadow keeps it readable on any
              cover art. */}
          {hasMyBuild && (
            <Tooltip title="You made a build for this game" placement="top" arrow>
              <AssignmentTurnedInIcon
                sx={{
                  position: 'absolute',
                  top: 8,
                  left: 8,
                  zIndex: 20,
                  fontSize: 22,
                  color: '#fff',
                  filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.9)) drop-shadow(0 0 4px rgba(0,0,0,0.6))',
                }}
              />
            </Tooltip>
          )}

          {/* Relevance Score Badge */}
          {relevanceScore !== undefined && (
             <Box
               sx={{
                 position: 'absolute',
                 top: 10,
                 right: 10,
                 zIndex: 20,
               }}
             >
               <Chip
                 icon={<AutoAwesomeIcon style={{ fontSize: '0.9rem', color: '#fff' }} />}
                 label={`${Math.round(relevanceScore)}% Match`}
                 size="small"
                 sx={{
                    backgroundColor: relevanceScore > 80 ? 'rgba(46, 125, 50, 0.9)' : 'rgba(255, 143, 0, 0.9)',
                    color: '#fff',
                    fontWeight: 'bold',
                    backdropFilter: 'blur(4px)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                    border: '1px solid rgba(255,255,255,0.1)'
                 }}
               />
             </Box>
          )}

          {/* "Original release" badge — shares the top-right slot with the
              relevance chip; relevance wins on search pages. */}
          {isOriginal && relevanceScore === undefined && (
            <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 20 }}>
              <Chip
                label="Fresh"
                size="small"
                sx={{
                  backgroundColor: 'rgba(113, 206, 109, 0.95)', // #71ce6d — «fresh» green
                  // Dark-green text on the light green: ~7.5:1 contrast (WCAG AA/AAA),
                  // vs ~2:1 for white — white was unreadable on this shade.
                  color: '#0b3d12',
                  fontWeight: 'bold',
                  backdropFilter: 'blur(4px)',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.25)',
                }}
              />
            </Box>
          )}

          {/* "Bump!" badge — shares the same top-right slot; Fresh (original
              release) takes priority since a game can't be both at once
              (isFreshBump requires bumped_at to have moved past created). */}
          {isBumped && !isOriginal && relevanceScore === undefined && (
            <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 20 }}>
              <Chip
                label="Bump!"
                size="small"
                sx={{
                  // Same neutral black as an uncolored tag chip (tagColors.ts default)
                  // — a bump isn't a new game, so it shouldn't draw the eye like Fresh.
                  backgroundColor: 'rgba(0, 0, 0, 0.4)',
                  color: '#ffffff',
                  textShadow: '0px 1px 2px rgba(0,0,0,0.8)',
                  fontWeight: 'bold',
                  backdropFilter: 'blur(2px)',
                }}
              />
            </Box>
          )}

          <CardContent sx={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              display: 'flex', flexDirection: 'column',
              p: 0,
              boxSizing: 'border-box',
              '&:last-child': { paddingBottom: 0 },
              zIndex: 3
            }}
          >

            {/* Title Wrapper */}
             <Box sx={{
                 display: 'flex',
                 justifyContent: 'center',
                 width: '100%',
                 mt: { xs: '10px', md: '16px' },
                 mb: `${TITLE_MARGIN_BOTTOM}px`,
                 px: { xs: '10px', md: '16px' },
                 position: 'relative',
                 zIndex: 10,
             }}>
               <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>

                 <Box
                   sx={{
                     position: 'absolute',
                     top: '-15%', bottom: '-15%',
                     left: '-20%', right: '-20%',
                     zIndex: 0,
                     backdropFilter: 'blur(4px)',
                     borderRadius: '12px',
                     maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)',
                     WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 100%)',
                   }}
                 />

                 <Typography
                    variant="h3" component="div" align="center"
                    sx={{
                        position: 'relative',
                        zIndex: 1,
                        fontWeight: 'bold',
                        fontSize: { xs: '1.1rem', sm: '1.5rem', md: '1.8rem' },
                        color: '#ffffff',
                        textShadow: '0px 2px 4px rgba(0,0,0,1)',
                        ...(theme.custom?.cardTitle ?? {}),
                        maxWidth: '100%',
                        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    }}
                 >
                   {game.title || 'Untitled'}
                 </Typography>
               </Box>
             </Box>

            {variant === 'standard' && (
               <>
                 {/* Description Box Wrapper */}
                 <Box
                   sx={{
                     position: 'absolute',
                     top: { xs: '48%', md: '60%' },
                     left: { xs: '10px', md: '16px' },
                     right: { xs: '10px', md: '16px' },
                     bottom: { xs: '92px', md: '98px' },
                   }}
                 >
                   <Box
                     sx={{
                       position: 'absolute',
                       top: -10, left: -10, right: -10, bottom: -10,
                       zIndex: 0,
                       backdropFilter: 'blur(3px)',
                       maskImage: 'radial-gradient(ellipse at center, black 50%, transparent 90%)',
                       WebkitMaskImage: 'radial-gradient(ellipse at center, black 50%, transparent 90%)',
                     }}
                   />

                   <Box
                     sx={{
                       position: 'relative',
                       zIndex: 1,
                       height: '100%',
                       overflow: 'hidden',
                       fontSize: { xs: '0.75rem', sm: '0.9rem', md: '1rem' },
                       lineHeight: { xs: 1.3, md: 1.5 },
                       color: theme.palette.text.primary,
                       textShadow: '0px 2px 4px rgba(0,0,0,0.9), 0px 0px 2px rgba(0,0,0,1)',
                       ...(theme.custom?.cardText ?? {}),
                       maskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                       WebkitMaskImage: 'linear-gradient(to bottom, black 80%, transparent 100%)',
                     }}
                   >
                      <div dangerouslySetInnerHTML={{ __html: sanitizedDescription }} />
                   </Box>
                 </Box>

                 {/* Tags Box */}
                  <Box
                    sx={{
                      position: 'absolute',
                      bottom: { xs: '26px', md: '38px' },
                      left: { xs: '10px', md: '16px' },
                      right: { xs: '10px', md: '16px' },
                    }}
                  >
                    <Box sx={{
                        display: 'flex', flexWrap: 'wrap', gap: 0.5,
                        fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.8rem' },
                        maxHeight: { xs: '46px', md: TAG_SECTION_HEIGHT },
                        overflow: 'hidden',
                        alignContent: 'flex-start',
                      }}
                    >
                      {sortedTags.map((tag) => {
                        const category = categoryMap.get(tag.id);
                        const tagName = tag.name;
                        const chipColor = getTagColor(category, tagName);
                        const isGold = game.gold_tags?.includes(tag.id) ?? false;

                        return (
                          <Chip
                            key={tag.id}
                            label={tagName}
                            size="small"
                            sx={{
                                backgroundColor: chipColor,
                                color: isGold ? GOLD_ACCENT : '#ffffff',
                                textShadow: '0px 1px 2px rgba(0,0,0,0.8)',
                                backdropFilter: 'blur(2px)',
                                fontSize: { xs: '0.65rem', md: '0.8125rem' },
                                height: { xs: '20px', md: '24px' },
                                ...(isGold && {
                                  border: `1.5px solid ${GOLD_ACCENT}`,
                                  fontWeight: 700,
                                }),
                            }}
                          />
                        );
                      })}
                    </Box>
                  </Box>
               </>
             )}

            {/* Bottom Info */}
            <Box
               sx={{
                 display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 position: 'absolute',
                 bottom: { xs: '4px', md: '16px' },
                 left: { xs: '10px', md: '16px' },
                 right: { xs: '10px', md: '16px' },
               }}
             >
               <Typography
                 variant="body2"
                 sx={{
                   fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                   ...(theme.custom?.cardText ?? {}),
                   textShadow: '1px 1px 3px rgba(3, 3, 3, 1)',
                   whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                   maxWidth: '50%',
                   color: theme.palette.text.primary,
                 }}
               >
                 {game.expand?.authors?.[0]?.name || 'Anonymous'}
               </Typography>

               <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                 <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                 <Typography variant="body2" sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' }, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', mr: 1, }} >
                   {gameCommentCount}
                 </Typography>
                 <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: { xs: '0.8rem', sm: '1rem' }, mr: 0.5 }} />
                 <Typography variant="body2" sx={{ fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' }, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', }} >
                   {gameUpvoteCount}
                 </Typography>
               </Box>
             </Box>
           </CardContent>
        </Box>
      </Card>
    </Link>
  );
}

export default React.memo(GameCard, (prevProps, nextProps) => {
    return prevProps.game.id === nextProps.game.id &&
           prevProps.variant === nextProps.variant &&
           // title/description могут смениться при той же id (локализация каталога).
           prevProps.game.title === nextProps.game.title &&
           prevProps.game.description === nextProps.game.description &&
           prevProps.game.upvotes_count === nextProps.game.upvotes_count &&
           prevProps.game.comments_count === nextProps.game.comments_count &&
           prevProps.priority === nextProps.priority &&
           prevProps.eager === nextProps.eager &&
           prevProps.relevanceScore === nextProps.relevanceScore; // Не забываем сравнивать новый проп
});