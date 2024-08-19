// src/components/Add/TagSelector.jsx
// Version 1.8.5
// Full file version with all recent changes

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress, Tooltip } from '@mui/material';
import { getTags, getTagCategories } from '../../services/api';

const CATEGORY_ORDER = ['Rating', 'Genre', 'Theme', 'Length', 'Difficulty'];
const TAG_GROUPS = [
    [10, 4, 6],
    [3, 5, 5, 5],
    [13, 2],
    [5, 5, 5],
];
const TOOLTIP_DELAY = 1000; // 1 second delay for tooltips
const CHIP_HEIGHT = '24px';
const CHIP_FONT_SIZE = '0.8125rem';
const CHIP_PADDING = '0 8px';
const CHIP_BORDER_RADIUS = '4px';
const GAP = 0.75; // Unified gap for both horizontal and vertical spacing
const CATEGORY_TITLE_MARGIN_BOTTOM = 0.5;
const CATEGORY_TITLE_FONT_WEIGHT = '500';

// Custom DelayedTooltip component
function DelayedTooltip({ title, children, placement = "bottom" }) {
    const [isOpen, setIsOpen] = useState(false);
    const [timer, setTimer] = useState(null);

    const handleMouseEnter = () => {
        const newTimer = setTimeout(() => {
            setIsOpen(true);
        }, TOOLTIP_DELAY);
        setTimer(newTimer);
    };

    const handleMouseLeave = () => {
        if (timer) {
            clearTimeout(timer);
        }
        setIsOpen(false);
    };

    return (
        <Tooltip
            title={title}
            open={isOpen}
            onClose={handleMouseLeave}
            placement={placement}
            arrow
        >
            <span onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
                {children}
            </span>
        </Tooltip>
    );
}

function TagSelector({ selectedTags, onTagsChange, onLoad }) {
    const [tagCategories, setTagCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchTagData = async () => {
            try {
                const [tagsData, categoriesData] = await Promise.all([getTags(), getTagCategories()]);
                const categoriesWithTags = categoriesData.map(category => ({
                    ...category.attributes,
                    id: category.id,
                    tags: tagsData.filter(tag => tag.attributes.tag_category.data?.id === category.id)
                }));
                setTagCategories(categoriesWithTags);
                onLoad();
            } catch (error) {
                console.error('Error fetching tag data:', error);
                setError('Failed to load tags. Please try again.');
            } finally {
                setLoading(false);
            }
        };

        fetchTagData();
    }, [onLoad]);

    const sortedCategories = useMemo(() => {
        return tagCategories.sort((a, b) => {
            const indexA = CATEGORY_ORDER.indexOf(a.Name);
            const indexB = CATEGORY_ORDER.indexOf(b.Name);
            if (indexA === -1 && indexB === -1) return 0;
            if (indexA === -1) return 1;
            if (indexB === -1) return -1;
            return indexA - indexB;
        });
    }, [tagCategories]);

    const handleTagToggle = (tagId, categoryId) => {
        const category = tagCategories.find(cat => cat.id === categoryId);
        const categoryTags = selectedTags.filter(id =>
            category.tags.some(tag => tag.id === id)
        );

        if (selectedTags.includes(tagId)) {
            onTagsChange(selectedTags.filter(id => id !== tagId));
        } else {
            if (categoryTags.length < category.MaxTags) {
                onTagsChange([...selectedTags, tagId]);
            }
        }
    };

    const handleAddTag = (categoryId, newTagName) => {
        console.log(`Add new tag "${newTagName}" to category ${categoryId}`);
    };

    const renderTagGroups = (category, groupConfig) => {
        if (!groupConfig || groupConfig.length === 0) {
            // If no group config, render all tags in a single group
            return (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: GAP }}>
                    {category.tags.map(tag => (
                        <DelayedTooltip
                            key={tag.id}
                            title={tag.attributes.Description || 'No description available'}
                        >
                            <Chip
                                label={tag.attributes.Name}
                                onClick={() => handleTagToggle(tag.id, category.id)}
                                color={selectedTags.includes(tag.id) ? "primary" : "default"}
                                size="small"
                                sx={{
                                    height: CHIP_HEIGHT,
                                    borderRadius: CHIP_BORDER_RADIUS,
                                    '& .MuiChip-label': {
                                        fontSize: CHIP_FONT_SIZE,
                                        padding: CHIP_PADDING,
                                    }
                                }}
                                disabled={!selectedTags.includes(tag.id) && selectedTags.filter(id =>
                                    category.tags.some(catTag => catTag.id === id)
                                ).length >= category.MaxTags}
                            />
                        </DelayedTooltip>
                    ))}
                </Box>
            );
        }

        return (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
                {groupConfig.map((row, rowIndex) => (
                    <Box key={rowIndex} sx={{ display: 'flex', flexWrap: 'wrap', gap: GAP }}>
                        {(Array.isArray(row) ? row : [row]).map((groupSize, groupIndex) => {
                            const startIndex = groupConfig.slice(0, rowIndex).flat().reduce((sum, size) => sum + (Array.isArray(size) ? size.reduce((a, b) => a + b, 0) : size), 0) +
                                (Array.isArray(row) ? row.slice(0, groupIndex).reduce((sum, size) => sum + size, 0) : 0);
                            const groupTags = category.tags.slice(startIndex, startIndex + groupSize);

                            return groupTags.map(tag => (
                                <DelayedTooltip
                                    key={tag.id}
                                    title={tag.attributes.Description || 'No description available'}
                                >
                                    <Chip
                                        label={tag.attributes.Name}
                                        onClick={() => handleTagToggle(tag.id, category.id)}
                                        color={selectedTags.includes(tag.id) ? "primary" : "default"}
                                        size="small"
                                        sx={{
                                            height: CHIP_HEIGHT,
                                            borderRadius: CHIP_BORDER_RADIUS,
                                            '& .MuiChip-label': {
                                                fontSize: CHIP_FONT_SIZE,
                                                padding: CHIP_PADDING,
                                            }
                                        }}
                                        disabled={!selectedTags.includes(tag.id) && selectedTags.filter(id =>
                                            category.tags.some(catTag => catTag.id === id)
                                        ).length >= category.MaxTags}
                                    />
                                </DelayedTooltip>
                            ));
                        })}
                    </Box>
                ))}
            </Box>
        );
    };

    if (loading) return <CircularProgress size={24} />;
    if (error) return <Typography color="error" variant="body2">{error}</Typography>;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
            {sortedCategories.map((category, index) => {
                const canAddMore = selectedTags.filter(id =>
                    category.tags.some(tag => tag.id === id)
                ).length < category.MaxTags;

                return (
                    <Box key={category.id} sx={{ mb: GAP }}>
                        <DelayedTooltip
                            title={category.Description || 'No description available'}
                            placement="bottom-start"
                        >
                            <Typography
                                variant="subtitle1"
                                sx={{
                                    mb: CATEGORY_TITLE_MARGIN_BOTTOM,
                                    fontWeight: CATEGORY_TITLE_FONT_WEIGHT,
                                    display: 'inline-block',
                                }}
                            >
                                {category.Name}
                            </Typography>
                        </DelayedTooltip>
                        {renderTagGroups(category, TAG_GROUPS[index])}
                        {category.AllowNewTags && canAddMore && (
                            <TextField
                                size="small"
                                placeholder="Add a tag..."
                                onKeyPress={(e) => {
                                    if (e.key === 'Enter') {
                                        handleAddTag(category.id, e.target.value);
                                        e.target.value = '';
                                    }
                                }}
                                sx={{
                                    mt: GAP,
                                    '& .MuiInputBase-root': {
                                        height: CHIP_HEIGHT,
                                        fontSize: CHIP_FONT_SIZE,
                                    }
                                }}
                            />
                        )}
                    </Box>
                );
            })}
        </Box>
    );
}

export default TagSelector;