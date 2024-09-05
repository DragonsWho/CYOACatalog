// src/components/Header/SearchBar.jsx
// Version 1.6
// Description: Simplified search functionality to fetch data only once when user starts typing

import React, { useState, useEffect, useCallback } from 'react'
import { TextField, Autocomplete, CircularProgress } from '@mui/material'
import { Link, useNavigate } from 'react-router-dom'
import { searchGames } from '../../services/searchService'
import { useTheme } from '@mui/material/styles'

function SearchBar() {
    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)
    const [hasInitialFetch, setHasInitialFetch] = useState(false)
    const navigate = useNavigate()
    const theme = useTheme()

    const performSearch = useCallback(async () => {
        if (!hasInitialFetch) {
            setIsLoading(true)
            setError(null)
            try {
                console.log('Performing initial search fetch')
                const results = await searchGames('')
                console.log('Initial search results:', results)
                setSearchResults(results)
                setHasInitialFetch(true)
            } catch (error) {
                console.error('Error performing initial search:', error)
                setError('An error occurred while fetching data. Please try again.')
                setSearchResults([])
            } finally {
                setIsLoading(false)
            }
        }
    }, [hasInitialFetch])

    useEffect(() => {
        performSearch()
    }, [performSearch])

    const handleSearchChange = (event, value) => {
        setSearchQuery(value)
        if (hasInitialFetch) {
            const filteredResults = searchResults.filter(game =>
                game.attributes.Title.toLowerCase().includes(value.toLowerCase())
            )
            setSearchResults(filteredResults)
        }
    }

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
                        backgroundColor: theme.palette.grey[800],
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
                            '& input': {
                                padding: '7px 14px',
                                color: theme.palette.text.primary,
                                fontSize: '0.875rem',
                            },
                        },
                        '& .MuiInputBase-input::placeholder': {
                            color: theme.palette.text.secondary,
                            opacity: 0.8,
                        },
                    }}
                />
            )}
            onInputChange={handleSearchChange}
            onChange={(event, newValue) => {
                if (newValue && newValue.id) {
                    console.log('Selected game:', newValue)
                    navigate(`/game/${newValue.id}`)
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
    )
}

export default SearchBar