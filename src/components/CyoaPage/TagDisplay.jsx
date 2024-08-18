// src/components/CyoaPage/TagDisplay.jsx
// v1.3
// Updated to handle missing category information

import React from 'react';
import { Box, Chip, Typography } from '@mui/material';

const TagDisplay = ({ tags }) => {
    if (!tags || tags.length === 0) {
        return null;
    }

    // Group tags by their category
    const groupedTags = tags.reduce((acc, tag) => {
        if (!tag || !tag.attributes) return acc;

        const categoryData = tag.attributes.tag_category && tag.attributes.tag_category.data;
        const categoryName = categoryData && categoryData.attributes
            ? categoryData.attributes.Name
            : 'Uncategorized';

        if (!acc[categoryName]) {
            acc[categoryName] = [];
        }
        acc[categoryName].push(tag);
        return acc;
    }, {});

    return (
        <Box sx={{ mt: 2 }}>
            <Typography variant="h6" gutterBottom>Tags:</Typography>
            {Object.entries(groupedTags).map(([category, categoryTags]) => (
                <Box key={category} sx={{ mb: 1 }}>
                    <Typography variant="subtitle1" component="span" sx={{ mr: 1 }}>
                        {category}:
                    </Typography>
                    {categoryTags.map((tag) => (
                        <Chip
                            key={tag.id}
                            label={tag.attributes.Name}
                            sx={{ mr: 0.5, mb: 0.5 }}
                        />
                    ))}
                </Box>
            ))}
        </Box>
    );
};

export default TagDisplay;