// src/components/Profile/Profile.tsx
import React from 'react';
import { Container, Typography, Paper, Box, List, ListItem, ListItemIcon, ListItemText } from '@mui/material';
import { styled } from '@mui/material/styles';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import StarIcon from '@mui/icons-material/Star';
import LikedGamesSection from './LikedGamesSection';
import { pb } from '../../pocketbase/pocketbase'; // Импортируем PocketBase

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

interface ListItemData {
  icon: React.ReactNode;
  text: string;
}

export default function Profile() {
  // Получаем имя пользователя из авторизации PocketBase
  const username = pb.authStore.model?.username || 'Guest';

  const listItems: ListItemData[] = [
    {
      icon: <PersonIcon />,
      text: 'Personal information management, changing email and passwords and all that.',
    },
    { icon: <SettingsIcon />, text: 'View settings and blocked tags like scat.' },
    { icon: <StarIcon />, text: 'Achievements, awards and other nice little things!' },
  ];

  return (
    <Container maxWidth="md">
      {/* Объединенный заголовок с приветствием, увеличенного размера */}
      <Typography 
        variant="h4" 
        component="h1" 
        gutterBottom 
        sx={{ 
          mt: 4,
          color: '#e0e0e0', 
          textAlign: 'center',
          fontSize: { xs: '2rem', sm: '2.5rem' } // Адаптивный размер как у h4
        }}
      >
        Welcome, {username}!
      </Typography>
      
      {/* Верхний блок с "Coming Soon" */}
      <StyledPaper elevation={3}>
        <Box sx={{ mt: 2 }}>
          <Typography variant="h6" gutterBottom>
            Coming Soon!
          </Typography>
          <Typography variant="body1" component="p">
            Some features are still under development. Here’s what you can expect in the future:
          </Typography>
          <List>
            {listItems.map((item, index) => (
              <ListItem key={index}>
                <ListItemIcon sx={{ color: '#e0e0e0' }}>{item.icon}</ListItemIcon>
                <ListItemText primary={item.text} />
              </ListItem>
            ))}
          </List>
          <Box mt={2}>
            <Typography variant="body1" color="textSecondary">
              Stay tuned for updates!
            </Typography>
          </Box>
        </Box>
      </StyledPaper>

      {/* Нижний блок: Лайкнутые игры (сворачиваемый) */}
      <LikedGamesSection />
    </Container>
  );
}