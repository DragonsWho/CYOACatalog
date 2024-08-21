// src/components/CyoaPage/GameAdditionalInfo.jsx
// v1.2
// Added upvote functionality

import React, { useState, useEffect } from 'react';
import { Box, Typography, Button } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { useTheme } from '@mui/material/styles';
import { upvoteGame, removeUpvote } from '../../services/api';
import authService from '../../services/authService';

function GameAdditionalInfo({ gameId, upvotes, expanded, onExpand, onUpvoteChange }) {
    const theme = useTheme();
    const [isUpvoted, setIsUpvoted] = useState(false);
    const [upvoteCount, setUpvoteCount] = useState(upvotes?.length || 0);
    const user = authService.getCurrentUser();

    useEffect(() => {
        if (user && upvotes) {
            setIsUpvoted(upvotes.includes(user.user.username));
        }
        setUpvoteCount(upvotes?.length || 0);
    }, [upvotes, user]);

    const handleUpvote = async () => {
        if (!user) {
            alert('Please login to vote');
            return;
        }

        try {
            if (isUpvoted) {
                await removeUpvote(gameId);
                setIsUpvoted(false);
                setUpvoteCount(prev => prev - 1);
            } else {
                await upvoteGame(gameId);
                setIsUpvoted(true);
                setUpvoteCount(prev => prev + 1);
            }
            if (onUpvoteChange) {
                onUpvoteChange();
            }
        } catch (error) {
            console.error('Error handling upvote:', error);
            alert('There was an error in voting. Please try again later.');
        }
    };

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
                    sx={{
                        backgroundColor: isUpvoted ? theme.palette.secondary.main : theme.palette.primary.main,
                        '&:hover': {
                            backgroundColor: isUpvoted ? theme.palette.secondary.dark : theme.palette.primary.dark,
                        }
                    }}
                    onClick={handleUpvote}
                >
                    {isUpvoted ? 'UNVOTE' : 'UPVOTE'}
                </Button>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                    <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold' }}>
                        {upvoteCount}
                    </Typography>
                </Box>
                <Button
                    variant="contained"
                    size="small"
                    onClick={onExpand}
                    sx={{
                        backgroundColor: expandButtonColor,
                        '&:hover': {
                            backgroundColor: '#45a049',
                        },
                    }}
                >
                    {expanded ? 'Fit Images' : 'Full Size Image'}
                </Button>
            </Box>
        </Box>
    );
}

export default GameAdditionalInfo;