// src/components/GameCard.tsx
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Card, CardContent, Typography, Chip, Box } from '@mui/material';
import { Link } from 'react-router-dom';
import FavoriteIcon from '@mui/icons-material/Favorite';
import CommentIcon from '@mui/icons-material/Comment';
import { Game } from '../pocketbase/pocketbase';
import DOMPurify from 'dompurify';

import { useTheme } from '@mui/material/styles';



// Design variables - Constants for styling and layout
export const CARD_ASPECT_RATIO = '133.33%'; // Defines the card height relative to its width (4:3)
 
const DESCRIPTION_TOP = '60%'; // Vertical starting point for the description text
const TAG_SECTION_HEIGHT = '80px'; // Maximum height for the tags area
const TAG_DISPLAY_LIMIT = 12; // Max number of tags to show
const OVERLAY_OPACITY = 0.5; // Opacity of the dark overlay on the image

// Spacing variables - Used for positioning elements inside the card
const CARD_PADDING = 16; // General padding inside the card edges
const TITLE_MARGIN_BOTTOM = 8; // Space below the title
const BOTTOM_INFO_MARGIN_TOP = 8; // Space above the bottom info row (author/stats)
const BOTTOM_INFO_MARGIN_BOTTOM = 0; // Space below the bottom info row (kept for calculation consistency)

// Order in which tag categories should ideally appear
const CATEGORY_ORDER = [
  'Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime',
  'Status', 'Genre', 'Setting', 'Tone', 'Extra', 'Kinks',
];

// Background colors for tags based on their category
const CATEGORY_COLORS: Record<string, string> = {
  Rating: 'rgba(0, 0, 0, 0.4)', Interactivity: 'rgba(0, 0, 0, 0.4)',
  POV: 'rgba(0, 0, 0, 0.4)', 'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
  Playtime: 'rgba(255, 140, 0, 0.4)', Status: 'rgba(0, 0, 0, 0.4)',
  Genre: 'rgba(138, 43, 226, 0.4)', Setting: 'rgba(0, 0, 0, 0.4)',
  Tone: 'rgba(0, 0, 0, 0.4)', Extra: 'rgba(0, 0, 0, 0.4)',
  Kinks: 'rgba(255, 69, 0, 0.4)', // More distinct color for Kinks
  // Add more categories and colors as needed
};

// Simple in-memory cache for successfully loaded image URLs
const imageCache = new Map<string, string>();
// A transparent 1x1 GIF used as a placeholder source for the img tag when no base64 is available initially
const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

interface GameCardProps {
  game: Game; // The game data object
  variant?: 'standard' | 'simplified'; // Card variant, affects content display
}

// The GameCard component definition
function GameCard({ game, variant = 'standard' }: GameCardProps) {
  const theme = useTheme(); // Access the MUI theme object
  const cardRef = useRef<HTMLDivElement>(null); // Ref for the main card element (used by IntersectionObserver)

  // Get collection ID or default (ensure default matches your PocketBase setup)
  const collectionId = game.collectionId || '5kxdvx071c10s2t';

  // Calculate the final target image URL using useMemo for optimization
  // Returns the API path or null if no game.image exists
  const finalImageURL = useMemo(() => (
    game.image
      ? `/api/files/${collectionId}/${game.id}/${game.image}`
      : null // No placeholder file path, will use noise background instead
  ), [collectionId, game.id, game.image]);

  // Determine the initial source for the img tag using useMemo
  // Prioritizes base64 data if available, otherwise uses the transparent pixel
  const initialSrc = useMemo(() => (
    game.image_base64
      ? game.image_base64.startsWith('data:') // Check if it already has the data URI prefix
        ? game.image_base64
        : `data:image/jpeg;base64,${game.image_base64}` // Add prefix if missing
      : transparentPixel // Fallback to transparent pixel
  ), [game.image_base64]);

  // State: The current source URL being used by the img tag
  const [imageSrc, setImageSrc] = useState<string>(initialSrc);
  // State: Tracks if the initial source was base64 (used for blur effect and conditional noise)
  const [isShowingBase64, setIsShowingBase64] = useState<boolean>(initialSrc !== transparentPixel);
  // State: Tracks if the final image has been successfully loaded OR if loading failed
  const [finalImageDisplayed, setFinalImageDisplayed] = useState<boolean>(false);

  // --- Image Loading Logic (using useCallback for optimization) ---
  const loadImage = useCallback(() => {
    // Exit conditions:
    // 1. Final image already shown (or loading failed).
    // 2. There's no actual final image URL to load (game.image was null).
    if (finalImageDisplayed || !finalImageURL) {
        return;
    }

    // Check cache first
    if (imageCache.has(finalImageURL)) {
      if (cardRef.current) { // Check if component is still mounted
        setImageSrc(finalImageURL);   // Update src to final URL
        setFinalImageDisplayed(true); // Mark as displayed
        setIsShowingBase64(false);    // No longer showing base64
      }
      return; // Exit after setting from cache
    }

    // If not cached, create an Image object to load in the background
    const img = new Image();
    img.onload = () => {
      imageCache.set(finalImageURL, finalImageURL); // Cache on successful load
      if (cardRef.current) { // Check mount status
          setImageSrc(finalImageURL);   // Update src to final URL
          setFinalImageDisplayed(true); // Mark as displayed
          setIsShowingBase64(false);    // No longer showing base64
      }
    };
    img.onerror = () => {
       console.error(`[loadImage] Failed to load image: ${finalImageURL}.`);
       // Keep showing base64 or noise background. Don't change imageSrc.
       // Mark as "done trying" to stop observer etc.
       if (cardRef.current) {
           setFinalImageDisplayed(true);
       }
    };
    img.src = finalImageURL; // Start the background loading process

  }, [finalImageURL, finalImageDisplayed]); // Dependencies ensure function updates if URL/status changes

  // --- Intersection Observer Logic (using useEffect) ---
  useEffect(() => {
    // Conditions to skip setting up the observer:
    // 1. The final image is already displayed (or failed).
    // 2. There is no final image URL to load.
    if (finalImageDisplayed || !finalImageURL) {
        return; // No observation needed
    }

    // Create the observer
    const observer = new IntersectionObserver(
      (entries) => {
        // If the card is intersecting (coming into view)
        if (entries[0].isIntersecting) {
          loadImage(); // Trigger the image loading function
          // Stop observing this card once loading is triggered
          if (cardRef.current) {
              observer.unobserve(cardRef.current);
          }
        }
      },
      {
        rootMargin: '200px', // Start loading when card is 200px away from viewport edge
        threshold: 0.01     // Trigger even if only 1% is visible
      }
    );

    const currentCardRef = cardRef.current; // Capture ref value
    if (currentCardRef) {
      observer.observe(currentCardRef); // Start observing the card
    }

    // Cleanup function: Stop observing and disconnect when component unmounts or dependencies change
    return () => {
      if (currentCardRef) {
          observer.unobserve(currentCardRef);
      }
      observer.disconnect();
    };
  // Dependencies: Rerun effect if loadImage function changes or finalImageDisplayed status changes
  }, [loadImage, finalImageDisplayed, finalImageURL]);


  // --- Other Memoized Calculations ---

  // Sort tags based on predefined category order and limit the number displayed
  const sortedTags = useMemo(() => {
     const tagsToSort = game.expand?.tags ?? [];
     // Ensure tags have the necessary expanded category data for sorting
     const validTags = tagsToSort.filter(tag => tag?.expand?.tag_categories_via_tags?.[0]?.name);
     // Flatten the array after sorting by category order
     return CATEGORY_ORDER.flatMap((categoryName) =>
       validTags.filter((tag) => tag.expand!.tag_categories_via_tags![0].name === categoryName)
     ).slice(0, TAG_DISPLAY_LIMIT); // Apply display limit
  }, [game.expand?.tags]);

  // Get upvote and comment counts, defaulting to 0 if null/undefined
  const gameUpvoteCount = game.upvotes_count ?? 0;
  const gameCommentCount = game.comments_count ?? 0;

  // Sanitize the game description HTML using DOMPurify to prevent XSS attacks
  const sanitizedDescription = useMemo(() => DOMPurify.sanitize(game.description ?? ''), [game.description]);

  // --- JSX Rendering ---
  return (
    // Link wrapper for the entire card
    <Link to={`/game/${game.id}`} style={{ textDecoration: 'none' }}>
      <Card
        ref={cardRef} // Attach ref for IntersectionObserver
        sx={{
          cursor: 'pointer',
          transition: 'transform 0.3s ease-in-out', // Smooth scaling on hover
          '&:hover': { transform: 'scale(1.03)' },  // Slight zoom effect on hover
          position: 'relative',                    // Needed for absolute positioning of children
          overflow: 'hidden',                      // Hide parts of children that might overflow
          backgroundColor: theme.palette.background.paper, // Use theme paper color
          paddingTop: CARD_ASPECT_RATIO,           // Aspect ratio trick for height
          boxShadow: theme.shadows[3],             // Standard shadow depth
          height: 0,                               // Required for paddingTop trick
        }}
      >
        {/* Absolute container for all visual elements */}
        <Box sx={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>

          {/* --- Conditional Noise Background --- */}
          {/* Display only if the initial image wasn't base64 */}
          {!isShowingBase64 && (
            <Box
              sx={{
                position: 'absolute',
                top: 0, left: 0, width: '100%', height: '100%',
                backgroundImage: theme.custom?.cardNoiseBackground, // Get noise URL from theme
                backgroundRepeat: 'repeat',
                backgroundSize: '300px 300px', // Should match body noise size ideally
                zIndex: 0, // Render behind the actual image
              }}
            />
          )}
          {/* --- END Noise Background --- */}


          {/* The actual Image Tag */}
          <img
            src={imageSrc} // Dynamically updated: starts with base64/transparent, ends with final URL
            alt={game.title || 'Game image'} // Alt text for accessibility
            loading="lazy" // Native browser lazy loading (good fallback)
            style={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              objectFit: 'cover',        // Cover the area, potentially cropping
              objectPosition: 'center',    // Center the image content
              transition: 'opacity 0.3s ease-in-out, filter 0.3s ease-in-out', // Smooth transitions
              // Apply blur filter ONLY when showing base64 AND the final image hasn't loaded/failed yet
              filter: isShowingBase64 && !finalImageDisplayed ? 'blur(4px)' : 'none',
              // Hide the img tag visually if it's just the transparent pixel AND loading failed (to show noise bg)
              display: imageSrc === transparentPixel && finalImageDisplayed ? 'none' : 'block',
              zIndex: 1, // Render above the noise background
            }}
          />

          {/* Darkening Overlay */}
          <Box sx={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`, // Use constant for opacity
              zIndex: 2, // Render above the image
          }} />

          {/* Card Content - container for text, tags, stats */}
          <CardContent sx={{
              position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
              display: 'flex', flexDirection: 'column',
              p: 0, // Remove default padding, manage spacing internally
              boxSizing: 'border-box',
              '&:last-child': { paddingBottom: 0 }, // Override MUI's default bottom padding
              zIndex: 3 // Render above the overlay
            }}
          >
             {/* Title */}
             <Typography
                variant="h3" component="div" align="center"
                sx={{
                    position: 'relative', // Establish stacking context if needed
                    pt: `${CARD_PADDING}px`, pl: `${CARD_PADDING}px`, pr: `${CARD_PADDING}px`,
                    fontWeight: 'bold',
                    fontSize: { xs: '1.2rem', sm: '1.5rem', md: '1.8rem' }, // Responsive font size
                    ...(theme.custom?.cardTitle ?? {}), // Apply custom theme styles
                    mb: `${TITLE_MARGIN_BOTTOM}px`,     // Margin below title
                    // Text overflow handling for long titles
                    overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                }}
             >
               {game.title || 'Untitled'} {/* Display title or default */}
             </Typography>

            {/* Description and Tags section (only for 'standard' variant) */}
            {variant === 'standard' && (
               <>
                 {/* Description Box */}
                 <Box
                   sx={{
                     position: 'absolute',
                     top: DESCRIPTION_TOP, // Position from top
                     left: `${CARD_PADDING}px`, right: `${CARD_PADDING}px`, // Horizontal padding
                     // Calculate bottom edge based on space needed for tags and stats
                     bottom: `calc(${TAG_SECTION_HEIGHT} + ${BOTTOM_INFO_MARGIN_TOP}px + ${BOTTOM_INFO_MARGIN_BOTTOM}px + 40px)`,
                     overflow: 'hidden', // Hide overflowing text
                     fontSize: { xs: '0.8rem', sm: '0.9rem', md: '1rem' }, // Responsive font size
                     // Fade out effect at the bottom
                     maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                     WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                     ...(theme.custom?.cardText ?? {}), // Apply custom theme styles
                     color: theme.palette.text.primary, // Ensure text color is set
                   }}
                 >
                   {/* Render sanitized HTML description */}
                   <div dangerouslySetInnerHTML={{ __html: sanitizedDescription }} />
                 </Box>

                 {/* Tags Box */}
                 <Box
                   sx={{
                     position: 'absolute',
                     // Position above the bottom info row
                     bottom: `calc(${BOTTOM_INFO_MARGIN_TOP}px + ${BOTTOM_INFO_MARGIN_BOTTOM}px + 30px)`,
                     left: `${CARD_PADDING}px`, right: `${CARD_PADDING}px`, // Horizontal padding
                   }}
                 >
                   {/* Flex container for tags */}
                   <Box sx={{
                       display: 'flex', flexWrap: 'wrap', gap: 0.5, // Wrap tags with small gap
                       fontSize: { xs: '0.6rem', sm: '0.7rem', md: '0.8rem' }, // Responsive font size for tags
                       maxHeight: TAG_SECTION_HEIGHT, // Limit height
                       overflow: 'hidden', // Hide overflowing tags
                     }}
                   >
                     {/* Map through sorted tags and render Chips */}
                     {sortedTags.map((tag) => {
                       const category = tag.expand?.tag_categories_via_tags?.[0].name;
                       const chipColor = CATEGORY_COLORS[category ?? ''] || 'transparent'; // Get color or fallback
                       return (
                         <Chip
                            key={tag.id}
                            label={tag.name}
                            size="small"
                            sx={{
                                backgroundColor: chipColor,
                                color: theme.palette.text.primary, // Ensure text visibility
                                textShadow: '1px 1px 2px rgba(0,0,0,0.5)', // Add shadow for contrast
                                opacity: chipColor === 'transparent' ? 0.7 : 1 // Dim default tags slightly
                            }}
                         />
                       );
                     })}
                   </Box>
                 </Box>
               </>
             )}

            {/* Bottom Info: Author and Stats */}
            <Box
               sx={{
                 display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 position: 'absolute', // Position at the bottom
                 bottom: `${CARD_PADDING}px`, left: `${CARD_PADDING}px`, right: `${CARD_PADDING}px`,
               }}
             >
               {/* Author Name */}
               <Typography
                 variant="body2"
                 sx={{
                   fontSize: { xs: '0.7rem', sm: '0.8rem', md: '0.9rem' },
                   ...(theme.custom?.cardText ?? {}), // Apply custom theme styles
                   textShadow: '1px 1px 3px rgba(3, 3, 3, 1)', // Stronger shadow for contrast
                   whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', // Prevent wrapping
                   maxWidth: '50%', // Limit width to avoid overlap
                   color: theme.palette.text.primary, // Explicit color
                 }}
               >
                 {/* Display author name or default */}
                 {game.expand?.authors_via_games?.[0]?.name || 'Anonymous'}
               </Typography>
               {/* Stats Icons and Counts */}
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

// Memoize the component to prevent unnecessary re-renders if props haven't changed significantly
export default React.memo(GameCard, (prevProps, nextProps) => {
    // Compare relevant props for equality
    return prevProps.game.id === nextProps.game.id &&
           prevProps.variant === nextProps.variant &&
           // Only re-render if counts change, assuming other game data is less frequent
           prevProps.game.upvotes_count === nextProps.game.upvotes_count &&
           prevProps.game.comments_count === nextProps.game.comments_count;
});