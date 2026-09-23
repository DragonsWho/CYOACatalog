import React from 'react';
import { Box, Typography, ToggleButtonGroup, ToggleButton, useTheme, useMediaQuery } from '@mui/material';
import type { FilterMode } from '../../types';

const sfwColor = '#43a047';
const nsfwColor = '#d32f2f';
const allColor = '#bdbdbd';
const trackBorderColor = '#616161';

const DESKTOP_TRACK_HEIGHT = 28;
const DESKTOP_TRACK_WIDTH = 70;
const DESKTOP_THUMB_SIZE = 20;
const DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING = 3;

// Phone (sm, > 400px): the thumb is a pill with the current mode name inside, no labels at the
// track ends, so the track is wider than the round variant — its width is the control's whole
// header width.
const MOBILE_TRACK_HEIGHT = 26;
const MOBILE_TRACK_WIDTH = 76;
const MOBILE_THUMB_WIDTH = 34;
const MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING = 3;
const MOBILE_THUMB_FONT_SIZE = '0.55rem';

// Very narrow screen (< 400px): every header pixel competes with the site name.
const VERY_SMALL_MOBILE_TRACK_HEIGHT = 22;
const VERY_SMALL_MOBILE_TRACK_WIDTH = 70;
const VERY_SMALL_MOBILE_THUMB_WIDTH = 30;
const VERY_SMALL_MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING = 2;
const VERY_SMALL_MOBILE_THUMB_FONT_SIZE = '0.5rem';

// Text on the pill: white is unreadable on grey ALL.
const MODE_TEXT_COLOR: Record<FilterMode, string> = {
    sfw: '#ffffff',
    all: '#1c1c1c',
    nsfw: '#ffffff',
};

interface FilterSwitchProps {
    filterMode: FilterMode;
    onFilterModeChange: (newMode: FilterMode) => void;
    isBelow400px?: boolean;
}

const FilterSwitch: React.FC<FilterSwitchProps> = ({ filterMode, onFilterModeChange, isBelow400px }) => {
    const theme = useTheme();
    const isMobileBase = useMediaQuery(theme.breakpoints.down('sm')) && !isBelow400px;

    const isPill = isMobileBase || isBelow400px;

    const trackHeight = isBelow400px ? VERY_SMALL_MOBILE_TRACK_HEIGHT : (isMobileBase ? MOBILE_TRACK_HEIGHT : DESKTOP_TRACK_HEIGHT);
    const trackWidth = isBelow400px ? VERY_SMALL_MOBILE_TRACK_WIDTH : (isMobileBase ? MOBILE_TRACK_WIDTH : DESKTOP_TRACK_WIDTH);
    const visualThumbHorizontalPadding = isBelow400px ? VERY_SMALL_MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING : (isMobileBase ? MOBILE_VISUAL_THUMB_HORIZONTAL_PADDING : DESKTOP_VISUAL_THUMB_HORIZONTAL_PADDING);
    const thumbWidth = isBelow400px ? VERY_SMALL_MOBILE_THUMB_WIDTH : (isMobileBase ? MOBILE_THUMB_WIDTH : DESKTOP_THUMB_SIZE);
    const thumbHeight = isPill ? trackHeight - visualThumbHorizontalPadding * 2 : DESKTOP_THUMB_SIZE;
    const thumbFontSize = isBelow400px ? VERY_SMALL_MOBILE_THUMB_FONT_SIZE : MOBILE_THUMB_FONT_SIZE;


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
        // `left` is measured from the padding-box (inside the border): the thumb's travel is two
        // border widths shorter than the track.
        const borderCorrectionOffset = 2;
        const travel = trackWidth - borderCorrectionOffset - thumbWidth;

        switch (mode) {
            case 'sfw':
                left = visualThumbHorizontalPadding;
                backgroundColor = sfwColor;
                break;
            case 'all':
                left = travel / 2;
                backgroundColor = allColor;
                break;
            case 'nsfw':
                left = travel - visualThumbHorizontalPadding;
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
                    transition: theme.transitions.create(['width', 'height'], {
                        duration: theme.transitions.duration.short,
                        easing: theme.transitions.easing.easeInOut,
                    }),
                }}
            >
                {/*
                  Phone: the thumb carries the current mode name. SFW/NSFW labels used to sit at
                  track ends and the thumb at an end covered its own label — it read "W NSFW". No
                  room (60–70 px) to separate them. A label riding the thumb can't be covered and
                  says "this is on now", not "these are the scale ends". Desktop keeps the circle
                  between two labels.
                */}
                <Box
                    aria-hidden
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        transform: 'translateY(-50%)',
                        ...getThumbStyles(filterMode),
                        width: `${thumbWidth}px`,
                        height: `${thumbHeight}px`,
                        borderRadius: isPill ? `${thumbHeight / 2}px` : '50%',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                        zIndex: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: MODE_TEXT_COLOR[filterMode],
                        fontSize: thumbFontSize,
                        fontWeight: 700,
                        lineHeight: 1,
                        letterSpacing: '0.02em',
                        textTransform: 'uppercase',
                        userSelect: 'none',
                        pointerEvents: 'none',
                        transition: theme.transitions.create(['left', 'background-color', 'width', 'height'], {
                            duration: theme.transitions.duration.short,
                            easing: theme.transitions.easing.easeInOut,
                        }),
                    }}
                >
                    {isPill ? filterMode : null}
                </Box>
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