// src/components/CyoaPage/GameAdditionalInfo.tsx
import { useState, useEffect, useCallback, useContext } from 'react';
import { Box, Typography, CircularProgress, Tooltip, IconButton } from '@mui/material';
import { DotLottieReact } from '@lottiefiles/dotlottie-react';
import { useTheme } from '@mui/material/styles';
import { AuthContext, pb, GameRelationship } from '../../pocketbase/pocketbase'; // GameRelationship импортирован
import RelatedGamesList from './RelatedGamesList'; // Импортируем компонент

const LOGIN_TOOLTIP = 'Login to upvote';

interface GameAdditionalInfoProps {
  gameId: string;
  upvotes: string[];
  relatedGames: GameRelationship[]; // Принимает массив связей (с языками)
  onUpvoteChange?: () => void;
}

export default function GameAdditionalInfo({
  gameId,
  upvotes: initialUpvotes,
  relatedGames, // Получаем связи
  onUpvoteChange,
}: GameAdditionalInfoProps) {
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
    } else {
      setIsUpvoted(false);
    }
    setLocalUpvoteCount(initialUpvotes?.length || 0);
  }, [userID, initialUpvotes, gameId]);

  const handleUpvote = useCallback(async () => {
    if (!userID || isLoading) return;

    setIsLoading(true);
    const loaderTimeout = setTimeout(() => setShowLoader(true), 200);

    const originalIsUpvoted = isUpvoted;
    const originalCount = localUpvoteCount;

    const newIsUpvoted = !isUpvoted;
    setIsUpvoted(newIsUpvoted);
    setLocalUpvoteCount((prevCount) => (newIsUpvoted ? prevCount + 1 : Math.max(0, prevCount - 1)));

    try {
      const res = await fetch('/api/custom/upvotes/' + gameId, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + pb.authStore.token,
        },
      });
      if (!res.ok) {
          const errorBody = await res.text();
          throw new Error(`Upvote request failed with status ${res.status}: ${errorBody}`);
      }
      const resJSON = await res.json();
      const { count }: { count: number } = resJSON;

      if (count !== undefined && count !== localUpvoteCount) {
         setLocalUpvoteCount(count);
      }

      if (onUpvoteChange) onUpvoteChange();

    } catch(error) {
        console.error("Failed to upvote:", error);
        setIsUpvoted(originalIsUpvoted);
        setLocalUpvoteCount(originalCount);
    } finally {
      clearTimeout(loaderTimeout);
      setShowLoader(false);
      setIsLoading(false);
    }
  }, [gameId, isUpvoted, localUpvoteCount, onUpvoteChange, userID, isLoading]);

  const heartColor = theme.palette.secondary.main;

  return (
    <Box sx={{ mt: 2 }}>
      {/* Блок с лайками */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, height: 40, mb: 1 }}>
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
                  backgroundColor: !userID || isLoading ? 'transparent' : 'rgba(255, 255, 255, 0.08)',
                },
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
              }}
            >
              {showLoader && (
                   <CircularProgress
                      size={24}
                      color="inherit"
                      sx={{
                         position: 'absolute',
                         top: '50%',
                         left: '50%',
                         marginTop: '-12px',
                         marginLeft: '-12px',
                         zIndex: 1,
                       }}
                    />
              )}
              <Box
                sx={{
                  width: 72,
                  height: 72,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: showLoader ? 0 : 1,
                }}
              >
                <DotLottieReact
                  key={isUpvoted ? 'upvoted' : 'not-upvoted'}
                  src="/like.lottie"
                  loop={false}
                  autoplay={isUpvoted}
                  style={{
                    width: '72px',
                    height: '72px',
                    color: heartColor,
                  }}
                />
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

      {/* Передаем связи в RelatedGamesList. Этот компонент теперь умеет работать с языками. */}
      <RelatedGamesList relationships={relatedGames} currentGameId={gameId} />

    </Box>
  );
}