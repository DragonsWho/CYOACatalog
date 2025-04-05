// src/components/Header/FilterSwitch.tsx
import React from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton, useTheme } from '@mui/material';
import type { FilterMode } from '../../types'; // Убедись, что тип FilterMode экспортируется из App.tsx или другого общего места

// Константы, специфичные для этого компонента
const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd';
const trackColor = '#616161';
const trackHeight = 28;
const trackWidth = 70;
const thumbSize = 20;
const visualThumbHorizontalPadding = 3;

interface FilterSwitchProps {
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
}

const FilterSwitch: React.FC<FilterSwitchProps> = ({ filterMode, onFilterModeChange }) => {
    const theme = useTheme();

    const handleFilterChange = (
        _event: React.MouseEvent<HTMLElement>,
        newMode: FilterMode | null, // ToggleButton может вернуть null, если кликнуть по уже выбранной кнопке (хотя exclusive должен это предотвращать)
    ) => {
        // Проверяем, что newMode не null и отличается от текущего
        if (newMode !== null && newMode !== filterMode) {
            onFilterModeChange(newMode);
        }
    };

    const getThumbStyles = (mode: FilterMode) => {
        let left: number;
        let backgroundColor = sfwColor; // По умолчанию SFW
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
                // Небольшая корректировка для правого края из-за border
                left = trackWidth - thumbSize - visualThumbHorizontalPadding - 2;
                backgroundColor = nsfwColor;
                break;
            default: // На случай непредвиденного значения, возвращаемся к SFW
                left = visualThumbHorizontalPadding;
                backgroundColor = sfwColor;
        }
        return { left: `${left}px`, backgroundColor: backgroundColor };
    };

    return (
        <Box sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.8,
            flexShrink: 0,
            minWidth: 120, // Можно настроить или убрать, если нужно
            contain: 'layout',
        }}>
            <Typography
                variant="caption"
                sx={{
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
                exclusive // Важно для предотвращения null значения при клике на активную кнопку
                onChange={handleFilterChange}
                aria-label="Content filter"
                sx={{
                    position: 'relative',
                    width: `${trackWidth}px`,
                    height: `${trackHeight}px`,
                    borderRadius: `${trackHeight / 2}px`,
                    border: `1px solid ${trackColor}`, // Тонкая граница трека
                    backgroundColor: 'transparent', // Фон трека прозрачный
                    p: 0,
                    display: 'flex',
                    overflow: 'hidden', // Скрываем все, что выходит за границы
                    boxSizing: 'border-box', // Учитываем границу в размере
                }}
            >
                {/* Кастомный "бегунок" */}
                <Box
                    sx={{
                        position: 'absolute',
                        top: '50%', // Центрируем по вертикали
                        transform: 'translateY(-50%)', // Точное центрирование
                        ...getThumbStyles(filterMode), // Динамические стили положения и цвета
                        width: `${thumbSize}px`,
                        height: `${thumbSize}px`,
                        borderRadius: '50%', // Круглый бегунок
                        boxShadow: '0 1px 3px rgba(0,0,0,0.4)', // Небольшая тень для объема
                        zIndex: 1, // Поверх кнопок
                        transition: theme.transitions.create(['left', 'background-color'], {
                            duration: theme.transitions.duration.short, // Плавный переход
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
                        disableRipple // Убираем стандартный ripple-эффект
                        sx={{
                            flex: 1, // Растягиваем кнопки на всю ширину
                            border: 'none !important', // Убираем границы кнопок
                            padding: '0 !important', // Убираем паддинги кнопок
                            margin: 0, // Убираем margin
                            backgroundColor: 'transparent !important', // Прозрачный фон
                            color: 'transparent', // Скрываем текст/иконки внутри (если бы они были)
                            zIndex: 2, // Выше фона, но ниже бегунка (для кликабельности)
                            outline: 'none !important', // Убираем outline при фокусе
                            '&:hover': { // Убираем подсветку при наведении
                                backgroundColor: 'transparent !important',
                            },
                            '&.Mui-focusVisible': { // Стиль при фокусе через клавиатуру (если нужен)
                                backgroundColor: 'transparent !important',
                                // Можно добавить кастомный outline, если нужно
                                // outline: `2px solid ${theme.palette.primary.main}`,
                                // outlineOffset: '-2px',
                            },
                        }}
                    >
                        {/* Скрытый текст для доступности */}
                        <span style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>{mode}</span>
                    </ToggleButton>
                ))}
            </ToggleButtonGroup>

            <Typography
                variant="caption"
                sx={{
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

export default React.memo(FilterSwitch); // Используем memo для оптимизации, если пропсы не меняются