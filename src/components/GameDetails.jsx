// src/components/GameDetails.jsx
// Версия 1.2 - Переименование тегов в авторов, обновление логики отображения

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Typography, Chip, Box, CircularProgress } from '@mui/material';

function GameDetails() {
    const [game, setGame] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { id } = useParams();

    useEffect(() => {
        const fetchGameDetails = async () => {
            try {
                const response = await fetch(`http://localhost:1337/api/games/${id}?populate=*`);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                const data = await response.json();
                console.log('Fetched data:', data);
                setGame(data.data);
            } catch (error) {
                console.error('Error fetching game details:', error);
                setError(error.message);
            } finally {
                setLoading(false);
            }
        };

        fetchGameDetails();
    }, [id]);

    if (loading) {
        return <CircularProgress />;
    }

    if (error) {
        return <Typography color="error">Error: {error}</Typography>;
    }

    if (!game) {
        return <Typography>Game not found</Typography>;
    }

    const { attributes } = game;

    // Функция для безопасного рендеринга элементов
    const renderSafely = (component, fallback = null) => {
        try {
            return component();
        } catch (error) {
            console.error('Rendering error:', error);
            return fallback;
        }
    };

    return (
        <Container maxWidth="lg">
            {renderSafely(() => (
                <Typography variant="h2" component="h1" gutterBottom>
                    {attributes.Title || 'Untitled Game'}
                </Typography>
            ), <Typography variant="h2" component="h1" gutterBottom>Untitled Game</Typography>)}

            {renderSafely(() => (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                    {attributes.authors && attributes.authors.data.map((author) => (
                        <Chip key={author.id} label={author.attributes.Name} />
                    ))}
                </Box>
            ), <Box sx={{ mb: 2 }}><Chip label="Unknown Author" /></Box>)}

            {renderSafely(() => (
                <Typography variant="body1" paragraph>
                    {attributes.Description.map((block, index) => (
                        <React.Fragment key={index}>
                            {block.children.map((child, childIndex) => (
                                <span key={childIndex}>{child.text}</span>
                            ))}
                        </React.Fragment>
                    ))}
                </Typography>
            ), <Typography variant="body1" paragraph>No description available.</Typography>)}

            {renderSafely(() => (
                attributes.Image && attributes.Image.data && (
                    <Box sx={{ my: 2 }}>
                        <img
                            src={`http://localhost:1337${attributes.Image.data.attributes.url}`}
                            alt={attributes.Title}
                            style={{ maxWidth: '100%', height: 'auto' }}
                        />
                    </Box>
                )
            ), <Box sx={{ my: 2 }}><Typography>No image available</Typography></Box>)}

            <Box sx={{ mt: 4 }}>
                <Typography variant="h4" gutterBottom>
                    Game Content
                </Typography>
                {renderSafely(() => (
                    attributes.img_or_link === 'img' && attributes.CYOA_pages && attributes.CYOA_pages.data && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                            {attributes.CYOA_pages.data.map((image, index) => (
                                <img
                                    key={image.id}
                                    src={`http://localhost:1337${image.attributes.url}`}
                                    alt={`Game content ${index + 1}`}
                                    style={{ width: '90%', maxWidth: '100%' }}
                                />
                            ))}
                        </Box>
                    )
                ), <Typography>No game images available</Typography>)}
                {renderSafely(() => (
                    attributes.img_or_link === 'link' && attributes.iframe_url && (
                        <Box sx={{ width: '100%', height: 0, paddingBottom: '56.25%', position: 'relative' }}>
                            <iframe
                                src={attributes.iframe_url}
                                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                                title="Game content"
                                allowFullScreen
                            />
                        </Box>
                    )
                ), <Typography>No game content available</Typography>)}
            </Box>
        </Container>
    );
}

export default GameDetails;