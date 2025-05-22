// src/components/Header/Header.tsx
import React, { useContext, useState, memo } from 'react';
import { AppBar, Toolbar, Typography, Box, Tooltip, Container, SvgIcon, useTheme } from '@mui/material';
import { Link } from 'react-router-dom';
import UnifiedSearchBar from './UnifiedSearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import Button from '@mui/material/Button';
import FilterSwitch from './FilterSwitch';
import { AuthContext } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import ForumIcon from '@mui/icons-material/Forum';
import AddIcon from '@mui/icons-material/Add'; // <-- Импорт AddIcon
import LoginIcon from '@mui/icons-material/Login'; // <-- Импорт LoginIcon

// Константы
const SITE_TITLE = 'CYOA.CAFE';
// Убрали ADD_CYOA_TEXT и LOGIN_TEXT
const LOGIN_TOOLTIP_FOR_ADD_BUTTON = 'Login to add a CYOA'; // Тултип для кнопки "Add CYOA", если не залогинен
const ADD_CYOA_TOOLTIP_LOGGED_IN = "Feel free to add more CYOAs!"; // Тултип для кнопки "Add CYOA", если залогинен
const ADD_CYOA_ARIA_LABEL = "Add CYOA";

const LOGIN_BUTTON_TOOLTIP = "Login"; // Тултип для кнопки логина (иконки)
const LOGIN_BUTTON_ARIA_LABEL = "Login";

const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';
const FORUM_URL = 'https://forum.cyoa.cafe';
const FORUM_TEXT = 'Forum';

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
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
}

const Header: React.FC<HeaderProps> = ({
    tags,
    authors,
    selectedTags,
    selectedAuthors,
    onTagChange,
    onAuthorChange,
    filterMode,
    onFilterModeChange,
}) => {
    const { signedIn, user } = useContext(AuthContext);
    const [loginOpen, setLoginOpen] = useState(false);
    const theme = useTheme();

    return (
        <>
            <AppBar position="static" sx={{ width: '100%' }}>
                <Container maxWidth="lg">
                    <Toolbar disableGutters>
                        <Typography
                            component={Link}
                            to="/"
                            variant="h6"
                            sx={{
                                color: theme.palette.primary.main,
                                textDecoration: 'none',
                                fontWeight: 'bold',
                                '&:hover': { color: theme.palette.primary.light, },
                                transition: 'color 0.3s ease',
                                mr: 2,
                                flexShrink: 0,
                            }}
                        >
                            {SITE_TITLE}
                        </Typography>

                        <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, justifyContent: 'flex-end', gap: 1.5 }}>

                            <FilterSwitch
                                filterMode={filterMode}
                                onFilterModeChange={onFilterModeChange}
                            />

                            <UnifiedSearchBar
                                tags={tags} authors={authors} selectedTags={selectedTags} selectedAuthors={selectedAuthors}
                                onTagChange={onTagChange} onAuthorChange={onAuthorChange}
                            />

                            <Tooltip title={`Go to ${FORUM_TEXT}`} arrow>
                                <Button
                                    color="inherit"
                                    href={FORUM_URL}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    sx={{ minWidth: 'auto', padding: '4px 10px', fontSize: '0.875rem' }}
                                    aria-label={FORUM_TEXT}
                                    startIcon={<ForumIcon sx={{ fontSize: '1.25rem' }} />}
                                > 
                                </Button>
                            </Tooltip>

                            <Tooltip title="Join our Discord community!" arrow>
                                <Button color="inherit" href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" sx={{ minWidth: 'auto', padding: '4px' }} aria-label="Join Discord">
                                    <DiscordIcon />
                                </Button>
                            </Tooltip>

                            {/* --- ИЗМЕНЕННАЯ КНОПКА "Add CYOA" --- */}
                            <Tooltip title={signedIn ? ADD_CYOA_TOOLTIP_LOGGED_IN : LOGIN_TOOLTIP_FOR_ADD_BUTTON} arrow>
                                <span> {/* Обертка span для корректного отображения Tooltip на disabled кнопке */}
                                    <Button
                                        color="inherit"
                                        component={Link}
                                        to="/create"
                                        sx={{
                                            minWidth: 'auto', // Для компактности кнопки-иконки
                                            padding: '6px',   // Паддинг для иконки
                                            opacity: signedIn ? 1 : 0.5,
                                            '&.Mui-disabled': { color: 'inherit' }, // Сохраняем цвет иконки при disabled
                                        }}
                                        disabled={!signedIn}
                                        aria-label={ADD_CYOA_ARIA_LABEL}
                                    >
                                        <AddIcon sx={{ fontSize: '1.5rem' }} /> {/* Иконка плюса, размер можно настроить */}
                                    </Button>
                                </span>
                            </Tooltip>
                            {/* --- КОНЕЦ ИЗМЕНЕННОЙ КНОПКИ "Add CYOA" --- */}

                            {/* --- ИЗМЕНЕННЫЙ БЛОК LOGIN/USERMENU --- */}
                            <Box sx={{ width: 'auto', minWidth: { xs: 'auto', sm: 50 } , display: 'flex', justifyContent: 'center' }}> {/* minWidth изменен, чтобы лучше подходить иконке */}
                                {signedIn ? (
                                    <UserMenu currentUser={user} />
                                ) : (
                                    <Tooltip title={LOGIN_BUTTON_TOOLTIP} arrow>
                                        <Button
                                            color="inherit"
                                            onClick={() => setLoginOpen(true)}
                                            sx={{
                                                minWidth: 'auto', // Для компактности кнопки-иконки
                                                padding: '6px',   // Паддинг для иконки
                                                // width: '100%', // Убрано, чтобы кнопка не растягивалась на весь minWidth Box
                                                // justifyContent: 'center' // Уже по умолчанию для Button с иконкой
                                            }}
                                            aria-label={LOGIN_BUTTON_ARIA_LABEL}
                                        >
                                            <LoginIcon sx={{ fontSize: '1.5rem' }} /> {/* Иконка логина, размер можно настроить */}
                                        </Button>
                                    </Tooltip>
                                )}
                            </Box>
                            {/* --- КОНЕЦ ИЗМЕНЕННОГО БЛОКА LOGIN/USERMENU --- */}
                        </Box>
                    </Toolbar>
                </Container>
            </AppBar>
            <Login open={loginOpen} onClose={() => setLoginOpen(false)} onLoginSuccess={() => setLoginOpen(false)} />
        </>
    );
};

export default memo(Header);