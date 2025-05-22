// src/components/Header/FilterSwitch.tsx
import React from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton, useTheme, useMediaQuery } from '@mui/material';
import type { FilterMode } from '../../types';

// Константы цветов
const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd';
const trackBorderColor = '#616161';

// Размеры для десктопа
const DESKTOP_TRACK_HEIGHT = 28;
const DESKTOP_TRACK_WIDTH = 70;
const DESKTOP_THUMB_SIZE = 20;
const DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING = 3;

// Размеры для мобильных (sm, > 400px)
const MOBILE_TRACK_HEIGHT = 26;
const MOBILE_TRACK_WIDTH = 70; // Оставляем ширину для читаемости SFW/NSFW
const MOBILE_THUMB_SIZE = 18;
const MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING = 3;
const MOBILE_INNER_LABEL_FONT_SIZE = '0.6rem';
const MOBILE_INNER_LABEL_PADDING = 4;

// Размеры для очень маленьких мобильных (< 400px)
const VERY_SMALL_MOBILE_TRACK_HEIGHT = 22; // Уменьшаем высоту
const VERY_SMALL_MOBILE_TRACK_WIDTH = 60;  // Уменьшаем ширину
const VERY_SMALL_MOBILE_THUMB_SIZE = 16;   // Уменьшаем бегунок
const VERY_SMALL_MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING = 2;
const VERY_SMALL_MOBILE_INNER_LABEL_FONT_SIZE = '0.55rem'; // Чуть меньше шрифт
const VERY_SMALL_MOBILE_INNER_LABEL_PADDING = 3; // Чуть меньше отступ

interface FilterSwitchProps {
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
    isBelow400px?: boolean; // Принимаем этот проп
}

const FilterSwitch: React.FC<FilterSwitchProps> = ({ filterMode, onFilterModeChange, isBelow400px }) => {
    const theme = useTheme();
    // isMobileBase теперь определяет диапазон между <600px и >=400px
    const isMobileBase = useMediaQuery(theme.breakpoints.down('sm')) && !isBelow400px;

    const trackHeight = isBelow400px ? VERY_SMALL_MOBILE_TRACK_HEIGHT : (isMobileBase ? MOBILE_TRACK_HEIGHT : DESKTOP_TRACK_HEIGHT);
    const trackWidth = isBelow400px ? VERY_SMALL_MOBILE_TRACK_WIDTH : (isMobileBase ? MOBILE_TRACK_WIDTH : DESKTOP_TRACK_WIDTH);
    const thumbSize = isBelow400px ? VERY_SMALL_MOBILE_THUMB_SIZE : (isMobileBase ? MOBILE_THUMB_SIZE : DESKTOP_THUMB_SIZE);
    const visualThumbHorizontalPadding = isBelow400px ? VERY_SMALL_MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING : (isMobileBase ? MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING : DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING);
    
    // Для внутренних надписей используем isBelow400px или isMobileBase (т.к. на десктопе их нет)
    const currentInnerLabelFontSize = isBelow400px ? VERY_SMALL_MOBILE_INNER_LABEL_FONT_SIZE : MOBILE_INNER_LABEL_FONT_SIZE;
    const currentInnerLabelPadding = isBelow400px ? VERY_SMALL_MOBILE_INNER_LABEL_PADDING : MOBILE_INNER_LABEL_PADDING;

    const mobileInnerLabelColor = theme.palette.text.secondary;

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
        // Коррекция для border на мобильных. Может быть 1px, на десктопе - 2px из-за толщины thumb?
        // Проверим, влияет ли это на точность позиционирования
        const borderCorrectionOffset = (isMobileBase || isBelow400px) ? 1 : 2;

        switch (mode) {
            case 'sfw':
                left = visualThumbHorizontalPadding;
                backgroundColor = sfwColor;
                break;
            case 'all':
                left = (trackWidth / 2) - (thumbSize / 2);
                backgroundColor = allColor;
                break;
            case 'nsfw':
                left = trackWidth - thumbSize - visualThumbHorizontalPadding - borderCorrectionOffset;
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
                    border: `1px solid ${trackBorderColor}`,
                    backgroundColor: 'transparent',
                    p: 0,
                    display: 'flex',
                    overflow: 'hidden',
                    boxSizing: 'border-box',
                    transition: theme.transitions.create(['width', 'height'], { // Плавное изменение размера
                        duration: theme.transitions.duration.short,
                        easing: theme.transitions.easing.easeInOut,
                    }),
                }}
            >
                <Typography
                    variant="caption"
                    sx={{
                        display: { xs: 'block', sm: 'none' },
                        position: 'absolute',
                        left: `${currentInnerLabelPadding}px`,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: currentInnerLabelFontSize,
                        color: mobileInnerLabelColor,
                        fontWeight: 'medium',
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        zIndex: 1,
                        pointerEvents: 'none',
                    }}
                >
                    SFW
                </Typography>

                <Box
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        ...getThumbStyles(filterMode),
                        width: `${thumbSize}px`,
                        height: `${thumbSize}px`,
                        borderRadius: '50%',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                        zIndex: 2,
                        transition: theme.transitions.create(['left', 'background-color', 'width', 'height'], {
                            duration: theme.transitions.duration.short,
                            easing: theme.transitions.easing.easeInOut,
                        }),
                    }}
                />
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

                <Typography
                    variant="caption"
                    sx={{
                        display: { xs: 'block', sm: 'none' },
                        position: 'absolute',
                        right: `${currentInnerLabelPadding}px`,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        fontSize: currentInnerLabelFontSize,
                        color: mobileInnerLabelColor,
                        fontWeight: 'medium',
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        zIndex: 1,
                        pointerEvents: 'none',
                    }}
                >
                    NSFW
                </Typography>
            </ToggleButtonGroup>

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