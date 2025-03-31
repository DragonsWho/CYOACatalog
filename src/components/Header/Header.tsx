// src/components/Header/Header.tsx
import { useContext, useState } from 'react';
import { AppBar, Toolbar, Typography, Box, Tooltip, Container, SvgIcon, useTheme, ToggleButtonGroup, ToggleButton } from '@mui/material'; // Добавили ToggleButtonGroup, ToggleButton
import { Link, useNavigate, useLocation } from 'react-router-dom';
import UnifiedSearchBar from './UnifiedSearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import Button from '@mui/material/Button';
import { AuthContext } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../App'; // Импортируем тип FilterMode

const SITE_TITLE = 'CYOA.CAFE';
const ADD_CYOA_TEXT = 'Add CYOA';
const LOGIN_TEXT = 'Login';
const LOGIN_TOOLTIP = 'Login to add a CYOA';
const DISCORD_INVITE_URL = 'https://discord.gg/9stHNfEskG';

// Цвета для переключателя
const sfwColor = '#4f7e50';
const nsfwColor = '#e8484e';
const allColor = 'grey.700'; // Нейтральный цвет для 'all'

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
    // --- НАЧАЛО ИЗМЕНЕНИЙ ---
    filterMode: FilterMode; // Добавляем текущий режим
    onFilterModeChange: (newMode: FilterMode) => void; // Добавляем обработчик изменения
    // --- КОНЕЦ ИЗМЕНЕНИЙ ---
}

export default function Header({
    tags,
    authors,
    selectedTags,
    selectedAuthors,
    onTagChange,
    onAuthorChange,
    // --- НАЧАЛО ИЗМЕНЕНИЙ ---
    filterMode,
    onFilterModeChange,
    // --- КОНЕЦ ИЗМЕНЕНИЙ ---
}: HeaderProps) {
    const { signedIn, user } = useContext(AuthContext);
    const [loginOpen, setLoginOpen] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    const theme = useTheme();

    function handleTagOrAuthorChange(newTags: string[], newAuthors: string[]) {
        onTagChange(newTags);
        onAuthorChange(newAuthors);
        if (location.pathname !== '/') navigate('/');
    }

    // --- НАЧАЛО ИЗМЕНЕНИЙ ---
    // Обработчик для ToggleButtonGroup
    const handleFilterChange = (
        event: React.MouseEvent<HTMLElement>,
        newMode: FilterMode | null, // MUI может вернуть null
    ) => {
        // Игнорируем, если пользователь отменил выбор (хотя exclusive должен предотвратить это)
        // или если выбранный режим уже активен
        if (newMode !== null && newMode !== filterMode) {
            onFilterModeChange(newMode);
            // Опционально: переходить на главную при смене фильтра?
            // if (location.pathname !== '/') navigate('/');
        }
    };
    // --- КОНЕЦ ИЗМЕНЕНИЙ ---

    return (
        <>
            <AppBar position="static" sx={{ width: '100%' }}>
                <Container maxWidth="lg">
                    <Toolbar disableGutters>
                        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography
                                component={Link}
                                to="/"
                                variant="h6"
                                sx={{
                                    color: theme.palette.primary.main,
                                    textDecoration: 'none',
                                    fontWeight: 'bold',
                                    '&:hover': {
                                        color: theme.palette.primary.light,
                                    },
                                    transition: 'color 0.3s ease',
                                    mr: 2, // Добавим отступ справа от логотипа
                                }}
                            >
                                {SITE_TITLE}
                            </Typography>

                             {/* --- НАЧАЛО ИЗМЕНЕНИЙ: Добавляем ToggleButtonGroup --- */}
                             <ToggleButtonGroup
                                value={filterMode}
                                exclusive // Только один выбор
                                onChange={handleFilterChange}
                                aria-label="Content filter"
                                size="small"
                                sx={{
                                    backgroundColor: 'rgba(255, 255, 255, 0.08)', // Легкий фон для группы
                                    borderRadius: '4px', // Скругление для группы
                                    mr: 2, // Отступ справа от переключателя
                                    height: '32px', // Фиксированная высота для выравнивания
                                }}
                            >
                                <ToggleButton
                                    value="sfw"
                                    aria-label="Show SFW only"
                                    sx={{
                                        color: filterMode === 'sfw' ? '#fff' : sfwColor, // Белый текст если выбрано, иначе зеленый
                                        backgroundColor: filterMode === 'sfw' ? sfwColor : 'transparent', // Зеленый фон если выбрано
                                        border: 'none', // Убираем рамки
                                        borderRadius: '4px', // Скругляем углы
                                        px: 1.5, // Горизонтальные отступы
                                        textTransform: 'none', // Убираем КАПС
                                        '&:hover': {
                                            // Легкое затемнение при наведении, если не выбрано
                                            backgroundColor: filterMode !== 'sfw' ? 'rgba(79, 126, 80, 0.2)' : sfwColor,
                                        },
                                        '&.Mui-selected': {
                                            // Стили для выбранной кнопки (переопределяем стандартные)
                                            backgroundColor: sfwColor,
                                            color: '#fff',
                                            '&:hover': {
                                                backgroundColor: sfwColor, // Не меняем цвет при наведении на выбранную
                                            }
                                        }
                                    }}
                                >
                                    SFW
                                </ToggleButton>
                                <ToggleButton
                                    value="all"
                                    aria-label="Show all"
                                     sx={{
                                        color: filterMode === 'all' ? '#fff' : allColor,
                                        backgroundColor: filterMode === 'all' ? allColor : 'transparent',
                                        border: 'none',
                                        borderLeft: `1px solid ${theme.palette.divider}`, // Разделитель слева
                                        borderRight: `1px solid ${theme.palette.divider}`, // Разделитель справа
                                        borderRadius: 0, // Убираем скругление для средней кнопки
                                        px: 1.5,
                                        textTransform: 'none',
                                         '&:hover': {
                                            backgroundColor: filterMode !== 'all' ? 'rgba(120, 120, 120, 0.2)' : allColor,
                                        },
                                        '&.Mui-selected': {
                                            backgroundColor: allColor,
                                            color: '#fff',
                                            '&:hover': {
                                                backgroundColor: allColor,
                                            }
                                        }
                                    }}
                                >
                                    All
                                </ToggleButton>
                                <ToggleButton
                                    value="nsfw"
                                    aria-label="Show NSFW only"
                                    sx={{
                                        color: filterMode === 'nsfw' ? '#fff' : nsfwColor,
                                        backgroundColor: filterMode === 'nsfw' ? nsfwColor : 'transparent',
                                        border: 'none',
                                        borderRadius: '4px',
                                        px: 1.5,
                                        textTransform: 'none',
                                         '&:hover': {
                                            backgroundColor: filterMode !== 'nsfw' ? 'rgba(232, 72, 78, 0.2)' : nsfwColor,
                                        },
                                        '&.Mui-selected': {
                                            backgroundColor: nsfwColor,
                                            color: '#fff',
                                            '&:hover': {
                                                backgroundColor: nsfwColor,
                                            }
                                        }
                                    }}
                                >
                                    NSFW
                                </ToggleButton>
                            </ToggleButtonGroup>
                            {/* --- КОНЕЦ ИЗМЕНЕНИЙ --- */}


                            <Box sx={{ display: 'flex', alignItems: 'center', flexGrow: 1, justifyContent: 'flex-end' }}> {/* Добавили flexGrow и justifyContent */}
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
                                            // --- НАЧАЛО ИЗМЕНЕНИЙ ---
                                            // Добавим немного отступа для иконки Discord
                                            ml: 1,
                                            mr: 1,
                                            // --- КОНЕЦ ИЗМЕНЕНИЙ ---
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
                                                // ml: 1, // Убрали ml, т.к. Discord теперь имеет отступы
                                                mr: 1,
                                                opacity: signedIn ? 1 : 0.5,
                                                '&.Mui-disabled': {
                                                    color: 'inherit',
                                                },
                                                fontSize: '0.875rem',
                                                padding: '4px 10px',
                                                minWidth: 'auto', // Чтобы кнопка не растягивалась
                                            }}
                                            disabled={!signedIn}
                                            aria-label={ADD_CYOA_TEXT}
                                        >
                                            {ADD_CYOA_TEXT}
                                        </Button>
                                    </span>
                                </Tooltip>

                                <Box sx={{ width: 'auto', minWidth: 90 }}> {/* Сделали ширину авто и задали минимум */}
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