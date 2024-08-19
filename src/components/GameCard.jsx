// src/components/GameCard.jsx
// v 1.3
// Added image caching and optimized rendering

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardMedia, Typography, Chip, Box } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { getCachedImage, cacheImage } from '../services/cacheService';

const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_CACHE_ITEMS = 500; // Maximum number of cached items

function GameCard({ game }) {
    const navigate = useNavigate();
    const [imageUrl, setImageUrl] = useState(null);

    useEffect(() => {
        const loadImage = async () => {
            if (game.image) {
                const cachedImage = getCachedImage(game.image);
                if (cachedImage) {
                    setImageUrl(cachedImage);
                } else {
                    try {
                        const response = await fetch(game.image);
                        const blob = await response.blob();
                        if (blob.size <= MAX_CACHE_SIZE / MAX_CACHE_ITEMS) {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                const base64data = reader.result;
                                cacheImage(game.image, base64data);
                                setImageUrl(base64data);
                            };
                            reader.readAsDataURL(blob);
                        } else {
                            setImageUrl(game.image);
                        }
                    } catch (error) {
                        console.error('Error loading image:', error);
                        setImageUrl(game.image);
                    }
                }
            }
        };

        loadImage();
    }, [game.image]);

    const getDescription = (description) => {
        if (typeof description === 'string') {
            return description;
        }
        if (Array.isArray(description?.children)) {
            const textNode = description.children.find(child => child.type === 'text');
            return textNode?.text || 'No description available';
        }
        return 'No description available';
    };

    const description = getDescription(game.description);

    const gameUpvotes = game.Upvotes || [];
    const gameUpvoteCount = gameUpvotes.length;

    const handleCardClick = () => {
        navigate(`/game/${game.id}`);
    };

    return (
        <Card
            onClick={handleCardClick}
            sx={{
                cursor: 'pointer',
                transition: '0.3s',
                '&:hover': { transform: 'scale(1.03)' }
            }}
        >
            {imageUrl && (
                <CardMedia
                    component="img"
                    height="140"
                    image={imageUrl}
                    alt={game.title}
                />
            )}
            <CardContent>
                <Typography gutterBottom variant="h5" component="div">
                    {game.title || 'Untitled'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
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
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {game.tags.map((tag, index) => (
                            <Chip key={index} label={tag.attributes.Name} size="small" color="secondary" />
                        ))}
                    </Box>
                )}

                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <img src="/img/upvote.png" alt="Upvote" />
                    <Typography variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
                        {gameUpvoteCount}
                    </Typography>
                </Box>
            </CardContent>
        </Card>
    );
}

export default GameCard;