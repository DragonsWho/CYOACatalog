import React, { useState, useEffect, useMemo, useRef, useContext } from 'react';
import { Card, CardContent, Typography, Chip, Box, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game, MyBuiltGamesContext, TagCategoryContext, isFreshOriginal, isFreshBump, gameCanonicalKey } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';
import { useTheme } from '@mui/material/styles';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import { cfImage, cfImageSrcSet } from '../utils/cfImage';
import { getTagColor, GOLD_ACCENT } from '../utils/tagColors';

export const CARD_ASPECT_RATIO = '133.33%';
// Cloudflare resize widths for the card cover; the browser picks the smallest ≥ slot width × DPR.
// Capped at 480: a card is never wider than a full-width phone (~412px), and dense screenshot AVIFs
// explode at higher widths (240=15KB, 480=55KB, 720=135KB). List length doesn't inflate the CF
// quota; only widths actually requested do (~3–4 buckets). Desktop 5-up slot ≈ 235px → 240w.
const CARD_IMG_WIDTHS = [240, 360, 480];
// Lower quality than the detail page: the card cover is a background under a 50% dark overlay +
// blurred panels, AVIF artifacts are invisible. q50 trims ~25% vs the detail page's q70.
const CARD_IMG_QUALITY = 50;
// Plain `src` fallback, a member of the list above so it doesn't create an extra transformation
// variant.
const CARD_IMG_WIDTH = 480;
// Real rendered card width per breakpoint incl. gaps (a hair under measured so the browser rounds
// down): 5 cols lg ≈ 17vw, 3 md ≈ 31vw, 2 sm ≈ 47vw, 1 xs ≈ 96vw. MUI breakpoints: sm 600 / md 900
// / lg 1200 (GameGrid.tsx).
const CARD_IMG_SIZES = '(max-width: 600px) 96vw, (max-width: 900px) 47vw, (max-width: 1200px) 31vw, 17vw';
const TAG_DISPLAY_LIMIT = 20;
export const OVERLAY_OPACITY = 0.5;

// Sizes inside the card follow TWO different laws — don't mix them (burned twice).
// 1) GEOMETRY (where description/tags/caption boxes sit) follows the CARD: percentages of height
// (height is locked to width via CARD_ASPECT_RATIO). The first version used px per window
// breakpoint and the author caption sat 4px from the edge on phones vs 16px on desktop.
// 2) TEXT SIZE follows the SCREEN, not the card. Trap: window breakpoint and card width are
// INVERSELY related (`xs` = one full-width column = the LARGEST card, 342×456 on phone vs 266×355
// in 5-col desktop), so `xs` had the smallest fonts. But scaling by card width (cqw) gives "a
// desktop card under a magnifier" (37px title, five words per line). Readability is per screen: on
// phones text must be SMALLER than desktop though the card is larger. So fonts per breakpoint,
// stretched by vw within a breakpoint (half the coefficient on sm: the card is half the window).
const CARD_PAD = { xs: 'clamp(10px, 3vw, 16px)', sm: 'clamp(10px, 1.5vw, 16px)', md: '16px' };
const CARD_TITLE_FONT = { xs: 'clamp(1.25rem, 6vw, 1.9rem)', sm: 'clamp(1.25rem, 3vw, 1.9rem)', md: '1.8rem' };
const CARD_TEXT_FONT = { xs: 'clamp(0.82rem, 3.6vw, 1.05rem)', sm: 'clamp(0.82rem, 1.8vw, 1.05rem)', md: '1rem' };
const CARD_META_FONT = { xs: 'clamp(0.78rem, 3.4vw, 1rem)', sm: 'clamp(0.78rem, 1.7vw, 1rem)', md: '0.9rem' };
const CARD_META_ICON = { xs: 'clamp(0.85rem, 3.7vw, 1.05rem)', sm: 'clamp(0.85rem, 1.85vw, 1.05rem)', md: '1rem' };
const CARD_CHIP_FONT = { xs: 'clamp(0.7rem, 3vw, 0.85rem)', sm: 'clamp(0.7rem, 1.5vw, 0.85rem)', md: '0.8125rem' };
const CARD_CHIP_HEIGHT = { xs: 'clamp(20px, 5.6vw, 26px)', sm: 'clamp(20px, 2.8vw, 26px)', md: '24px' };
const TAG_SECTION_HEIGHT = { xs: 'clamp(44px, 12.5vw, 58px)', sm: 'clamp(44px, 6.25vw, 58px)', md: '54px' };
const TITLE_MARGIN_BOTTOM = { xs: '6px', md: '8px' };
// Bottom offsets hold TEXT (tag row, author caption), so they use the font's unit per breakpoint:
// xs/sm fonts scale by vw ⇒ offsets in % of card height; md fonts are fixed px ⇒ offsets in px.
// Percentages on desktop were a bug: computed from the 5-col card 266×355, at 3 columns (~479×638)
// 27.6% becomes 176px instead of 98px — description shrinks to three lines and the caption drifts
// twice as far from the bottom.
const DESC_BOX_TOP = { xs: '48%', md: '60%' };
const DESC_BOX_BOTTOM = { xs: '20.5%', md: '98px' };
const TAG_BOX_BOTTOM = { xs: '8.3%', md: '38px' };
const META_BOX_BOTTOM = { xs: '2.6%', md: '16px' };

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
  relevanceScore?: number;
  // First row (real LCP candidate): load the cover immediately + fetchpriority=high.
  priority?: boolean;
  // First-screen cards below row one: no lazy/IntersectionObserver either, but normal priority
  // (don't multiply high-priority requests).
  eager?: boolean;
}

function GameCard({ game, variant = 'standard', relevanceScore, priority = false, eager = false }: GameCardProps) {
  const theme = useTheme();
  const cardRef = useRef<HTMLDivElement>(null);
  // Global tagId → categoryName map (replaces the per-game tags.tag_categories_via_tags expand
  // catalog queries used to ship). Stable after the one-time load.
  const categoryMap = useContext(TagCategoryContext);
  // Per-user "I built this" set from the builds registry (loaded once app-wide). Context updates
  // pierce React.memo, so the badge appears without the game prop changing.
  const myBuiltGames = useContext(MyBuiltGamesContext);
  const hasMyBuild = myBuiltGames.has(game.id);

  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  const finalImageURL = useMemo(() => (
    game.image
      ? `/api/files/${collectionId}/${game.id}/${game.image}`
      : null
  ), [collectionId, game.id, game.image]);

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
  const [finalImageDisplayed, setFinalImageDisplayed] = useState<boolean>(false);
  const [fullLoaded, setFullLoaded] = useState<boolean>(false);
  // Start fetching the full cover when the card nears the viewport; first-screen cards start in
  // view.
  const loadNow = priority || eager;
  const [inView, setInView] = useState<boolean>(loadNow);
  // CF-transformed variant by default; flip to the original if the transform errors for this image
  // (remembered across remounts).
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

  const showFull = inView && !!finalImageURL;
  const isShowingBase64 = hasBase64 && !finalImageDisplayed;
  const displaySrc = showFull
    ? (useTransformed ? (transformedURL ?? finalImageURL!) : finalImageURL!)
    : initialSrc;
  const displaySrcSet = showFull && useTransformed ? transformedSrcSet : undefined;
  const displaySizes = showFull && useTransformed ? CARD_IMG_SIZES : undefined;

  const sortedTags = useMemo(() => {
     const tagsToSort = game.expand?.tags ?? [];
     const validTags = tagsToSort.filter((tag) => tag?.id && categoryMap.has(tag.id));
     const goldSet = new Set(game.gold_tags ?? []);
     return CATEGORY_ORDER.flatMap((categoryName) => {
       // Gold tags first WITHIN their category, so a gold Kink (late category) lands at its group
       // head and survives TAG_DISPLAY_LIMIT / overflow clipping.
       const inCat = validTags.filter((tag) => categoryMap.get(tag.id) === categoryName);
       const gold = inCat.filter((tag) => goldSet.has(tag.id));
       const rest = inCat.filter((tag) => !goldSet.has(tag.id));
       return [...gold, ...rest];
     }).slice(0, TAG_DISPLAY_LIMIT);
  }, [game.expand?.tags, game.gold_tags, categoryMap]);

  // "Original" — the author released their own game via /create. Driven by games.original_release
  // (no longer a tag) and time-boxed: the badge expires PINNED_ORIGINAL_DAYS after `created`, same
  // window as the front-page pin.
  const isOriginal = useMemo(() => isFreshOriginal(game), [game.original_release, game.created]);

  // "Bump!" — recently won the bump roulette (or manual bump). Same time-boxed pattern keyed off
  // bumped_at.
  const isBumped = useMemo(() => isFreshBump(game), [game.bumped_at, game.created]);

  const gameUpvoteCount = game.upvotes_count ?? 0;
  const gameCommentCount = game.comments_count ?? 0;
  // DOMPurify builds a real DOM via document.createElement and walks it — the simplified card
  // doesn't render the description, so don't parse it.
  const sanitizedDescription = useMemo(
    () => (variant === 'standard' ? DOMPurify.sanitize(game.description ?? '') : ''),
    [game.description, variant],
  );

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
          // The feed isn't virtualized: after a few infinite-scroll pages hundreds of cards sit in
          // the DOM, each with backdrop-filter glass panels (.cc-glass, index.css) recomputed every
          // scroll frame — jank on weak phones. content-visibility skips offscreen cards entirely,
          // blurs included. Clipping is safe: the card is
          // overflow:hidden, children are absolutely positioned, hover-scale applies to the
          // container itself.
          contentVisibility: 'auto',
          backgroundColor: theme.palette.background.paper,
          paddingTop: CARD_ASPECT_RATIO,
          boxShadow: theme.shadows[3],
          height: 0,
        }}
      >
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>

          {!isShowingBase64 && (
            <Box
              className="cc-card-noise"
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

          {/* Blur placeholder stays underneath until the full cover has faded in on top. It used to
              be swapped out the moment the full URL was assigned, so first-screen cards (which
              request the full cover immediately) sat empty until it arrived. */}
          {isShowingBase64 && (
            <img
              src={initialSrc}
              alt=""
              aria-hidden
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
                filter: 'blur(4px)',
                zIndex: 1,
              }}
            />
          )}

          {showFull && (
            <img
              src={displaySrc}
              srcSet={displaySrcSet}
              sizes={displaySizes}
              alt={game.title || 'Game image'}
              loading={loadNow ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : 'auto'}
              onLoad={() => setFullLoaded(true)}
              onTransitionEnd={() => { if (fullLoaded) setFinalImageDisplayed(true); }}
              onError={() => {
                if (useTransformed) {
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
                // No placeholder → nothing to fade over, show as it streams in.
                opacity: fullLoaded || !hasBase64 ? 1 : 0,
                transition: 'opacity 0.3s ease-in-out',
                zIndex: 1,
              }}
            />
          )}

          <Box sx={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
              zIndex: 2,
          }} />

          {/*
            "You made a build" badge (per-user from the builds registry — never part of the shared
            catalog payload). Top-left to coexist with the relevance badge. Bare icon; drop-shadow
            keeps it readable on any cover.
          */}
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
                    boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                    border: '1px solid rgba(255,255,255,0.1)'
                 }}
               />
             </Box>
          )}

          {/*
            "Original release" badge shares the top-right slot with the relevance chip; relevance
            wins on search pages.
          */}
          {isOriginal && relevanceScore === undefined && (
            <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 20 }}>
              <Chip
                label="Fresh"
                size="small"
                sx={{
                  backgroundColor: 'rgba(113, 206, 109, 0.95)',
                  // Dark-green text on light green: ~7.5:1 contrast; white was ~2:1, unreadable.
                  color: '#0b3d12',
                  fontWeight: 'bold',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
                  border: '1px solid rgba(255,255,255,0.25)',
                }}
              />
            </Box>
          )}

          {/*
            "Bump!" shares the top-right slot; Fresh takes priority (a game can't be both:
            isFreshBump requires bumped_at past created).
          */}
          {isBumped && !isOriginal && relevanceScore === undefined && (
            <Box sx={{ position: 'absolute', top: 10, right: 10, zIndex: 20 }}>
              <Chip
                label="Bump!"
                size="small"
                sx={{
                  // Same neutral black as an uncolored tag chip (tagColors.ts default): a bump
                  // isn't a new game, don't draw the eye like Fresh.
                  backgroundColor: 'rgba(0, 0, 0, 0.4)',
                  color: '#ffffff',
                  textShadow: '0px 1px 2px rgba(0,0,0,0.8)',
                  fontWeight: 'bold',
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

             <Box sx={{
                 display: 'flex',
                 justifyContent: 'center',
                 width: '100%',
                 mt: CARD_PAD,
                 mb: TITLE_MARGIN_BOTTOM,
                 px: CARD_PAD,
                 position: 'relative',
                 zIndex: 10,
             }}>
               <Box sx={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>

                 <Box
                   className="cc-glass"
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
                        fontSize: CARD_TITLE_FONT,
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
                 <Box
                   sx={{
                     position: 'absolute',
                     top: DESC_BOX_TOP,
                     left: CARD_PAD,
                     right: CARD_PAD,
                     bottom: DESC_BOX_BOTTOM,
                   }}
                 >
                   <Box
                     className="cc-glass"
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
                       fontSize: CARD_TEXT_FONT,
                       lineHeight: 1.5,
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

                  <Box
                    sx={{
                      position: 'absolute',
                      bottom: TAG_BOX_BOTTOM,
                      left: CARD_PAD,
                      right: CARD_PAD,
                    }}
                  >
                    <Box sx={{
                        display: 'flex', flexWrap: 'wrap', gap: 0.5,
                        fontSize: CARD_CHIP_FONT,
                        maxHeight: TAG_SECTION_HEIGHT,
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
                                fontSize: CARD_CHIP_FONT,
                                height: CARD_CHIP_HEIGHT,
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

            <Box
               sx={{
                 display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 position: 'absolute',
                 bottom: META_BOX_BOTTOM,
                 left: CARD_PAD,
                 right: CARD_PAD,
               }}
             >
               <Typography
                 variant="body2"
                 sx={{
                   fontSize: CARD_META_FONT,
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
                 <CommentIcon sx={{ color: theme.palette.secondary.main, fontSize: CARD_META_ICON, mr: 0.5 }} />
                 <Typography variant="body2" sx={{ fontSize: CARD_META_FONT, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', mr: 1, }} >
                   {gameCommentCount}
                 </Typography>
                 <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: CARD_META_ICON, mr: 0.5 }} />
                 <Typography variant="body2" sx={{ fontSize: CARD_META_FONT, color: 'white', fontWeight: 'bold', textShadow: '1px 1px 2px rgba(3,3,3,1)', }} >
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
           // title/description may change under the same id (catalog localization).
           prevProps.game.title === nextProps.game.title &&
           prevProps.game.description === nextProps.game.description &&
           prevProps.game.upvotes_count === nextProps.game.upvotes_count &&
           prevProps.game.comments_count === nextProps.game.comments_count &&
           prevProps.priority === nextProps.priority &&
           prevProps.eager === nextProps.eager &&
           prevProps.relevanceScore === nextProps.relevanceScore;
});