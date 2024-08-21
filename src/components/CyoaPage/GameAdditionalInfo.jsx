// src/components/CyoaPage/GameAdditionalInfo.jsx
// v1.4
// Fixed immediate UI update for upvotes

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, CircularProgress } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { useTheme } from '@mui/material/styles';
import { upvoteGame, removeUpvote } from '../../services/api';
import authService from '../../services/authService';

function GameAdditionalInfo({ gameId, upvotes: initialUpvotes, expanded, onExpand, onUpvoteChange }) {
    const theme = useTheme();
    const [isUpvoted, setIsUpvoted] = useState(false);
    const [upvotes, setUpvotes] = useState(initialUpvotes || []);
    const [isLoading, setIsLoading] = useState(false);
    const user = authService.getCurrentUser();

    useEffect(() => {
        if (user && initialUpvotes) {
            setIsUpvoted(initialUpvotes.includes(user.user.username));
            setUpvotes(initialUpvotes);
        }
    }, [initialUpvotes, user]);

    const handleUpvote = useCallback(async () => {
        if (!user) {
            alert('Please login to vote');
            return;
        }

        setIsLoading(true);

        // Optimistic UI update
        setIsUpvoted(prevState => !prevState);
        setUpvotes(prevUpvotes => {
            if (prevUpvotes.includes(user.user.username)) {
                return prevUpvotes.filter(name => name !== user.user.username);
            } else {
                return [...prevUpvotes, user.user.username];
            }
        });

        try {
            if (isUpvoted) {
                await removeUpvote(gameId);
            } else {
                await upvoteGame(gameId);
            }
            if (onUpvoteChange) {
                onUpvoteChange();
            }
        } catch (error) {
            console.error('Error handling upvote:', error); 
            setIsUpvoted(prevState => !prevState);
            setUpvotes(prevUpvotes => {
                if (isUpvoted) {
                    return [...prevUpvotes, user.user.username];
                } else {
                    return prevUpvotes.filter(name => name !== user.user.username);
                }
            });
            alert('There was an error in voting. Please try again later.');
        } finally {
            setIsLoading(false);
        }
    }, [gameId, isUpvoted, onUpvoteChange, user]);

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
                        },
                        minWidth: '80px',
                    }}
                    onClick={handleUpvote}
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <CircularProgress size={24} color="inherit" />
                    ) : (
                        isUpvoted ? 'UNVOTE' : 'UPVOTE'
                    )}
                </Button>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                    <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold' }}>
                        {upvotes.length}
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