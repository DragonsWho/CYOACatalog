// src/components/GameCard.jsx
// v3.5
// Implemented tag caching

import React, { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { Card, CardContent, Typography, Chip, Box, Skeleton, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { getCachedImage, cacheImage, cacheTagCategoryMap, getCachedTagCategoryMap } from '../services/cacheService';
import FavoriteIcon from '@mui/icons-material/Favorite';

// Design variables
const CARD_ASPECT_RATIO = '133.33%'; // 3:4 aspect ratio
const TITLE_FONT_SIZE = '1.5rem';
const DESCRIPTION_TOP = '60%';
const TAG_SECTION_HEIGHT = '80px';
const TAG_DISPLAY_LIMIT = 12;
const OVERLAY_OPACITY = 0.5;

// Spacing variables
const CARD_PADDING = 16; // Default padding of CardContent
const TITLE_MARGIN_BOTTOM = 8;
const TAGS_MARGIN_BOTTOM = 8;
const BOTTOM_INFO_MARGIN_TOP = 8;
const BOTTOM_INFO_MARGIN_BOTTOM = 0;  

const MAX_CACHE_SIZE = 100 * 1024 * 1024;
const MAX_CACHE_ITEMS = 500;

const CATEGORY_ORDER = ['Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime', 'Status', 'Genre', 'Setting', 'Tone', 'Extra',  'Kinks'];

const GameCard = memo(({ game, tagCategories }) => {
    const theme = useTheme();
    const navigate = useNavigate();
    const [imageUrl, setImageUrl] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    const loadImage = useCallback(async () => {
        if (game.image) {
            try {
                const cachedImage = await getCachedImage(game.image);
                if (cachedImage) {
                    setImageUrl(cachedImage);
                    setIsLoading(false);
                    return;
                }

                const response = await fetch(game.image);
                const blob = await response.blob();
                if (blob.size <= MAX_CACHE_SIZE / MAX_CACHE_ITEMS) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const base64data = reader.result;
                        cacheImage(game.image, base64data);
                        setImageUrl(base64data);
                        setIsLoading(false);
                    };
                    reader.readAsDataURL(blob);
                } else {
                    setImageUrl(game.image);
                    setIsLoading(false);
                }
            } catch (error) {
                console.error('Error loading image:', error);
                setImageUrl('/img/placeholder.jpg');
                setIsLoading(false);
            }
        } else {
            setImageUrl('/img/placeholder.jpg');
            setIsLoading(false);
        }
    }, [game.image]);

    useEffect(() => {
        loadImage();
    }, [loadImage]);

    const getDescription = useCallback((description) => {
        if (typeof description === 'string') {
            return description;
        }
        if (Array.isArray(description?.children)) {
            const textNode = description.children.find(child => child.type === 'text');
            return textNode?.text || 'No description available';
        }
        return 'No description available';
    }, []);

    const sortedTags = useMemo(() => {
        if (!game.tags || !tagCategories) {
            return [];
        }

        let tagCategoryMap = getCachedTagCategoryMap();

        if (!tagCategoryMap) {
            tagCategoryMap = new Map();
            tagCategories.forEach(category => {
                category.attributes.tags.data.forEach(tag => {
                    tagCategoryMap.set(tag.id, category.attributes.Name);
                });
            });
            cacheTagCategoryMap(Array.from(tagCategoryMap.entries()));
        } else {
            tagCategoryMap = new Map(tagCategoryMap);
        }

        const sortedAndFilteredTags = CATEGORY_ORDER.flatMap(categoryName => {
            return game.tags.filter(tag => tagCategoryMap.get(tag.id) === categoryName);
        });

        return sortedAndFilteredTags.slice(0, TAG_DISPLAY_LIMIT);
    }, [game.tags, tagCategories]);

    const description = getDescription(game.description);
    const gameUpvotes = game.Upvotes || [];
    const gameUpvoteCount = gameUpvotes.length;

    const handleCardClick = useCallback(() => {
        navigate(`/game/${game.id}`);
    }, [navigate, game.id]);

    return (
        <Card
            onClick={handleCardClick}
            sx={{
                cursor: 'pointer',
                transition: '0.3s',
                '&:hover': { transform: 'scale(1.03)' },
                position: 'relative',
                overflow: 'hidden',
                backgroundColor: theme.palette.background.paper,
                paddingTop: CARD_ASPECT_RATIO,
            }}
        >
            {isLoading ? (
                <Skeleton
                    variant="rectangular"
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    }}
                />
            ) : (
                <Box
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        backgroundImage: `url(${imageUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        '&::after': {
                            content: '""',
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            backgroundColor: `rgba(0, 0, 0, ${OVERLAY_OPACITY})`,
                        }
                    }}
                />
            )}
            <CardContent
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    p: `${CARD_PADDING}px`,
                    boxSizing: 'border-box',
                }}
            >
                <Typography
                    variant="h6"
                    component="div"
                    align="center"
                    sx={{
                        fontWeight: 'bold',
                        fontSize: TITLE_FONT_SIZE,
                        ...theme.custom.cardTitle,
                        mb: `${TITLE_MARGIN_BOTTOM}px`,
                    }}
                >
                    {game.title || 'Untitled'}
                </Typography>

                <Box sx={{ position: 'absolute', top: DESCRIPTION_TOP, left: CARD_PADDING, right: CARD_PADDING }}>
                    <Typography
                        variant="body2"
                        sx={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            ...theme.custom.cardText,
                        }}
                    >
                        {description}
                    </Typography>
                </Box>

                <Box sx={{ mt: 'auto' }}>
                    <Box sx={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 0.5,
                        mb: `${TAGS_MARGIN_BOTTOM}px`,
                        height: TAG_SECTION_HEIGHT,
                        overflow: 'hidden'
                    }}>
                        {sortedTags.map((tag, index) => (
                            <Chip
                                key={index}
                                label={tag.attributes.Name}
                                size="small"
                                sx={{
                                    fontSize: '0.7rem',
                                    backgroundColor: 'rgba(3, 3, 3, 0.4)',
                                    color: 'white',
                                }}
                            />
                        ))}
                    </Box>

                    <Box sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        mt: `${BOTTOM_INFO_MARGIN_TOP}px`,
                        mb: `${BOTTOM_INFO_MARGIN_BOTTOM}px`,
                    }}>
                        <Typography variant="body2" sx={theme.custom.cardText}>
                            {game.authors && game.authors.length > 0 ? game.authors[0].name : 'Anonymous'}
                        </Typography>
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            <FavoriteIcon sx={{ color: theme.palette.primary.main, fontSize: '1rem', mr: 0.5 }} />
                            <Typography variant="body2" sx={{ color: theme.palette.primary.main, fontWeight: 'bold' }}>
                                {gameUpvoteCount}
                            </Typography>
                        </Box>
                    </Box>
                </Box>
            </CardContent>
        </Card>
    );
});

GameCard.displayName = 'GameCard';

export default GameCard;