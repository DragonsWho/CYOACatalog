// src/components/CyoaPage/GameAdditionalInfo.jsx
// v1.1
// Added expand images button

import React from 'react';
import { Box, Typography, Button } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite'; 
import { useTheme } from '@mui/material/styles';

function GameAdditionalInfo({ gameId, upvotes, expanded, onExpand }) {
    const theme = useTheme();
    const gameUpvoteCount = upvotes?.length || 0;

    const expandButtonColor = '#4caf50';  

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Additional game information will be displayed here. Probably.
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Button
                    variant="contained"
                    size="small"
                    sx={{ backgroundColor: theme.palette.primary.main }}
                >
                    UPVOTE
                </Button>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                    <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold' }}>
                        {gameUpvoteCount}
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    size="small"
                    onClick={onExpand}
                    startIcon={expanded ? 'Fit Images' : 'Full Size Image'}
                    sx={{
                        backgroundColor: expandButtonColor,
                        '&:hover': {
                            backgroundColor: '#45a049',
                        },
                    }}
                > 
                </Button>
            </Box>
        </Box>
    );
}

export default GameAdditionalInfo;
