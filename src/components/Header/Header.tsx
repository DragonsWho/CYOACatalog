// src/components/Header/Header.tsx
import React, { useContext, useState, memo } from 'react';
import { AppBar, Toolbar, Typography, Box, Tooltip, Container, SvgIcon, useTheme, useMediaQuery, Button, SvgIconProps } from '@mui/material';
import { Link } from 'react-router-dom';
import UnifiedSearchBar from './UnifiedSearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import FilterSwitch from './FilterSwitch';
import { AuthContext } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import ForumIcon from '@mui/icons-material/Forum';
import AddIcon from '@mui/icons-material/Add';
import LoginIcon from '@mui/icons-material/Login';

// Константы
const SITE_TITLE = 'CYOA.CAFE';
const LOGIN_TOOLTIP_FOR_ADD_BUTTON = 'Login to add a CYOA';
const ADD_CYOA_TOOLTIP_LOGGED_IN = "Feel free to add more CYOAs!";
const ADD_CYOA_ARIA_LABEL = "Add CYOA";

const LOGIN_BUTTON_TOOLTIP = "Login";
const LOGIN_BUTTON_ARIA_LABEL = "Login";

const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';
const FORUM_URL = 'https://forum.cyoa.cafe';
const FORUM_TEXT_LABEL = 'Forum'; // Текстовая метка для кнопки
const FORUM_TOOLTIP_TEXT = 'Go to Forum'; // Тултип для кнопки


const DiscordSvgIcon: React.FC<SvgIconProps> = (props) => (
    <SvgIcon {...props}>
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

    const isMobile = useMediaQuery(theme.breakpoints.down('sm')); // < 600px
    const isBelow400px = useMediaQuery('(max-width:399px)');    // < 400px

    const logoFontSize = isMobile
        ? (isBelow400px ? '1.0rem' : '1.15rem')
        : theme.typography.h6.fontSize;

    const iconButtonPaddingValue = isMobile
        ? (isBelow400px ? '4px' : '5px')
        : '6px'; // Базовый вертикальный padding для иконок-кнопок

    // Для кнопок с текстом на десктопе, паддинги могут быть другими
    const textButtonPaddingDesktop = `${theme.spacing(0.75)} ${theme.spacing(1.5)}`; // ~6px 12px

    const generalIconFontSizeValue = isMobile
        ? (isBelow400px ? '1.1rem' : '1.25rem')
        : '1.35rem';

    const primaryIconFontSizeValue = isMobile
        ? (isBelow400px ? '1.2rem' : '1.4rem')
        : '1.5rem';

    return (
        <>
            <AppBar position="static" sx={{ width: '100%' }}>
                <Container maxWidth="lg">
                    <Toolbar
                        disableGutters
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            width: '100%',
                            justifyContent: { xs: 'space-between', sm: 'flex-start' },
                            // Добавляем небольшой отступ между элементами на десктопе для лучшего вида
                            gap: { sm: theme.spacing(0.5) } 
                        }}
                    >
                        <Typography
                            component={Link}
                            to="/"
                            sx={{
                                color: theme.palette.primary.main,
                                textDecoration: 'none',
                                fontWeight: 'bold',
                                '&:hover': { color: theme.palette.primary.light },
                                transition: 'color 0.3s ease',
                                fontSize: logoFontSize,
                                mr: { xs: 0, sm: 1 }, // Уменьшил немного отступ для десктопа, т.к. есть gap
                                lineHeight: 1.5,
                                flexShrink: 0,
                            }}
                        >
                            {SITE_TITLE}
                        </Typography>

                        <Box sx={{ display: { xs: 'none', sm: 'flex' }, flexGrow: 1 }} />

                        <FilterSwitch
                            filterMode={filterMode}
                            onFilterModeChange={onFilterModeChange}
                            isBelow400px={isBelow400px}
                        />

                        <UnifiedSearchBar
                            tags={tags} authors={authors} selectedTags={selectedTags} selectedAuthors={selectedAuthors}
                            onTagChange={onTagChange} onAuthorChange={onAuthorChange}
                            currentBreakpointIconSize={generalIconFontSizeValue}
                            currentBreakpointPadding={iconButtonPaddingValue}
                        />

                        {/* --- ИЗМЕНЕННАЯ КНОПКА FORUM --- */}
                        <Tooltip title={FORUM_TOOLTIP_TEXT} arrow>
                            <Button
                                color="inherit"
                                href={FORUM_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{
                                    minWidth: 'auto',
                                    // Адаптивный padding: иконка на мобильных, иконка+текст на десктопе
                                    padding: {
                                        xs: iconButtonPaddingValue,
                                        sm: textButtonPaddingDesktop
                                    },
                                    // Стили для иконки внутри кнопки
                                    '& .MuiButton-startIcon': {
                                        // Убираем отступ справа от иконки, если текста нет (мобильная версия)
                                        marginRight: { xs: 0, sm: theme.spacing(0.75) }, // Отступ между иконкой и текстом на десктопе
                                        // marginLeft: { xs: 0, sm: -theme.spacing(0.5)} // Можно немного сдвинуть иконку влево если нужно
                                    },
                                    textTransform: 'none', // Чтобы текст "Forum" был не в верхнем регистре
                                    fontSize: { sm: '0.875rem' } // Размер текста для десктопа
                                }}
                                aria-label={FORUM_TEXT_LABEL}
                                startIcon={<ForumIcon sx={{ fontSize: generalIconFontSizeValue }} />}
                            >
                                {/* Текст кнопки Forum, отображается только на sm (десктоп) и выше */}
                                <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
                                    {FORUM_TEXT_LABEL}
                                </Box>
                                {/* 
                                  Чтобы убрать надпись "Forum" на десктопе и оставить только иконку,
                                  нужно удалить или закомментировать <Box> выше, который содержит {FORUM_TEXT_LABEL},
                                  а также можно скорректировать padding для 'sm' обратно к iconButtonPaddingValue, если нужно:     11111111111111111111111111111111111111111111111111111111111111111111111
                                  padding: iconButtonPaddingValue,
                                  И убрать/закомментировать '.MuiButton-startIcon' marginRight для 'sm'.
                                */}
                            </Button>
                        </Tooltip>
                        {/* --- КОНЕЦ ИЗМЕНЕННОЙ КНОПКИ FORUM --- */}


                        <Tooltip title="Join our Discord community!" arrow>
                            <Button
                                color="inherit"
                                href={DISCORD_INVITE_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                sx={{ minWidth: 'auto', padding: iconButtonPaddingValue }}
                                aria-label="Join Discord"
                            >
                                <DiscordSvgIcon sx={{ fontSize: generalIconFontSizeValue }} />
                            </Button>
                        </Tooltip>

                        <Tooltip title={signedIn ? ADD_CYOA_TOOLTIP_LOGGED_IN : LOGIN_TOOLTIP_FOR_ADD_BUTTON} arrow>
                            <span>
                                <Button
                                    color="inherit"
                                    component={Link}
                                    to="/create"
                                    sx={{
                                        minWidth: 'auto',
                                        padding: iconButtonPaddingValue,
                                        opacity: signedIn ? 1 : 0.5,
                                        '&.Mui-disabled': { color: 'inherit' },
                                    }}
                                    disabled={!signedIn}
                                    aria-label={ADD_CYOA_ARIA_LABEL}
                                >
                                    <AddIcon sx={{ fontSize: primaryIconFontSizeValue }} />
                                </Button>
                            </span>
                        </Tooltip>

                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                            {signedIn ? (
                                <UserMenu
                                    currentUser={user}
                                    isMobile={isMobile}
                                    isBelow400px={isBelow400px}
                                />
                            ) : (
                                <Tooltip title={LOGIN_BUTTON_TOOLTIP} arrow>
                                    <Button
                                        color="inherit"
                                        onClick={() => setLoginOpen(true)}
                                        sx={{
                                            minWidth: 'auto',
                                            padding: iconButtonPaddingValue,
                                        }}
                                        aria-label={LOGIN_BUTTON_ARIA_LABEL}
                                    >
                                        <LoginIcon sx={{ fontSize: primaryIconFontSizeValue }} />
                                    </Button>
                                </Tooltip>
                            )}
                        </Box>
                    </Toolbar>
                </Container>
            </AppBar>
            <Login open={loginOpen} onClose={() => setLoginOpen(false)} onLoginSuccess={() => setLoginOpen(false)} />
        </>
    );
};

export default memo(Header);