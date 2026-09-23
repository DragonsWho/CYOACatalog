import { useContext } from 'react';
import { Container, Typography, Paper, Divider, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import { styled } from '@mui/material/styles';
import SettingsIcon from '@mui/icons-material/Settings';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';

import LikedGamesSection from './LikedGamesSection';
import { AuthContext, Tag } from '../../pocketbase/pocketbase';
import BlockedTagsSettings from './BlockedTagsSettings';
import BlockedAuthorsSettings from './BlockedAuthorsSettings';
import BlockedGamesSettings from './BlockedGamesSettings';
import AccountSettings from './AccountSettings';
import AvatarSettings from './AvatarSettings';
import ChatSettings from './ChatSettings';

const StyledAccordion = styled(Accordion)(({ theme }) => ({
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: '8px !important',
  margin: theme.spacing(3, 0),
  '&:before': {
    display: 'none',
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
    blockedAuthorIds: string[];
    onBlockedAuthorsUpdate: () => void;
}

export default function Profile({
  blockedTags,
  onBlockedTagsUpdate,
  allTags,
  blockedGameIds,
  onBlockedGamesUpdate,
  blockedAuthorIds,
  onBlockedAuthorsUpdate,
}: ProfileProps) {
  const { user } = useContext(AuthContext);
  const username = user?.username || 'Guest';

  return (
    <Container maxWidth="md">
      <Typography variant="h4" component="h1" gutterBottom sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }} >
        Welcome, {username}!
      </Typography>

      {/*
        Avatar section is not locked: picking an avatar must not require the "manage account"
        confirmation.
      */}
      {user && (
        <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <AccountCircleIcon /> Profile
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }} />
          <AvatarSettings />
        </StyledPaper>
      )}

      <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
             <SettingsIcon /> Content Preferences
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }}/>

          {user ? (
            <>
               <BlockedTagsSettings
                  allTags={allTags}
                  initialBlockedTags={blockedTags}
                  onBlockedTagsUpdate={onBlockedTagsUpdate}
               />
               <Divider sx={{ my: 3, borderColor: 'rgba(224, 224, 224, 0.2)' }} />
               <BlockedAuthorsSettings
                  blockedAuthorIds={blockedAuthorIds}
                  onBlockedAuthorsUpdate={onBlockedAuthorsUpdate}
               />
            </>
          ) : (
              <Typography variant="body2" color="text.secondary">
                  Login to manage your blocked tags and authors.
              </Typography>
          )}
      </StyledPaper>

      {/*
        Hidden games (personal silent blocklist), collapsed by default: usually opened only to
        restore a game.
      */}
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

      {/*
        Chat visibility is not under "Account Management" (locked behind a confirmation phrase):
        it's a plain preference, not a dangerous operation.
      */}
      {user && (
        <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChatBubbleOutlineIcon /> Chat
          </Typography>
          <Divider sx={{ my: 2, borderColor: 'rgba(224, 224, 224, 0.2)' }} />
          <ChatSettings />
        </StyledPaper>
      )}

      <LikedGamesSection />

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