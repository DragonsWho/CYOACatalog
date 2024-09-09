// src/components/CyoaPage/GameAdditionalInfo.tsx
// v1.9
// Converted to TypeScript

import { useState, useEffect, useCallback } from 'react';
import { Box, Typography, Button, CircularProgress, Tooltip } from '@mui/material';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { useTheme } from '@mui/material/styles';
import { gamesCollection, useAuth } from '../../pocketbase/pocketbase';

const LOGIN_TOOLTIP = 'Login to upvote';

export default function GameAdditionalInfo({
  gameId,
  upvotes: initialUpvotes,
  expanded,
  onExpand,
  onUpvoteChange,
}: {
  gameId: string;
  upvotes: string[];
  expanded: boolean;
  onExpand: () => void;
  onUpvoteChange?: () => void;
}) {
  const theme = useTheme();
  const [isUpvoted, setIsUpvoted] = useState(false);
  const [localUpvoteCount, setLocalUpvoteCount] = useState(initialUpvotes?.length || 0);
  const [isLoading, setIsLoading] = useState(false);
  const { user } = useAuth();
  const userID = user?.id;

  useEffect(() => {
    if (userID && initialUpvotes) {
      setIsUpvoted(initialUpvotes.includes(userID));
      setLocalUpvoteCount(initialUpvotes.length);
    }
  }, [userID, initialUpvotes]);

  const handleUpvote = useCallback(async () => {
    if (!userID) return;

    setIsLoading(true);

    // Optimistic UI update
    const newIsUpvoted = !isUpvoted;
    setIsUpvoted(newIsUpvoted);
    setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : prevCount - 1));

    if (newIsUpvoted) await gamesCollection.update(gameId, { upvotes: [...initialUpvotes, userID] });
    else await gamesCollection.update(gameId, { upvotes: initialUpvotes.filter((id) => id !== userID) });
    if (onUpvoteChange) onUpvoteChange();
    setIsLoading(false);
  }, [gameId, isUpvoted, onUpvoteChange, initialUpvotes, userID]);

  const expandButtonColor = '#4caf50';

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Additional game information will be displayed here. Probably.
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Tooltip title={userID ? '' : LOGIN_TOOLTIP} arrow>
          <span>
            <Button
              variant="contained"
              size="small"
              sx={{
                backgroundColor: isUpvoted ? theme.palette.secondary.main : theme.palette.primary.main,
                '&:hover': {
                  backgroundColor: isUpvoted ? theme.palette.secondary.dark : theme.palette.primary.dark,
                },
                '&.Mui-disabled': {
                  color: 'rgba(255, 255, 255, 0.7)',
                  backgroundColor: 'rgba(0, 0, 0, 0.12)',
                },
                minWidth: '80px',
              }}
              onClick={handleUpvote}
              disabled={isLoading || !userID}
            >
              {isLoading ? <CircularProgress size={24} color="inherit" /> : isUpvoted ? 'UNVOTE' : 'UPVOTE'}
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
  );
}
