// src/components/CyoaPage/GameAdditionalInfo.jsx
// v1.0
// Component for additional game information and upvotes

import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { useTheme } from '@mui/material/styles';

function GameAdditionalInfo({ gameId, upvotes }) {
    const theme = useTheme();
    const gameUpvoteCount = upvotes?.length || 0;

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Additional game information will be displayed here. Probably.
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Button
                    variant="contained"
                    size="small"
                >
                    UPVOTE
                </Button>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <FavoriteIcon sx={{ color: theme.palette.primary.main, fontSize: '1rem', mr: 0.5 }} />
                    <Typography variant="body2" sx={{ color: theme.palette.primary.main, fontWeight: 'bold' }}>
                        {gameUpvoteCount}
                    </Typography>
                </Box>
            </Box>
        </Box>
    );
}

export default GameAdditionalInfo;