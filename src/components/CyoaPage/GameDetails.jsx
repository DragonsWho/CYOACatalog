// src/components/CyoaPage/GameDetails.jsx
// v3.8
// Updated layout and integrated GameAdditionalInfo component

import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress, Grid, Paper } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import TagDisplay from './TagDisplay';
import GameContent from './GameContent';
import SimpleComments from './SimpleComments';
import GameAdditionalInfo from './GameAdditionalInfo';

const API_URL = 'http://localhost:1337';

function GameDetails() {
    const [game, setGame] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const { id } = useParams();
    const theme = useTheme();

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
        <Container maxWidth="lg" disableGutters>
            <Paper
                elevation={3}
                sx={{
                    p: 2,
                    mb: 1,
                    bgcolor: theme.palette.grey[900],
                    color: theme.palette.common.white
                }}
            >
                <Box sx={{
                    mb: 0.5,
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'flex-end'
                }}>
                    <Typography variant="h4" component="h1" sx={{ mr: 1 }}>
                        {attributes.Title || 'Untitled Game'}
                    </Typography>
                    {attributes.authors?.data?.length > 0 && (
                        <Typography variant="subtitle1" sx={{ mb: '0.35em' }}>
                            by {attributes.authors.data.map(author => author.attributes.Name).join(', ')}
                        </Typography>
                    )}
                </Box>

                <Grid container spacing={3}>
                    {/* Left Column - Image */}
                    <Grid item xs={12} md={6}>
                        {attributes.Image?.data && (
                            <Box sx={{
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center'
                            }}>
                                <img
                                    src={`${API_URL}${attributes.Image.data.attributes.url}`}
                                    alt={attributes.Title}
                                    style={{
                                        maxWidth: '60%',
                                        height: 'auto',
                                        objectFit: 'contain'
                                    }}
                                />
                            </Box>
                        )}
                    </Grid>

                    {/* Right Column - Game Info */}
                    <Grid item xs={12} md={6}>
                        {attributes.tags?.data?.length > 0 && (
                            <Box>
                                <TagDisplay
                                    tags={attributes.tags.data}
                                    chipProps={{
                                        size: 'small',
                                        sx: {
                                            bgcolor: theme.palette.grey[800],
                                            color: theme.palette.common.white,
                                            '&:hover': {
                                                bgcolor: theme.palette.grey[700],
                                            },
                                        }
                                    }}
                                />
                            </Box>
                        )}

                        <GameAdditionalInfo gameId={id} upvotes={attributes.Upvotes} />
                    </Grid>
                </Grid>

                <Box sx={{ mt: 3 }}>
                    <Typography variant="h6" gutterBottom textAlign="center">
                        Description
                    </Typography>
                    <Typography variant="body1" sx={{ px: 2 }}>
                        {attributes.Description?.map((block, index) => (
                            <React.Fragment key={index}>
                                {block.children.map((child, childIndex) => (
                                    <span key={childIndex}>{child.text}</span>
                                ))}
                            </React.Fragment>
                        ))}
                    </Typography>
                </Box>
            </Paper>

            <Box sx={{ bgcolor: theme.palette.grey[800], mb: 3 }}>
                <GameContent attributes={attributes} />
            </Box>

            <Box sx={{ bgcolor: theme.palette.grey[800] }}>
                <SimpleComments gameId={id} />
            </Box>
        </Container>
    );
}

export default GameDetails;