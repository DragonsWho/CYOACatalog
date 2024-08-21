// src/components/CyoaPage/GameContent.jsx
// v1.1
// Improved error handling, responsiveness, and accessibility

import React, { useState } from 'react';
import { Typography, Box, CircularProgress } from '@mui/material';
import { useTheme } from '@mui/material/styles';


const API_URL = 'http://localhost:1337';

const GameContent = ({ attributes }) => {
    const theme = useTheme();
    const [loadingImages, setLoadingImages] = useState(attributes.CYOA_pages?.data?.length || 0);
    const [imageErrors, setImageErrors] = useState({});

    const handleImageLoad = (id) => {
        setLoadingImages(prev => prev - 1);
    };

    const handleImageError = (id) => {
        setImageErrors(prev => ({ ...prev, [id]: true }));
        setLoadingImages(prev => prev - 1);
    };

    return (
        <Box>
            {attributes.img_or_link === 'img' && attributes.CYOA_pages?.data ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    {loadingImages > 0 && <CircularProgress />}
                    {attributes.CYOA_pages.data.map((image, index) => (
                        <Box key={image.id} sx={{ width: '100%', position: 'relative' }}>
                            {!imageErrors[image.id] && (
                                <img
                                    src={`${API_URL}${image.attributes.url}`}
                                    alt={`Game content ${index + 1}`}
                                    style={{
                                        width: '100%',
                                        maxWidth: '100%',
                                        display: loadingImages > 0 ? 'none' : 'block'
                                    }}
                                    onLoad={() => handleImageLoad(image.id)}
                                    onError={() => handleImageError(image.id)}
                                />
                            )}
                            {imageErrors[image.id] && (
                                <Typography color="error">
                                    Failed to load image {index + 1}
                                </Typography>
                            )}
                        </Box>
                    ))}
                </Box>
            ) : attributes.img_or_link === 'link' && attributes.iframe_url ? (
                <Box sx={{
                    width: '100%',
                    height: 0,
                    paddingBottom: '56.25%', // 16:9 aspect ratio
                    position: 'relative',
                    overflow: 'hidden',
                    [theme.breakpoints.up('md')]: {
                        paddingBottom: '75%', // 4:3 aspect ratio for larger screens
                    },
                }}>
                    <iframe
                        src={attributes.iframe_url}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            border: 'none'
                        }}
                        title="Game content"
                        allowFullScreen
                        loading="lazy"
                    />
                </Box>
            ) : (
                <Typography>No game content available</Typography>
            )}
        </Box>
    );
};

export default GameContent;