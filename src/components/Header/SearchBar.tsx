import React from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton, useTheme } from '@mui/material';  
import type { FilterMode } from '../../types';

// Константы цветов
const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd';
const trackBorderColor = '#616161';

// Размеры для десктопа (sm и выше)
const DESKTOP_TRACK_HEIGHT = 28; // Было 26, вернул к более крупному
const DESKTOP_TRACK_WIDTH = 70;  // Было 65
const DESKTOP_THUMB_SIZE = 20;   // Было 18
const DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING = 3; // (28-20)/2 - 1 = 3

// Размеры для мобильных (xs) - МАКСИМАЛЬНО КОМПАКТНЫЕ
// (используются если isXsScreen = true)
const XS_TRACK_HEIGHT = 22; // Было MOBILE_TRACK_HEIGHT
const XS_TRACK_WIDTH = 56;  // Было MOBILE_TRACK_WIDTH
const XS_THUMB_SIZE = 14;   // Было MOBILE_THUMB_SIZE
const XS_VISUAL_THUMB_HORIZONTAL_PADDING = (XS_TRACK_HEIGHT - XS_THUMB_SIZE) / 2 - 1; // (22-14)/2 - 1 = 3
const XS_INNER_LABEL_FONT_SIZE = '0.5rem'; // Было MOBILE_INNER_LABEL_FONT_SIZE
const XS_INNER_LABEL_PADDING = 3;          // Было MOBILE_INNER_LABEL_PADDING


interface FilterSwitchProps {
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
    isXsScreen?: boolean; // Флаг для мобильных < sm
    isVerySmallScreen?: boolean; // Флаг для самых маленьких < 390px (пока не используется напрямую, но можно)
}

const FilterSwitch: React.FC<FilterSwitchProps> = ({
    filterMode,
    onFilterModeChange,
    isXsScreen, // Получаем флаг
    // isVerySmallScreen // Пока не используется, но можно добавить логику
}) => {
    const theme = useTheme();
    // const isMobile = useMediaQuery(theme.breakpoints.down('sm')); // Заменяем на isXsScreen

    const trackHeight = isXsScreen ? XS_TRACK_HEIGHT : DESKTOP_TRACK_HEIGHT;
    const trackWidth = isXsScreen ? XS_TRACK_WIDTH : DESKTOP_TRACK_WIDTH;
    const thumbSize = isXsScreen ? XS_THUMB_SIZE : DESKTOP_THUMB_SIZE;
    const visualThumbHorizontalPadding = isXsScreen ? XS_VISUAL_THUMB_HORIZONTAL_PADDING : DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING;
    
    const innerLabelPadding = isXsScreen ? XS_INNER_LABEL_PADDING : 0;
    const innerLabelFontSize = isXsScreen ? XS_INNER_LABEL_FONT_SIZE : '0rem';

    const mobileInnerLabelColor = theme.palette.mode === 'dark' ? theme.palette.grey[400] : theme.palette.grey[700];


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
                backgroundColor = allColor;
                break;
            case 'nsfw':
                left = trackWidth - thumbSize - visualThumbHorizontalPadding;
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
            // На xs экранах gap управляется через justifyContent: 'space-between' в Header
            // На sm+ экранах gap управляется в Header (iconsBoxGapSm)
            // gap: { xs: 0, sm: 0.5 }, // Убираем gap здесь, он будет в Header
            flexShrink: 0,
        }}>
            {/* Внешние SFW/NSFW надписи показываются только на НЕ-xs экранах */}
            {!isXsScreen && (
                <Typography
                    variant="caption"
                    sx={{
                        // display: { xs: 'none', sm: 'block' }, // Управляется через !isXsScreen
                        color: theme.palette.grey[500],
                        fontWeight: 'medium',
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        mr: 0.5 // Отступ справа от SFW до переключателя
                    }}
                >
                    sfw
                </Typography>
            )}

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
                }}
            >
                {/* Внутренние SFW/NSFW надписи показываются только на xs экранах */}
                {isXsScreen && (
                    <>
                        <Typography
                            variant="caption"
                            sx={{
                                // display: { xs: 'block', sm: 'none' }, // Управляется через isXsScreen
                                position: 'absolute',
                                left: `${innerLabelPadding}px`,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: innerLabelFontSize,
                                color: mobileInnerLabelColor,
                                fontWeight: 'bold', // Сделаем жирнее для читаемости
                                userSelect: 'none',
                                textTransform: 'uppercase',
                                zIndex: 1,
                                pointerEvents: 'none',
                            }}
                        >
                            SFW
                        </Typography>
                        <Typography
                            variant="caption"
                            sx={{
                                // display: { xs: 'block', sm: 'none' }, // Управляется через isXsScreen
                                position: 'absolute',
                                right: `${innerLabelPadding}px`,
                                top: '50%',
                                transform: 'translateY(-50%)',
                                fontSize: innerLabelFontSize,
                                color: mobileInnerLabelColor,
                                fontWeight: 'bold',
                                userSelect: 'none',
                                textTransform: 'uppercase',
                                zIndex: 1,
                                pointerEvents: 'none',
                            }}
                        >
                            NSFW
                        </Typography>
                    </>
                )}

                <Box
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        ...getThumbStyles(filterMode),
                        width: `${thumbSize}px`,
                        height: `${thumbSize}px`,
                        borderRadius: '50%',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                        zIndex: 2,
                        transition: theme.transitions.create(['left', 'background-color'], {
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
                            '&:hover': { backgroundColor: 'transparent !important' },
                            '&.Mui-selected': { backgroundColor: 'transparent !important' },
                            '&.Mui-focusVisible': { backgroundColor: 'transparent !important' },
                        }}
                    >
                        <span style={{ opacity: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>{mode}</span>
                    </ToggleButton>
                ))}
            </ToggleButtonGroup>

            {!isXsScreen && (
                <Typography
                    variant="caption"
                    sx={{
                        // display: { xs: 'none', sm: 'block' }, // Управляется через !isXsScreen
                        color: theme.palette.grey[500],
                        fontWeight: 'medium',
                        userSelect: 'none',
                        textTransform: 'uppercase',
                        ml: 0.5 // Отступ слева от NSFW до переключателя
                    }}
                >
                    nsfw
                </Typography>
            )}
        </Box>
    );
};

export default React.memo(FilterSwitch);