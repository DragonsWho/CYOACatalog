// src/components/CyoaPage/GameContent.jsx
// v1.0
// Separate component for game content display

import React from 'react';
import { Typography, Box } from '@mui/material';

const API_URL = 'http://localhost:1337';

const GameContent = ({ attributes }) => (
    <Box sx={{ mt: 4 }}>
        <Typography variant="h4" gutterBottom>Game Content</Typography>
        {attributes.img_or_link === 'img' && attributes.CYOA_pages?.data ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                {attributes.CYOA_pages.data.map((image, index) => (
                    <img
                        key={image.id}
                        src={`${API_URL}${image.attributes.url}`}
                        alt={`Game content ${index + 1}`}
                        style={{ width: '90%', maxWidth: '100%' }}
                    />
                ))}
            </Box>
        ) : attributes.img_or_link === 'link' && attributes.iframe_url ? (
            <Box sx={{ width: '100%', height: 0, paddingBottom: '56.25%', position: 'relative' }}>
                <iframe
                    src={attributes.iframe_url}
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
                    title="Game content"
                    allowFullScreen
                />
            </Box>
        ) : (
            <Typography>No game content available</Typography>
        )}
    </Box>
);

export default GameContent;