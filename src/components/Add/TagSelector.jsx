// src/components/Add/TagSelector.jsx
// Version 1.1.0
// Changes: Added tooltips with tag descriptions to tag chips

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress, Tooltip } from '@mui/material';
import { getTags, getTagCategories } from '../../services/api';

const CATEGORY_ORDER = ['Rating', 'Genre', 'Theme', 'Length', 'Difficulty'];

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
            // Removing a tag
            onTagsChange(selectedTags.filter(id => id !== tagId));
        } else {
            // Adding a tag
            if (categoryTags.length < category.MaxTags) {
                onTagsChange([...selectedTags, tagId]);
            }
        }
    };

    const handleAddTag = (categoryId, newTagName) => {
        console.log(`Add new tag "${newTagName}" to category ${categoryId}`);
    };

    if (loading) return <CircularProgress />;
    if (error) return <Typography color="error">{error}</Typography>;

    return (
        <Box>
            {sortedCategories.map(category => {
                const categoryTags = selectedTags.filter(id =>
                    category.tags.some(tag => tag.id === id)
                );
                const canAddMore = categoryTags.length < category.MaxTags;
                const isUnderMinimum = categoryTags.length < category.MinTags;

                return (
                    <Box key={category.id} sx={{ mb: 2 }}>
                        <Typography variant="h6">
                            {category.Name} ({categoryTags.length}/{category.MaxTags})
                            {isUnderMinimum && (
                                <Typography variant="caption" color="error">
                                    {` (Minimum ${category.MinTags} required)`}
                                </Typography>
                            )}
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                            {category.tags.map(tag => (
                                <Tooltip key={tag.id} title={tag.attributes.Description || 'No description available'} arrow>
                                    <Chip
                                        label={tag.attributes.Name}
                                        onClick={() => handleTagToggle(tag.id, category.id)}
                                        color={selectedTags.includes(tag.id) ? "primary" : "default"}
                                        disabled={!selectedTags.includes(tag.id) && !canAddMore}
                                    />
                                </Tooltip>
                            ))}
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
                                />
                            )}
                        </Box>
                    </Box>
                );
            })}
        </Box>
    );
}

export default TagSelector;