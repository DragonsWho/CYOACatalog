// src/components/Add/TagSelector.jsx
// Version 1.4.0
// Changes: Added support for 2D array in TAG_GROUPS with minimal changes

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress, Tooltip, Divider } from '@mui/material';
import { getTags, getTagCategories } from '../../services/api';

const CATEGORY_ORDER = ['Rating', 'Genre', 'Theme', 'Length', 'Difficulty'];
const TAG_GROUPS = [
    [10, 4, 6],
    [3, 5, 5, 5],
    [13, 2],
    [5, 5, 5],
    [10, 4, 6],
    [3, 5, 5, 5],
    [13, 2],
    [5, 5, 5],
    [10, 4, 6],
    [3, 5, 5, 5],
    [13, 2],
    [5, 5, 5],
    [10, 4, 6],
    [3, 5, 5, 5],
    [13, 2],
    [5, 5, 5],
];

function TagSelector({ selectedTags, onTagsChange, onLoad }) {
    const [tagCategories, setTagCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchTagData = async () => {
            try {
                const [tagsData, categoriesData] = await Promise.all([getTags(), getTagCategories()]);
                console.log('Tags data:', tagsData);
                console.log('Categories data:', categoriesData);
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
        const groups = [];
        let tagIndex = 0;

        groupConfig.forEach((row, rowIndex) => {
            const rowGroups = [];
            (Array.isArray(row) ? row : [row]).forEach(groupSize => {
                const groupTags = category.tags.slice(tagIndex, tagIndex + groupSize);
                if (groupTags.length > 0) {
                    rowGroups.push(
                        <Box key={tagIndex} sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                            {groupTags.map(tag => (
                                <Tooltip key={tag.id} title={tag.attributes.Description || 'No description available'} arrow>
                                    <Chip
                                        label={tag.attributes.Name}
                                        onClick={() => handleTagToggle(tag.id, category.id)}
                                        color={selectedTags.includes(tag.id) ? "primary" : "default"}
                                        disabled={!selectedTags.includes(tag.id) && selectedTags.filter(id =>
                                            category.tags.some(catTag => catTag.id === id)
                                        ).length >= category.MaxTags}
                                    />
                                </Tooltip>
                            ))}
                        </Box>
                    );
                }
                tagIndex += groupSize;
            });

            if (rowGroups.length > 0) {
                groups.push(
                    <Box key={rowIndex} sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {rowGroups}
                    </Box>
                );
                if (rowIndex < groupConfig.length - 1) {
                    groups.push(<Divider key={`divider-${rowIndex}`} sx={{ my: 1 }} />);
                }
            }
        });

        return groups;
    };

    if (loading) return <CircularProgress />;
    if (error) return <Typography color="error">{error}</Typography>;

    return (
        <Box>
            {sortedCategories.map((category, index) => {
                const categoryTags = selectedTags.filter(id =>
                    category.tags.some(tag => tag.id === id)
                );
                const canAddMore = categoryTags.length < category.MaxTags;
                const isUnderMinimum = categoryTags.length < category.MinTags;

                return (
                    <Box key={category.id} sx={{ mb: 3 }}>
                        <Typography variant="h6" sx={{ mb: 1 }}>
                            {category.Name} ({categoryTags.length}/{category.MaxTags})
                            {isUnderMinimum && (
                                <Typography variant="caption" color="error">
                                    {` (Minimum ${category.MinTags} required)`}
                                </Typography>
                            )}
                        </Typography>
                        {renderTagGroups(category, TAG_GROUPS[index] || [[category.tags.length]])}
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
                                sx={{ mt: 1 }}
                            />
                        )}
                    </Box>
                );
            })}
        </Box>
    );
}

export default TagSelector;