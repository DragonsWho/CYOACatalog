// src/components/GameCard.jsx
// v 1.2
// add tags 

import React from 'react';
import { Card, CardContent, CardMedia, Typography, Chip, Box } from '@mui/material';
import { useNavigate } from 'react-router-dom';

function GameCard({ game }) {
    const navigate = useNavigate();

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
            {game.image && (
                <CardMedia
                    component="img"
                    height="140"
                    image={game.image}
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
            </CardContent>
        </Card>
    );
}

export default GameCard;