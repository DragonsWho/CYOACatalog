// src/components/GameDetails.jsx
// v2.1
// Optimized version with separate GameContent component

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Typography, Chip, Box, CircularProgress } from '@mui/material';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';

const API_URL = 'http://localhost:1337';

function GameDetails() {
    const [game, setGame] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { id } = useParams();

    useEffect(() => {
        const fetchGameDetails = async () => {
            try {
                const response = await fetch(`${API_URL}/api/games/${id}?populate=*,tags.tag_category,authors,Image,CYOA_pages`);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
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

    if (loading) return <CircularProgress />;
    if (error) return <Typography color="error">Error: {error}</Typography>;
    if (!game) return <Typography>Game not found</Typography>;

    const { attributes } = game;

    return (
        <Container maxWidth="lg">
            <Typography variant="h2" component="h1" gutterBottom>
                {attributes.Title || 'Untitled Game'}
            </Typography>

            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                {attributes.authors?.data?.map((author) => (
                    <Chip key={author.id} label={author.attributes.Name} />
                ))}
            </Box>

            {attributes.tags?.data?.length > 0 && <TagDisplay tags={attributes.tags.data} />}

            <Typography variant="body1" paragraph>
                {attributes.Description?.map((block, index) => (
                    <React.Fragment key={index}>
                        {block.children.map((child, childIndex) => (
                            <span key={childIndex}>{child.text}</span>
                        ))}
                    </React.Fragment>
                ))}
            </Typography>

            {attributes.Image?.data && (
                <Box sx={{ my: 2 }}>
                    <img
                        src={`${API_URL}${attributes.Image.data.attributes.url}`}
                        alt={attributes.Title}
                        style={{ maxWidth: '100%', height: 'auto' }}
                    />
                </Box>
            )}

            <GameContent attributes={attributes} />
        </Container>
    );
}

export default GameDetails;