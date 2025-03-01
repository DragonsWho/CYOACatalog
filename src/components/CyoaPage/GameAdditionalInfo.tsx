import { useState, useEffect, useCallback, useContext } from 'react';
import { Box, Typography, CircularProgress, Tooltip, IconButton } from '@mui/material';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { useTheme } from '@mui/material/styles';
import { AuthContext, pb } from '../../pocketbase/pocketbase';

const LOGIN_TOOLTIP = 'Login to upvote';

export default function GameAdditionalInfo({
  gameId,
  upvotes: initialUpvotes,
  onUpvoteChange,
}: {
  gameId: string;
  upvotes: string[];
  onUpvoteChange?: () => void;
}) {
  const theme = useTheme();
  const [isUpvoted, setIsUpvoted] = useState(false);
  const [localUpvoteCount, setLocalUpvoteCount] = useState(initialUpvotes?.length || 0);
  const [isLoading, setIsLoading] = useState(false);
  const [showLoader, setShowLoader] = useState(false);
  const { user } = useContext(AuthContext);
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

    const newIsUpvoted = !isUpvoted;
    setIsUpvoted(newIsUpvoted);
    setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : prevCount - 1));

    const loaderTimeout = setTimeout(() => setShowLoader(true), 200);

    const res = await fetch('/api/custom/upvotes/' + gameId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + pb.authStore.token,
      },
    });
    const resJSON = await res.json();
    const { count }: { count: number } = resJSON;

    setLocalUpvoteCount(count);

    if (onUpvoteChange) onUpvoteChange();
    clearTimeout(loaderTimeout);
    setShowLoader(false);
    setIsLoading(false);
  }, [gameId, isUpvoted, onUpvoteChange, userID]);

  const heartColor = theme.palette.secondary.main;

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Additional game information will be displayed here. Probably.
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, height: 40 }}>
        <Tooltip title={userID ? (isUpvoted ? 'Remove upvote' : 'Upvote') : LOGIN_TOOLTIP} arrow>
          <span>
            <IconButton 
              onClick={handleUpvote}
              disabled={isLoading || !userID}
              size="small"
              sx={{
                padding: 0,
                width: 36,
                height: 36,
                opacity: !userID ? 0.6 : 1,
                '&:hover': {
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                },
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Box 
                sx={{ 
                  position: 'relative', 
                  width: 72, 
                  height: 72,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {showLoader ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <DotLottieReact
                    key={isUpvoted ? 'upvoted' : 'not-upvoted'} // Добавляем key для перемонтирования
                    src="/like.lottie"
                    loop={false}
                    autoplay={isUpvoted}
                    style={{
                      width: '72px',
                      height: '72px',
                      color: heartColor,
                    }}
                  />
                )}
              </Box>
            </IconButton>
          </span>
        </Tooltip>
        <Typography 
          variant="body2" 
          sx={{ 
            color: 'white', 
            fontWeight: 'bold',
            minWidth: 10, 
            textAlign: 'left'
          }}
        >
          {localUpvoteCount}
        </Typography>
      </Box>
    </Box>
  );
}