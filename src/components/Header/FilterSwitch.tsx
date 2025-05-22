// src/components/Header/FilterSwitch.tsx
import React from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton, useTheme, useMediaQuery } from '@mui/material';
import type { FilterMode } from '../../types';

// Константы цветов
const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd'; // Цвет бегунка в состоянии "all"
const trackBorderColor = '#616161'; // Цвет рамки переключателя

// Размеры для десктопа
const DESKTOP_TRACK_HEIGHT = 28;
const DESKTOP_TRACK_WIDTH = 70;
const DESKTOP_THUMB_SIZE = 20;
const DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING = 3;

// Размеры для мобильных
const MOBILE_TRACK_HEIGHT = 26;
const MOBILE_TRACK_WIDTH = 70;
const MOBILE_THUMB_SIZE = 18;
const MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING = 3;
const MOBILE_INNER_LABEL_FONT_SIZE = '0.6rem';
const MOBILE_INNER_LABEL_PADDING = 4; // Отступ текста от краев внутри переключателя

interface FilterSwitchProps {
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
}

const FilterSwitch: React.FC<FilterSwitchProps> = ({ filterMode, onFilterModeChange }) => {
    const theme = useTheme();
    const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

    const trackHeight = isMobile ? MOBILE_TRACK_HEIGHT : DESKTOP_TRACK_HEIGHT;
    const trackWidth = isMobile ? MOBILE_TRACK_WIDTH : DESKTOP_TRACK_WIDTH;
    const thumbSize = isMobile ? MOBILE_THUMB_SIZE : DESKTOP_THUMB_SIZE;
    const visualThumbHorizontalPadding = isMobile ? MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING : DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING;

    // Цвет для внутренних мобильных надписей.
    // theme.palette.text.secondary должен дать подходящий контраст на фоне родителя (если он темный)
    const mobileInnerLabelColor = theme.palette.text.secondary;
    // Альтернатива, если text.secondary не подходит:
    // const mobileInnerLabelColor = theme.palette.mode === 'dark' ? theme.palette.grey[500] : theme.palette.grey[600];


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
            case 'sfw':
                left = visualThumbHorizontalPadding;
                backgroundColor = sfwColor;
                break;
            case 'all':
                left = (trackWidth / 2) - (thumbSize / 2);
                backgroundColor = allColor; // Бегунок для "all" будет этим цветом
                break;
            case 'nsfw':
                left = trackWidth - thumbSize - visualThumbHorizontalPadding - (isMobile ? 1 : 2); // Корректировка для border
                backgroundColor = nsfwColor;
                break;
            default:
                left = visualThumbHorizontalPadding;
                backgroundColor = sfwColor;
        }
        return { left: `${left}px`, backgroundColor: backgroundColor };
    };

    return (
        <Box sx={{
            display: 'flex',
            alignItems: 'center',
            gap: { xs: 0.5, sm: 0.8 },
            flexShrink: 0,
            contain: 'layout',
        }}>
            {/* Внешняя SFW надпись, скрыта на мобильных */}
            <Typography
                variant="caption"
                sx={{
                    display: { xs: 'none', sm: 'block' },
                    color: theme.palette.grey[500],
                    fontWeight: 'medium',
                    userSelect: 'none',
                    textTransform: 'uppercase'
                }}
            >
                sfw
            </Typography>

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
                    border: `1px solid ${trackBorderColor}`, // Только рамка
                    backgroundColor: 'transparent', // <--- ФОН ТЕПЕРЬ ПРОЗРАЧНЫЙ
                    p: 0,
                    display: 'flex',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                }}
            >
                {/* Внутренняя SFW надпись для мобильных */}
                <Typography
                    variant="caption"
                    sx={{
                        display: { xs: 'block', sm: 'none' },
                        position: 'absolute',
                        left: `${MOBILE_INNER_LABEL_PADDING}px`,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: MOBILE_INNER_LABEL_FONT_SIZE,
                        color: mobileInnerLabelColor, // <--- Обновленный цвет
                        fontWeight: 'medium', // Можно 'bold' или 'normal' по вкусу
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        zIndex: 1,
                        pointerEvents: 'none',
                    }}
                >
                    SFW
                </Typography>

                {/* Кастомный "бегунок" */}
                <Box
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        ...getThumbStyles(filterMode),
                        width: `${thumbSize}px`,
                        height: `${thumbSize}px`,
                        borderRadius: '50%',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)', // Тень чуть мягче
                        zIndex: 2,
                        transition: theme.transitions.create(['left', 'background-color'], {
                            duration: theme.transitions.duration.short,
                            easing: theme.transitions.easing.easeInOut,
                        }),
                    }}
                />
                {/* Невидимые кнопки для кликабельных областей */}
                {['sfw', 'all', 'nsfw'].map((mode) => (
                    <ToggleButton
                        key={mode}
                        value={mode}
                        aria-label={mode}
                        disableRipple
                        sx={{
                            flex: 1,
                            border: 'none !important',
                            padding: '0 !important',
                            margin: 0,
                            backgroundColor: 'transparent !important',
                            color: 'transparent',
                            zIndex: 3,
                            outline: 'none !important',
                            '&:hover': {
                                backgroundColor: 'transparent !important',
                            },
                            '&.Mui-focusVisible': {
                                backgroundColor: 'transparent !important',
                            },
                        }}
                    >
                        <span style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>{mode}</span>
                    </ToggleButton>
                ))}

                {/* Внутренняя NSFW надпись для мобильных */}
                <Typography
                    variant="caption"
                    sx={{
                        display: { xs: 'block', sm: 'none' },
                        position: 'absolute',
                        right: `${MOBILE_INNER_LABEL_PADDING}px`,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: MOBILE_INNER_LABEL_FONT_SIZE,
                        color: mobileInnerLabelColor, // <--- Обновленный цвет
                        fontWeight: 'medium', // Можно 'bold' или 'normal' по вкусу
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        zIndex: 1,
                        pointerEvents: 'none',
                    }}
                >
                    NSFW
                </Typography>
            </ToggleButtonGroup>

            {/* Внешняя NSFW надпись, скрыта на мобильных */}
            <Typography
                variant="caption"
                sx={{
                    display: { xs: 'none', sm: 'block' },
                    color: theme.palette.grey[500],
                    fontWeight: 'medium',
                    userSelect: 'none',
                    textTransform: 'uppercase'
                }}
            >
                nsfw
            </Typography>
        </Box>
    );
};

export default React.memo(FilterSwitch);