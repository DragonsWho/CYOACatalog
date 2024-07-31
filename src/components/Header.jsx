// src/components/Header.jsx
// v 1.11
// Добавлена логика отображения кнопки "Account" для авторизованных пользователей

import React, { useState, useEffect } from 'react';
import { AppBar, Toolbar, Typography, Button, Box, TextField, Autocomplete, CircularProgress, Menu, MenuItem, Avatar } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import { searchGames, fetchAllGames } from '../services/searchService';
import authService from '../services/authService';

function Header() {
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [allGames, setAllGames] = useState([]);
    const navigate = useNavigate();

    // Состояния для меню пользователя
    const [anchorEl, setAnchorEl] = useState(null);
    const [currentUser, setCurrentUser] = useState(null);

    useEffect(() => {
        // Initialize cache and check for current user
        fetchAllGames()
            .then(games => setAllGames(games))
            .catch(error => console.error('Error initializing cache:', error));

        const user = authService.getCurrentUser();
        if (user && user.user) {
            setCurrentUser(user.user);
        } else {
            setCurrentUser(null);
        }
    }, []);

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

    // Обработчики для меню пользователя
    const handleMenuOpen = (event) => {
        setAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
        setAnchorEl(null);
    };

    const handleLogout = () => {
        authService.logout();
        setCurrentUser(null);
        handleMenuClose();
        navigate('/');
    };

    return (
        <AppBar position="static" sx={{ width: '100%' }}>
            <Toolbar sx={{ width: '100%', maxWidth: 'xl', margin: '0 auto' }}>
                <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                    Game Catalog
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center' }}>
                    <Autocomplete
                        freeSolo
                        options={searchResults}
                        getOptionLabel={(option) => option.attributes?.Title || ''}
                        renderInput={(params) => (
                            <TextField
                                {...params}
                                variant="outlined"
                                size="small"
                                placeholder="Search games..."
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
                                    backgroundColor: 'white',
                                    borderRadius: 1,
                                    '& .MuiOutlinedInput-root': {
                                        '& fieldset': {
                                            borderColor: 'white',
                                        },
                                        '&:hover fieldset': {
                                            borderColor: 'white',
                                        },
                                        '&.Mui-focused fieldset': {
                                            borderColor: 'white',
                                        },
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
                    <Button color="inherit" component={Link} to="/">
                        Home
                    </Button>
                    <Button color="inherit" component={Link} to="/create">
                        Create Game
                    </Button>
                    {currentUser ? (
                        <>
                            <Button color="inherit" onClick={handleMenuOpen}>
                                <Avatar sx={{ width: 32, height: 32, mr: 1 }}>
                                    {currentUser.username.charAt(0)}
                                </Avatar>
                                Account
                            </Button>
                            <Menu
                                anchorEl={anchorEl}
                                open={Boolean(anchorEl)}
                                onClose={handleMenuClose}
                            >
                                <MenuItem onClick={handleMenuClose} component={Link} to="/profile">Profile</MenuItem>
                                <MenuItem onClick={handleLogout}>Logout</MenuItem>
                            </Menu>
                        </>
                    ) : (
                        <Button color="inherit" component={Link} to="/login">
                            Login
                        </Button>
                    )}
                </Box>
            </Toolbar>
        </AppBar>
    );
}

export default Header;