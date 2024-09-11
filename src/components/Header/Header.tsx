// src/components/Header/Header.jsx
// Version: 1.9.0
// Description:  working with searchbar

import { useContext, useState } from 'react';
import { AppBar, Toolbar, Typography, Box, Tooltip, Container, SvgIcon, useTheme } from '@mui/material';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import UnifiedSearchBar from './UnifiedSearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import Button from '@mui/material/Button';
import { AuthContext } from '../../pocketbase/pocketbase';

const SITE_TITLE = 'CYOA.CAFE';
const ADD_CYOA_TEXT = 'Add CYOA';
const LOGIN_TEXT = 'Login';
const LOGIN_TOOLTIP = 'Login to add a CYOA';
const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';

const DiscordIcon = () => (
  <SvgIcon>
    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z" />
    </SvgIcon>
);

interface HeaderProps {
  tags: string[];
  authors: string[];
  selectedTags: string[];
  selectedAuthors: string[];
  onTagChange: (tags: string[]) => void;
  onAuthorChange: (authors: string[]) => void;
}

export default function Header({ 
  tags,
  authors,
  selectedTags,
  selectedAuthors,
  onTagChange,
  onAuthorChange
}: HeaderProps)  {
  const { signedIn, user } = useContext(AuthContext);
  const [loginOpen, setLoginOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();

  const handleTagOrAuthorChange = (newTags: string[], newAuthors: string[]) => {
    onTagChange(newTags);
    onAuthorChange(newAuthors);
    if (location.pathname !== '/') {
      navigate('/');
    }
  };

  return (
    <>
      <AppBar position="static" sx={{ width: '100%' }}>
        <Container maxWidth="lg">
          <Toolbar disableGutters>
            <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography component={Link} to="/" variant="h6" sx={{
                color: theme.palette.primary.main, // Убедитесь, что цвет установлен правильно
                textDecoration: 'none',
                fontWeight: 'bold',
                '&:hover': {
                  color: theme.palette.primary.light,
                },
                transition: 'color 0.3s ease',
              }}>
                {SITE_TITLE}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <UnifiedSearchBar
                  tags={tags}
                  authors={authors}
                  selectedTags={selectedTags}
                  selectedAuthors={selectedAuthors}
                  onTagChange={(newTags) => handleTagOrAuthorChange(newTags, selectedAuthors)}
                  onAuthorChange={(newAuthors) => handleTagOrAuthorChange(selectedTags, newAuthors)}
                />
                <Tooltip title="Join our Discord community!" arrow>
                  <Button
                    color="inherit"
                    href={DISCORD_INVITE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{
                      minWidth: 'auto',
                      padding: '4px',
                    }}
                    aria-label="Join Discord"
                  >
                    <DiscordIcon />
                  </Button>
                </Tooltip>
                <Tooltip title={signedIn ? '' : LOGIN_TOOLTIP} arrow>
                  <span>
                    <Button
                      color="inherit"
                      component={Link}
                      to="/create"
                      sx={{
                        ml: 1,
                        mr: 1,
                        opacity: signedIn ? 1 : 0.5,
                        '&.Mui-disabled': {
                          color: 'inherit',
                        },
                        fontSize: '0.875rem',
                        padding: '4px 10px',
                      }}
                      disabled={!signedIn}
                      aria-label={ADD_CYOA_TEXT}
                    >
                      {ADD_CYOA_TEXT}
                    </Button>
                  </span>
                </Tooltip>

                <Box sx={{ width: 120 }}>
                  {signedIn ? (
                    <UserMenu currentUser={user} />
                  ) : (
                    <Button
                      color="inherit"
                      onClick={() => setLoginOpen(true)}
                      sx={{
                        width: '100%',
                        justifyContent: 'center',
                        fontSize: '0.875rem',
                        padding: '4px 10px',
                      }}
                      aria-label={LOGIN_TEXT}
                    >
                      {LOGIN_TEXT}
                    </Button>
                  )}
                </Box>
              </Box>
            </Box>
          </Toolbar>
        </Container>
      </AppBar>
      <Login open={loginOpen} onClose={() => setLoginOpen(false)} onLoginSuccess={() => setLoginOpen(false)} />
    </>
  );
}