// src/components/Header/Header.tsx
import React, { useContext, useState, memo } from 'react';
import { AppBar, Toolbar, Typography, Box, Tooltip, Container, SvgIcon, useTheme, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { Link } from 'react-router-dom';
import UnifiedSearchBar from './UnifiedSearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import Button from '@mui/material/Button';
import { AuthContext } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../App';

// Константы, цвета, размеры...
const SITE_TITLE = 'CYOA.CAFE';
const ADD_CYOA_TEXT = 'Add CYOA';
const LOGIN_TEXT = 'Login';
const LOGIN_TOOLTIP = 'Login to add a CYOA';
const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';
const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd';
const trackColor = '#616161';
// Убираем labelColor, будем использовать цвет из темы
// const labelColor = '#e0e0e0';
const trackHeight = 28;
const trackWidth = 70;
const thumbSize = 20;
const visualThumbHorizontalPadding = 3;

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
    const theme = useTheme(); // Получаем доступ к теме

    const handleFilterChange = (
        _event: React.MouseEvent<HTMLElement>,
        newMode: FilterMode | null,
    ) => {
        if (newMode !== null && newMode !== filterMode) {
            onFilterModeChange(newMode);
        }
    };

    const getThumbStyles = (mode: FilterMode) => {
        let left: number;
        let backgroundColor = sfwColor;
        switch (mode) {
            case 'sfw': left = visualThumbHorizontalPadding; backgroundColor = sfwColor; break;
            case 'all': left = (trackWidth / 2) - (thumbSize / 2); backgroundColor = allColor; break;
            case 'nsfw': left = trackWidth - thumbSize - visualThumbHorizontalPadding - 2; backgroundColor = nsfwColor; break;
            default: left = visualThumbHorizontalPadding; backgroundColor = sfwColor;
        }
        return { left: `${left}px`, backgroundColor: backgroundColor };
    };

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

                            {/* Контейнер для переключателя и меток */}
                            <Box sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 0.8,
                                flexShrink: 0,
                                minWidth: 120, // Оставляем для стабильности
                                contain: 'layout', // Оставляем для стабильности
                            }}>
                                {/* --- ИЗМЕНЕНИЯ ЗДЕСЬ (метка SFW) --- */}
                                <Typography
                                  variant="caption"
                                  sx={{
                                    // color: labelColor, // Заменено
                                    color: theme.palette.grey[500], // Новый цвет
                                    fontWeight: 'medium',
                                    userSelect: 'none',
                                    textTransform: 'uppercase' // Заглавные буквы
                                  }}
                                >
                                    sfw
                                </Typography>
                                {/* --- КОНЕЦ ИЗМЕНЕНИЙ --- */}

                                <ToggleButtonGroup
                                    value={filterMode}
                                    exclusive
                                    onChange={handleFilterChange}
                                    aria-label="Content filter"
                                    sx={{
                                        position: 'relative',
                                        width: `${trackWidth}px`,
                                        height: `${trackHeight}px`,
                                        borderRadius: `${trackHeight / 2}px`,
                                        border: `1px solid ${trackColor}`,
                                        backgroundColor: 'transparent',
                                        p: 0,
                                        display: 'flex',
                                        overflow: 'hidden',
                                        boxSizing: 'border-box',
                                    }}
                                >
                                    <Box
                                        sx={{
                                            position: 'absolute',
                                            top: '50%',
                                            transform: 'translateY(-50%)',
                                            ...getThumbStyles(filterMode),
                                            width: `${thumbSize}px`,
                                            height: `${thumbSize}px`,
                                            borderRadius: '50%',
                                            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                                            zIndex: 1,
                                            transition: theme.transitions.create(['left', 'background-color'], {
                                                duration: theme.transitions.duration.short,
                                                easing: theme.transitions.easing.easeInOut,
                                            }),
                                        }}
                                    />
                                    {['sfw', 'all', 'nsfw'].map((mode) => (
                                        <ToggleButton
                                            key={mode} value={mode} aria-label={mode} disableRipple
                                            sx={{
                                                flex: 1, border: 'none !important', padding: '0 !important', margin: 0,
                                                backgroundColor: 'transparent !important', color: 'transparent', zIndex: 2,
                                                outline: 'none !important',
                                                '&:hover': { backgroundColor: 'transparent !important' },
                                                '&.Mui-focusVisible': { backgroundColor: 'transparent !important', outline: 'none !important' },
                                            }}
                                        >
                                            <span style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>{mode}</span>
                                        </ToggleButton>
                                    ))}
                                </ToggleButtonGroup>

                                {/* --- ИЗМЕНЕНИЯ ЗДЕСЬ (метка NSFW) --- */}
                                <Typography
                                  variant="caption"
                                  sx={{
                                    // color: labelColor, // Заменено
                                    color: theme.palette.grey[500], // Новый цвет
                                    fontWeight: 'medium',
                                    userSelect: 'none',
                                    textTransform: 'uppercase' // Заглавные буквы
                                  }}
                                >
                                    nsfw
                                </Typography>
                                {/* --- КОНЕЦ ИЗМЕНЕНИЙ --- */}
                            </Box>

                            {/* Остальные элементы хедера */}
                            <UnifiedSearchBar
                                tags={tags} authors={authors} selectedTags={selectedTags} selectedAuthors={selectedAuthors}
                                onTagChange={onTagChange} onAuthorChange={onAuthorChange}
                            />
                            <Tooltip title="Join our Discord community!" arrow>
                                <Button color="inherit" href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" sx={{ minWidth: 'auto', padding: '4px' }} aria-label="Join Discord">
                                    <DiscordIcon />
                                </Button>
                            </Tooltip>
                            <Tooltip title={signedIn ? '' : LOGIN_TOOLTIP} arrow>
                                <span>
                                    <Button
                                        color="inherit" component={Link} to="/create"
                                        sx={{
                                            opacity: signedIn ? 1 : 0.5, '&.Mui-disabled': { color: 'inherit' },
                                            fontSize: '0.875rem', padding: '4px 10px', minWidth: 'auto',
                                        }}
                                        disabled={!signedIn} aria-label={ADD_CYOA_TEXT}
                                    >
                                        {ADD_CYOA_TEXT}
                                    </Button>
                                </span>
                            </Tooltip>

                            <Box sx={{ width: 'auto', minWidth: 90 }}>
                                {signedIn ? (
                                    <UserMenu currentUser={user} />
                                ) : (
                                    <Button color="inherit" onClick={() => setLoginOpen(true)} sx={{ width: '100%', justifyContent: 'center', fontSize: '0.875rem', padding: '4px 10px' }} aria-label={LOGIN_TEXT}>
                                        {LOGIN_TEXT}
                                    </Button>
                                )}
                            </Box>
                        </Box>
                    </Toolbar>
                </Container>
            </AppBar>
            <Login open={loginOpen} onClose={() => setLoginOpen(false)} onLoginSuccess={() => setLoginOpen(false)} />
        </>
    );
};

export default memo(Header);