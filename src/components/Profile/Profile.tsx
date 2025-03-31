// src/components/Profile/Profile.tsx
import React, { useContext } from 'react'; // Добавили useContext
import { Container, Typography, Paper, List, ListItem, ListItemIcon, ListItemText, Divider } from '@mui/material'; // Добавили Divider
import { styled } from '@mui/material/styles';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import StarIcon from '@mui/icons-material/Star';
import LikedGamesSection from './LikedGamesSection';
// --- НАЧАЛО ИЗМЕНЕНИЙ ---
import { AuthContext, Tag } from '../../pocketbase/pocketbase'; // Импортируем AuthContext и Tag
import BlockedTagsSettings from './BlockedTagsSettings'; // Импортируем новый компонент
// --- КОНЕЦ ИЗМЕНЕНИЙ ---

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e', // Используем ваш темный цвет
  color: '#e0e0e0',
  borderRadius: 8,
}));

interface ListItemData {
  icon: React.ReactNode;
  text: string;
}

// --- НАЧАЛО ИЗМЕНЕНИЙ: Добавляем пропсы ---
interface ProfileProps {
    blockedTags: Tag[];
    onBlockedTagsUpdate: () => void;
    allTags: string[]; // Список имен всех тегов из App.tsx
}

export default function Profile({ blockedTags, onBlockedTagsUpdate, allTags }: ProfileProps) {
// --- КОНЕЦ ИЗМЕНЕНИЙ ---

  // Получаем имя пользователя из контекста
  const { user } = useContext(AuthContext);
  const username = user?.username || 'Guest'; // Безопасное получение имени

  const listItems: ListItemData[] = [
    { icon: <PersonIcon />, text: 'Personal information management, changing email and passwords and all that.' },
    // { icon: <SettingsIcon />, text: 'View settings and blocked tags like scat.' }, // Убрали, т.к. ниже будет секция
    { icon: <StarIcon />, text: 'Achievements, awards and other nice little things!' },
  ];

  return (
    <Container maxWidth="md">
      <Typography variant="h4" component="h1" gutterBottom sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }} >
        Welcome, {username}!
      </Typography>

      {/* Верхний блок с "Coming Soon" */}
      <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom>
            Coming Soon!
          </Typography>
          <Typography variant="body1" component="p" sx={{mb: 1}}>
            Some features are still under development. Here’s what you can expect in the future:
          </Typography>
          <List dense> {/* Сделали список плотнее */}
            {listItems.map((item, index) => (
              <ListItem key={index} sx={{py: 0.5}}> {/* Уменьшили вертикальные отступы */}
                <ListItemIcon sx={{ color: '#e0e0e0', minWidth: 'auto', mr: 1.5 }}>{item.icon}</ListItemIcon> {/* Уменьшили иконку и отступ */}
                <ListItemText primary={item.text} primaryTypographyProps={{variant: 'body2'}}/> {/* Уменьшили текст */}
              </ListItem>
            ))}
          </List>
          {/* <Box mt={2}> <Typography variant="body1" color="textSecondary"> Stay tuned for updates! </Typography> </Box> */}
      </StyledPaper>

      {/* --- НАЧАЛО ИЗМЕНЕНИЙ: Секция настроек --- */}
      <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
             <SettingsIcon /> Settings
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }}/>

          {/* Компонент управления блокировкой тегов */}
          {user ? ( // Показываем только авторизованным
               <BlockedTagsSettings
                  allTags={allTags}
                  initialBlockedTags={blockedTags}
                  onBlockedTagsUpdate={onBlockedTagsUpdate}
               />
          ) : (
              <Typography variant="body2" color="text.secondary">
                  Login to manage your blocked tags.
              </Typography>
          )}
      </StyledPaper>
      {/* --- КОНЕЦ ИЗМЕНЕНИЙ --- */}


      {/* Нижний блок: Лайкнутые игры */}
      <LikedGamesSection />
    </Container>
  );
}