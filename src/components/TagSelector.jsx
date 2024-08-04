// src/components/TagSelector.jsx
// Version 1.8.0

import React, { useState, useEffect } from 'react';
import { TextField, Chip, Typography, Box } from '@mui/material';
import { debounce } from 'lodash';

// Configurable maximum Levenshtein distance
// Optimal value may vary depending on your application specifics
// Suggested initial value: 3
const MAX_LEVENSHTEIN_DISTANCE = 3;

function levenshteinDistance(a, b, maxDistance = MAX_LEVENSHTEIN_DISTANCE) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        let minDistanceInRow = Infinity;
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
            minDistanceInRow = Math.min(minDistanceInRow, matrix[i][j]);
        }
        // If the minimum distance in the current row exceeds maxDistance,
        // we can stop calculations as further rows won't improve the result
        if (minDistanceInRow > maxDistance) {
            return Infinity;
        }
    }

    return matrix[b.length][a.length];
}

function findSimilarTags(input, availableTags, maxResults = 3) {
    const normalizedInput = input.toLowerCase().trim();

    const tagDistances = availableTags.map(tag => ({
        ...tag,
        distance: levenshteinDistance(normalizedInput, tag.name.toLowerCase())
    }));

    // Filter tags with distance not exceeding MAX_LEVENSHTEIN_DISTANCE
    const filteredTags = tagDistances.filter(tag => tag.distance <= MAX_LEVENSHTEIN_DISTANCE);

    filteredTags.sort((a, b) => a.distance - b.distance);

    return filteredTags.slice(0, maxResults);
}

function TagSelector({ value, onChange, availableTags }) {
    const [inputValue, setInputValue] = useState('');
    const [autocompleteSuggestions, setAutocompleteSuggestions] = useState([]);
    const [similarTags, setSimilarTags] = useState([]);

    useEffect(() => {
        setInputValue('');
        setAutocompleteSuggestions([]);
        setSimilarTags([]);
    }, [value]);

    const handleInputChange = (event) => {
        const newValue = event.target.value;
        setInputValue(newValue);
        debouncedFindSuggestions(newValue);
    };

    const handleKeyDown = (event) => {
        if (event.key === 'Enter' && inputValue.trim() !== '') {
            const trimmedValue = inputValue.trim();
            const existingTag = availableTags.find(tag => tag.name.toLowerCase() === trimmedValue.toLowerCase());

            if (existingTag) {
                if (!value.some(v => v.id === existingTag.id)) {
                    onChange([...value, existingTag]);
                }
            } else {
                const newTag = { id: Date.now(), name: trimmedValue };
                onChange([...value, newTag]);
            }

            setInputValue('');
            setAutocompleteSuggestions([]);
            setSimilarTags([]);
        }
    };

    const handleTagDelete = (tagToDelete) => {
        onChange(value.filter(tag => tag.id !== tagToDelete.id));
    };

    const handleSuggestionClick = (suggestion) => {
        if (!value.some(v => v.id === suggestion.id)) {
            onChange([...value, suggestion]);
        }
        setInputValue('');
        setAutocompleteSuggestions([]);
        setSimilarTags([]);
    };

    const debouncedFindSuggestions = debounce((input) => {
        if (input) {
            // Autocomplete suggestions
            const autoSuggestions = availableTags
                .filter(tag => tag.name.toLowerCase().includes(input.toLowerCase()))
                .slice(0, 5);
            setAutocompleteSuggestions(autoSuggestions);

            // Similar tags for error correction
            if (!availableTags.some(tag => tag.name.toLowerCase() === input.toLowerCase())) {
                const similar = findSimilarTags(input, availableTags);
                const filteredSimilar = similar.filter(tag =>
                    !value.some(v => v.id === tag.id) &&
                    !autoSuggestions.some(a => a.id === tag.id)
                );

                // Check if the best autocomplete suggestion is closer than the best similar tag
                const bestAutocompleteDist = autoSuggestions.length > 0
                    ? levenshteinDistance(input.toLowerCase(), autoSuggestions[0].name.toLowerCase())
                    : Infinity;
                const bestSimilarDist = filteredSimilar.length > 0 ? filteredSimilar[0].distance : Infinity;

                if (bestSimilarDist < bestAutocompleteDist && bestSimilarDist <= MAX_LEVENSHTEIN_DISTANCE) {
                    setSimilarTags(filteredSimilar.slice(0, 5));
                } else {
                    setSimilarTags([]);
                }
            } else {
                setSimilarTags([]);
            }
        } else {
            setAutocompleteSuggestions([]);
            setSimilarTags([]);
        }
    }, 300);

    return (
        <Box>
            <Box mb={2}>
                {value.map((tag) => (
                    <Chip
                        key={tag.id}
                        label={tag.name}
                        onDelete={() => handleTagDelete(tag)}
                        style={{ margin: '0 5px 5px 0' }}
                    />
                ))}
            </Box>
            <TextField
                fullWidth
                variant="outlined"
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Add tags..."
            />
            {autocompleteSuggestions.length > 0 && (
                <Box mt={1}>
                    <Typography variant="subtitle2">Suggestions:</Typography>
                    {autocompleteSuggestions.map((suggestion) => (
                        <Chip
                            key={suggestion.id}
                            label={suggestion.name}
                            onClick={() => handleSuggestionClick(suggestion)}
                            style={{ margin: '0 5px 5px 0', cursor: 'pointer' }}
                        />
                    ))}
                </Box>
            )}
            {similarTags.length > 0 && (
                <Box mt={1}>
                    <Typography variant="subtitle2">Did you mean:</Typography>
                    {similarTags.map((suggestion) => (
                        <Chip
                            key={suggestion.id}
                            label={suggestion.name}
                            onClick={() => handleSuggestionClick(suggestion)}
                            style={{ margin: '0 5px 5px 0', cursor: 'pointer' }}
                        />
                    ))}
                </Box>
            )}
        </Box>
    );
}

export default TagSelector;