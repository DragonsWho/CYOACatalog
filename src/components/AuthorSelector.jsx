// src/components/AuthorSelector.jsx
// Version 2.0.0

import React, { useState, useEffect } from 'react';
import { TextField, Chip, Typography, Box, Button } from '@mui/material';
import { debounce } from 'lodash';
import { createAuthor } from '../services/api';

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

function findSimilarAuthors(input, availableAuthors, maxResults = 3) {
    const normalizedInput = input.toLowerCase().trim();

    const authorDistances = availableAuthors.map(author => ({
        ...author,
        distance: levenshteinDistance(normalizedInput, author.name.toLowerCase())
    }));

    // Filter authors with distance not exceeding MAX_LEVENSHTEIN_DISTANCE
    const filteredAuthors = authorDistances.filter(author => author.distance <= MAX_LEVENSHTEIN_DISTANCE);

    filteredAuthors.sort((a, b) => a.distance - b.distance);

    return filteredAuthors.slice(0, maxResults);
}

async function createNewAuthor(authorName) {
    try {
        const newAuthor = await createAuthor(authorName);
        return {
            id: newAuthor.id,
            name: newAuthor.attributes.Name
        };
    } catch (error) {
        console.error('Failed to create new author:', error);
        throw error;
    }
}

function AuthorSelector({ value, onChange, availableAuthors, onAuthorsChange }) {
    const [inputValue, setInputValue] = useState('');
    const [autocompleteSuggestions, setAutocompleteSuggestions] = useState([]);
    const [similarAuthors, setSimilarAuthors] = useState([]);
    const [isCreatingAuthor, setIsCreatingAuthor] = useState(false);

    useEffect(() => {
        setInputValue('');
        setAutocompleteSuggestions([]);
        setSimilarAuthors([]);
    }, [value]);

    const handleInputChange = (event) => {
        const newValue = event.target.value;
        setInputValue(newValue);
        debouncedFindSuggestions(newValue);
    };

    const handleKeyDown = async (event) => {
        if (event.key === 'Enter' && inputValue.trim() !== '') {
            await handleCreateOrSelectAuthor();
        }
    };

    const handleCreateOrSelectAuthor = async () => {
        const trimmedValue = inputValue.trim();
        const existingAuthor = availableAuthors.find(author => author.name.toLowerCase() === trimmedValue.toLowerCase());

        if (existingAuthor) {
            if (!value.some(v => v.id === existingAuthor.id)) {
                onChange([...value, existingAuthor]);
            }
        } else {
            await handleCreateNewAuthor();
        }

        setInputValue('');
        setAutocompleteSuggestions([]);
        setSimilarAuthors([]);
    };

    const handleCreateNewAuthor = async () => {
        try {
            setIsCreatingAuthor(true);
            const newAuthor = await createNewAuthor(inputValue.trim());
            onChange([...value, newAuthor]);
            onAuthorsChange([...availableAuthors, newAuthor]); // Update the list of available authors
            setIsCreatingAuthor(false);
            setInputValue('');
        } catch (error) {
            console.error('Failed to create new author:', error);
            // ƒобавьте здесь обработку ошибок, например, показ сообщени€ пользователю
            setIsCreatingAuthor(false);
        }
    };

    const handleAuthorDelete = (authorToDelete) => {
        onChange(value.filter(author => author.id !== authorToDelete.id));
    };

    const handleSuggestionClick = (suggestion) => {
        if (!value.some(v => v.id === suggestion.id)) {
            onChange([...value, suggestion]);
        }
        setInputValue('');
        setAutocompleteSuggestions([]);
        setSimilarAuthors([]);
    };

    const debouncedFindSuggestions = debounce((input) => {
        if (input) {
            // Autocomplete suggestions
            const autoSuggestions = availableAuthors
                .filter(author => author.name.toLowerCase().includes(input.toLowerCase()))
                .slice(0, 5);
            setAutocompleteSuggestions(autoSuggestions);

            // Similar authors for error correction
            if (!availableAuthors.some(author => author.name.toLowerCase() === input.toLowerCase())) {
                const similar = findSimilarAuthors(input, availableAuthors);
                const filteredSimilar = similar.filter(author =>
                    !value.some(v => v.id === author.id) &&
                    !autoSuggestions.some(a => a.id === author.id)
                );

                // Check if the best autocomplete suggestion is closer than the best similar author
                const bestAutocompleteDist = autoSuggestions.length > 0
                    ? levenshteinDistance(input.toLowerCase(), autoSuggestions[0].name.toLowerCase())
                    : Infinity;
                const bestSimilarDist = filteredSimilar.length > 0 ? filteredSimilar[0].distance : Infinity;

                if (bestSimilarDist < bestAutocompleteDist && bestSimilarDist <= MAX_LEVENSHTEIN_DISTANCE) {
                    setSimilarAuthors(filteredSimilar.slice(0, 5));
                } else {
                    setSimilarAuthors([]);
                }
            } else {
                setSimilarAuthors([]);
            }
        } else {
            setAutocompleteSuggestions([]);
            setSimilarAuthors([]);
        }
    }, 300);

    const isNewAuthor = inputValue.trim() !== '' && !availableAuthors.some(author => author.name.toLowerCase() === inputValue.trim().toLowerCase());

    return (
        <Box>
            <Box mb={2}>
                {value.map((author) => (
                    <Chip
                        key={author.id}
                        label={author.name}
                        onDelete={() => handleAuthorDelete(author)}
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
                placeholder="Add authors..."
            />
            {isNewAuthor && (
                <Box mt={1}>
                    <Button
                        variant="contained"
                        color="primary"
                        onClick={handleCreateOrSelectAuthor}
                        disabled={isCreatingAuthor}
                    >
                        Create New Author: {inputValue}
                    </Button>
                </Box>
            )}
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
            {similarAuthors.length > 0 && (
                <Box mt={1}>
                    <Typography variant="subtitle2">Did you mean:</Typography>
                    {similarAuthors.map((suggestion) => (
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

export default AuthorSelector;