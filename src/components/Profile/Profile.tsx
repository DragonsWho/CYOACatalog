// src/components/Profile/Profile.tsx

import { useContext } from 'react';
import { Container, Typography, Paper, Divider, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import { styled } from '@mui/material/styles';
import SettingsIcon from '@mui/icons-material/Settings';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';

import LikedGamesSection from './LikedGamesSection';
import { AuthContext, Tag } from '../../pocketbase/pocketbase';
import BlockedTagsSettings from './BlockedTagsSettings';
import BlockedGamesSettings from './BlockedGamesSettings';
import AccountSettings from './AccountSettings';
import AvatarSettings from './AvatarSettings';

// Кастомный стиль для Accordion, чтобы он выглядел как ваши StyledPaper
const StyledAccordion = styled(Accordion)(({ theme }) => ({
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: '8px !important', // Force border radius
  margin: theme.spacing(3, 0),
  '&:before': {
    display: 'none', // Убираем дефолтную линию MUI
  },
  '&.Mui-expanded': {
    margin: theme.spacing(3, 0),
  }
}));

const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

interface ProfileProps {
    blockedTags: Tag[];
    onBlockedTagsUpdate: () => void;
    allTags: string[];
    blockedGameIds: string[];
    onBlockedGamesUpdate: () => void;
}

export default function Profile({
  blockedTags,
  onBlockedTagsUpdate,
  allTags,
  blockedGameIds,
  onBlockedGamesUpdate,
}: ProfileProps) {
  const { user } = useContext(AuthContext);
  const username = user?.username || 'Guest';

  return (
    <Container maxWidth="md">
      <Typography variant="h4" component="h1" gutterBottom sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }} >
        Welcome, {username}!
      </Typography>

      {/* 0. Профиль: аватар (незалоченная секция — выбор аватара не должен
             требовать «manage account»-подтверждения). */}
      {user && (
        <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <AccountCircleIcon /> Profile
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }} />
          <AvatarSettings />
        </StyledPaper>
      )}

      {/* 1. Секция настроек тегов (теперь сверху) */}
      <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
             <SettingsIcon /> Content Preferences
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }}/>

          {user ? (
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

      {/* 1b. Скрытые игры — персональный тихий блеклист (рядом с забаненными тегами).
             Свёрнуто по умолчанию: обычно открывают, только чтобы вернуть игру. */}
      <StyledAccordion elevation={3}>
        <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: '#e0e0e0' }} />}>
          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <VisibilityOffOutlinedIcon /> Hidden Games
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 3, pt: 0 }}>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }} />
          {user ? (
            <BlockedGamesSettings blockedGameIds={blockedGameIds} onBlockedGamesUpdate={onBlockedGamesUpdate} />
          ) : (
            <Typography variant="body2" color="text.secondary">
              Login to manage your hidden games.
            </Typography>
          )}
        </AccordionDetails>
      </StyledAccordion>

      {/* 2. Нижний блок: Лайкнутые игры */}
      <LikedGamesSection />

      {/* 3. Секция настроек аккаунта (Свернута, в самом низу) */}
      <StyledAccordion elevation={3}>
        <AccordionSummary
          expandIcon={<ExpandMoreIcon sx={{ color: '#e0e0e0' }} />}
        >
          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
             <ManageAccountsIcon /> Account Management
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ p: 3, pt: 0 }}>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }}/>
          {user ? (
              <AccountSettings /> 
          ) : (
              <Typography variant="body2" color="text.secondary">
                  Please log in to manage your account settings.
              </Typography>
          )}
        </AccordionDetails>
      </StyledAccordion>

    </Container>
  );
}