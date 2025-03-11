// src/components/Profile/LikedGamesSection.tsx
import React, { useState, useEffect, useContext } from 'react';
import { Box, Typography, Grid2, Collapse, IconButton } from '@mui/material';
import { styled } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import GameCard from '../GameCard';
import { AuthContext, gamesCollection, Game } from '../../pocketbase/pocketbase';

// Option 1: Remove unused theme parameter if you don't need theme-based styling
const StyledSection = styled(Box)(({ theme }) => ({
  backgroundColor: '#2e2e2e',
  padding: theme.spacing(2),
  borderRadius: 8,
  margin: theme.spacing(2, 0),
  color: '#e0e0e0',
  cursor: 'pointer',
}));

// Option 1: Remove theme if not needed
const HeaderBox = styled(Box)(() => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}));

// Option 2: If you want to keep theme for future use, use it in the styles
/*
const HeaderBox = styled(Box)(({ theme }) => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: theme.spacing(1), // Example usage of theme
}));
*/

export default function LikedGamesSection() {
  const { user } = useContext(AuthContext);
  const [likedGames, setLikedGames] = useState<Game[]>([]); // Added type for better TypeScript support
  const [loading, setLoading] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (!user?.id) return;

    const fetchLikedGames = async () => {
      setLoading(true);
      try {
        const result = await gamesCollection.getList(1, 50, {
          filter: `upvotes ?~ "${user.id}"`,
          expand: 'tags,authors_via_games',
          sort: '-created',
        });
        setLikedGames(result.items);
      } catch (error) {
        console.error('Ошибка при загрузке лайкнутых игр:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLikedGames();
  }, [user?.id]);

  const handleHeaderClick = () => {
    setIsExpanded(!isExpanded);
  };

  const handleIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  return (
    <StyledSection onClick={handleHeaderClick}>
      <HeaderBox>
        <Typography variant="h6">Liked Games</Typography>
        <IconButton onClick={handleIconClick} size="small">
          {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </HeaderBox>
      <Collapse in={isExpanded}>
        {loading ? (
          <Typography>Loading your liked games...</Typography>
        ) : likedGames.length > 0 ? (
          <Grid2 container spacing={2}>
            {likedGames.map((game) => (
              <Grid2 key={game.id}>
                <GameCard game={game} />
              </Grid2>
            ))}
          </Grid2>
        ) : (
          <Typography>You haven’t liked any games yet!</Typography>
        )}
      </Collapse>
    </StyledSection>
  );
}