// src/components/Header/SearchBar.jsx
// Version 1.4
// Description: Restored width, kept darker background

import React, { useState, useEffect } from 'react'
import { TextField, Autocomplete, CircularProgress } from '@mui/material'
import { Link, useNavigate } from 'react-router-dom'
import { searchGames } from '../../services/searchService'
import { useTheme } from '@mui/material/styles'

function SearchBar() {
    const [searchQuery, setSearchQuery] = useState('')
    const [searchResults, setSearchResults] = useState([])
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState(null)
    const navigate = useNavigate()
    const theme = useTheme()

    useEffect(() => {
        const delayDebounce = setTimeout(() => {
            if (searchQuery) {
                performSearch()
            } else {
                setSearchResults([])
                setError(null)
            }
        }, 300)

        return () => clearTimeout(delayDebounce)
    }, [searchQuery])

    const performSearch = async () => {
        setIsLoading(true)
        setError(null)
        try {
            const results = await searchGames(searchQuery)
            setSearchResults(results)
        } catch (error) {
            console.error('Error performing search:', error)
            setError('An error occurred while searching. Please try again.')
            setSearchResults([])
        } finally {
            setIsLoading(false)
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
                        width: 200, // Restored width
                        mr: 2,
                        backgroundColor: theme.palette.grey[800], // Kept darker background
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
                                padding: '7px 14px', // Adjusted padding
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
            onChange={(newValue) => {
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
