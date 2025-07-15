import React, { useState, useEffect, useContext } from 'react';
import { Box, Typography, Grid2, Collapse, IconButton, Pagination } from '@mui/material';
import { styled } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import GameCard from '../GameCard';
import { AuthContext, gamesCollection, Game } from '../../pocketbase/pocketbase';

const StyledSection = styled(Box)(({ theme }) => ({
  backgroundColor: '#2e2e2e',
  padding: theme.spacing(2),
  borderRadius: 8,
  margin: theme.spacing(2, 0),
  color: '#e0e0e0',
  cursor: 'pointer',
}));

const HeaderBox = styled(Box)(() => ({
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
}));

const PaginationBox = styled(Box)(({ theme }) => ({
  display: 'flex',
  justifyContent: 'center',
  marginTop: theme.spacing(2),
}));

export default function LikedGamesSection() {
  const { user } = useContext(AuthContext);
  const [likedGames, setLikedGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const gamesPerPage = 16; // Количество игр на странице
  
  const [isExpanded, setIsExpanded] = useState<boolean>(() => {
    const savedState = localStorage.getItem('likedGamesSectionExpanded');
    return savedState !== null ? JSON.parse(savedState) : true;
  });

  useEffect(() => {
    if (!user?.id) return;

    const fetchLikedGames = async () => {
      setLoading(true);
      try {
        const result = await gamesCollection.getList(page, gamesPerPage, {
          filter: `upvotes ?~ "${user.id}"`,
          expand: 'tags,authors',
          sort: '-created',
        });
        setLikedGames(result.items);
        setTotalPages(Math.ceil(result.totalItems / gamesPerPage));
      } catch (error) {
        console.error('Ошибка при загрузке лайкнутых игр:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchLikedGames();
  }, [user?.id, page]);

  useEffect(() => {
    localStorage.setItem('likedGamesSectionExpanded', JSON.stringify(isExpanded));
  }, [isExpanded]);

  const handleHeaderClick = () => {
    setIsExpanded((prev) => !prev);
  };

  const handleIconClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded((prev) => !prev);
  };

  const handlePageChange = (value: number) => {
    setPage(value);
  };

  return (
    <StyledSection>
      <HeaderBox onClick={handleHeaderClick}>
        <Typography variant="h6">Liked Games</Typography>
        <IconButton onClick={handleIconClick} size="small" sx={{ color: '#e0e0e0' }}>
          {isExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </IconButton>
      </HeaderBox>
      <Collapse in={isExpanded} timeout="auto" unmountOnExit>
        {loading ? (
          <Typography>Loading your liked games...</Typography>
        ) : likedGames.length > 0 ? (
          <>
            <Grid2 container spacing={2} justifyContent="center" sx={{ mt: 1 }}>
              {likedGames.map((game) => (
                <Grid2 size={{ xs: 12, sm: 6, md: 3, lg: 3 }} key={game.id}>
                  <GameCard game={game} variant="simplified" />
                </Grid2>
              ))}
            </Grid2>
            {totalPages > 1 && (
              <PaginationBox>
                <Pagination
                  count={totalPages}
                  page={page}
                  onChange={(_, value) => handlePageChange(value)}
                  color="primary"
                  sx={{ 
                    '& .MuiPaginationItem-root': { 
                      color: '#e0e0e0',
                      '&.Mui-selected': {
                        backgroundColor: '#1976d2',
                      },
                    } 
                  }}
                />
              </PaginationBox>
            )}
          </>
        ) : (
          <Typography>You haven’t liked any games yet!</Typography>
        )}
      </Collapse>
    </StyledSection>
  );
}