// src/components/GameCard.jsx
// v 1.4
// Optimized image loading, improved error handling, and added performance optimizations

import React, { useState, useEffect, useCallback, memo } from 'react';
import { Card, CardContent, CardMedia, Typography, Chip, Box, Skeleton } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { getCachedImage, cacheImage } from '../services/cacheService';

const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_CACHE_ITEMS = 500; // Maximum number of cached items

const GameCard = memo(({ game }) => {
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
                height: '100%',
                display: 'flex',
                flexDirection: 'column'
            }}
        >
            {isLoading ? (
                <Skeleton variant="rectangular" height={140} />
            ) : (
                <CardMedia
                    component="img"
                    height="140"
                    image={imageUrl}
                    alt={game.title}
                />
            )}
            <CardContent sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
                <Typography gutterBottom variant="h5" component="div">
                    {game.title || 'Untitled'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2, flexGrow: 1 }}>
                    {description && description.length > 100
                        ? `${description.substring(0, 100)}...`
                        : description}
                </Typography>

                {game.authors && game.authors.length > 0 && (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                        {game.authors.map((author, index) => (
                            <Chip key={index} label={author.name} size="small" color="primary" />
                        ))}
                    </Box>
                )}

                {game.tags && game.tags.length > 0 && (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
                        {game.tags.map((tag, index) => (
                            <Chip key={index} label={tag.attributes.Name} size="small" color="secondary" />
                        ))}
                    </Box>
                )}

                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                    <img src="/img/upvote.png" alt="Upvote" style={{ width: '16px', height: '16px' }} />
                    <Typography variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
                        {gameUpvoteCount}
                    </Typography>
                </Box>
            </CardContent>
        </Card>
    );
});

GameCard.displayName = 'GameCard';

export default GameCard;