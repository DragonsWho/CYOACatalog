// src/components/CyoaPage/GameAdditionalInfo.tsx
// v1.9
// Converted to TypeScript

import React, { useState, useEffect, useCallback } from 'react'
import { Box, Typography, Button, CircularProgress, Tooltip } from '@mui/material'
import FavoriteIcon from '@mui/icons-material/Favorite'
import { useTheme } from '@mui/material/styles'
import { upvoteGame, removeUpvote } from '../../services/api'
import authService from '../../services/authService'

const LOGIN_TOOLTIP = 'Login to upvote'

interface GameAdditionalInfoProps {
    gameId: string
    upvotes: string[]
    expanded: boolean
    onExpand: () => void
    onUpvoteChange?: () => void
}

function GameAdditionalInfo({
    gameId,
    upvotes: initialUpvotes,
    expanded,
    onExpand,
    onUpvoteChange,
}: GameAdditionalInfoProps) {
    const theme = useTheme()
    const [isUpvoted, setIsUpvoted] = useState(false)
    const [localUpvoteCount, setLocalUpvoteCount] = useState(initialUpvotes?.length || 0)
    const [isLoading, setIsLoading] = useState(false)
    const user = authService.getCurrentUser()

    useEffect(() => {
        if (user && initialUpvotes) {
            setIsUpvoted(initialUpvotes.includes(user.user.username))
            setLocalUpvoteCount(initialUpvotes.length)
        }
    }, [])

    const handleUpvote = useCallback(async () => {
        if (!user) {
            return
        }

        setIsLoading(true)

        // Optimistic UI update
        const newIsUpvoted = !isUpvoted
        setIsUpvoted(newIsUpvoted)
        setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : prevCount - 1))

        try {
            if (newIsUpvoted) {
                await upvoteGame(gameId)
            } else {
                await removeUpvote(gameId)
            }
            if (onUpvoteChange) {
                onUpvoteChange()
            }
        } catch (error) {
            console.error('Error handling upvote:', error)
            setIsUpvoted(!newIsUpvoted)
            setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount - 1 : prevCount + 1))
            alert('There was an error in voting. Please try again later.')
        } finally {
            setIsLoading(false)
        }
    }, [gameId, isUpvoted, onUpvoteChange, user])

    const expandButtonColor = '#4caf50'

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Additional game information will be displayed here. Probably.
            </Typography>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <Tooltip title={user ? '' : LOGIN_TOOLTIP} arrow>
                    <span>
                        <Button
                            variant="contained"
                            size="small"
                            sx={{
                                backgroundColor: isUpvoted ? theme.palette.secondary.main : theme.palette.primary.main,
                                '&:hover': {
                                    backgroundColor: isUpvoted
                                        ? theme.palette.secondary.dark
                                        : theme.palette.primary.dark,
                                },
                                '&.Mui-disabled': {
                                    color: 'rgba(255, 255, 255, 0.7)',
                                    backgroundColor: 'rgba(0, 0, 0, 0.12)',
                                },
                                minWidth: '80px',
                            }}
                            onClick={handleUpvote}
                            disabled={isLoading || !user}
                        >
                            {isLoading ? (
                                <CircularProgress size={24} color="inherit" />
                            ) : isUpvoted ? (
                                'UNVOTE'
                            ) : (
                                'UPVOTE'
                            )}
                        </Button>
                    </span>
                </Tooltip>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <FavoriteIcon sx={{ color: theme.palette.secondary.main, fontSize: '1rem', mr: 0.5 }} />
                    <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold' }}>
                        {localUpvoteCount}
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
    )
}

export default GameAdditionalInfo
