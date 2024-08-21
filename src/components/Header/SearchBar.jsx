// src/components/Header/SearchBar.jsx
// Version 1.2
// Reduced vertical padding, darkened search field, increased text contrast

import React, { useState, useEffect } from 'react';
import { TextField, Autocomplete, CircularProgress } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import { searchGames, fetchAllGames } from '../../services/searchService';
import { useTheme } from '@mui/material/styles';

function SearchBar() {
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const navigate = useNavigate();
    const theme = useTheme();

    useEffect(() => {
        const delayDebounce = setTimeout(() => {
            if (searchQuery) {
                performSearch();
            } else {
                setSearchResults([]);
                setError(null);
            }
        }, 300);

        return () => clearTimeout(delayDebounce);
    }, [searchQuery]);

    const performSearch = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const results = await searchGames(searchQuery);
            setSearchResults(results);
        } catch (error) {
            console.error('Error performing search:', error);
            setError('An error occurred while searching. Please try again.');
            setSearchResults([]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Autocomplete
            freeSolo
            options={searchResults}
            getOptionLabel={(option) => option.attributes?.Title || ''}
            renderInput={(params) => (
                <TextField
                    {...params}
                    variant="outlined"
                    size="small"
                    placeholder="Search..."
                    onChange={(e) => setSearchQuery(e.target.value)}
                    error={!!error}
                    helperText={error}
                    InputProps={{
                        ...params.InputProps,
                        endAdornment: (
                            <React.Fragment>
                                {isLoading ? <CircularProgress color="inherit" size={20} /> : null}
                                {params.InputProps.endAdornment}
                            </React.Fragment>
                        ),
                    }}
                    sx={{
                        width: 200,
                        mr: 2,
                        backgroundColor: theme.palette.grey[600], // Darker background
                        borderRadius: 1,
                        '& .MuiOutlinedInput-root': {
                            '& fieldset': {
                                borderColor: 'transparent',
                            },
                            '&:hover fieldset': {
                                borderColor: 'transparent',
                            },
                            '&.Mui-focused fieldset': {
                                borderColor: 'transparent',
                            },
                            // Reduce vertical padding
                            '& input': {
                                padding: '4px 14px',
                                color: theme.palette.text.primary, // More contrasting text color
                            },
                        },
                        // Increase placeholder contrast
                        '& .MuiInputBase-input::placeholder': {
                            color: theme.palette.text.secondary,
                            opacity: 0.8,
                        },
                    }}
                />
            )}
            onChange={(event, newValue) => {
                if (newValue && newValue.id) {
                    console.log('Selected game:', newValue);
                    navigate(`/game/${newValue.id}`);
                }
            }}
            renderOption={(props, option) => (
                <li {...props} key={option.id}>
                    <Link to={`/game/${option.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                        {option.attributes.Title}
                    </Link>
                </li>
            )}
        />
    );
}

export default SearchBar;