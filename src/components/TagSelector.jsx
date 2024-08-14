// src/components/TagSelector.jsx
// Version 1.0.2

import React, { useState, useEffect } from 'react';
import { Box, Chip, TextField, Typography, CircularProgress } from '@mui/material';
import { getTags, getTagCategories } from '../services/api';

function TagSelector({ selectedTags, onTagsChange, onLoad }) {
    const [tagCategories, setTagCategories] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchTagData = async () => {
            try {
                const [tagsData, categoriesData] = await Promise.all([getTags(), getTagCategories()]);
                console.log('Tags data:', tagsData); // Добавим лог для отладки
                console.log('Categories data:', categoriesData); // Добавим лог для отладки
                const categoriesWithTags = categoriesData.map(category => ({
                    ...category.attributes,
                    id: category.id,
                    tags: tagsData.filter(tag => tag.attributes.tag_category.data?.id === category.id)
                }));
                setTagCategories(categoriesWithTags);
                onLoad(); // Notify parent component that tags have loaded
            } catch (error) {
                console.error('Error fetching tag data:', error);
                setError('Failed to load tags. Please try again.');
            } finally {
                setLoading(false);
            }
        };

        fetchTagData();
    }, [onLoad]);

    const handleTagToggle = (tagId) => {
        const updatedTags = selectedTags.includes(tagId)
            ? selectedTags.filter(id => id !== tagId)
            : [...selectedTags, tagId];
        onTagsChange(updatedTags);
    };

    const handleAddTag = (categoryId, newTagName) => {
        // This function would typically involve creating a new tag via API
        // For now, we'll just log the action
        console.log(`Add new tag "${newTagName}" to category ${categoryId}`);
    };

    if (loading) return <CircularProgress />;
    if (error) return <Typography color="error">{error}</Typography>;

    return (
        <Box>
            {tagCategories.map(category => (
                <Box key={category.id} sx={{ mb: 2 }}>
                    <Typography variant="h6">{category.Name}</Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                        {category.tags.map(tag => (
                            <Chip
                                key={tag.id}
                                label={tag.attributes.Name}
                                onClick={() => handleTagToggle(tag.id)}
                                color={selectedTags.includes(tag.id) ? "primary" : "default"}
                            />
                        ))}
                        {category.AllowNewTags && (
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
            ))}
        </Box>
    );
}

export default TagSelector;