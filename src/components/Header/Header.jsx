// src/components/Header/Header.jsx
// Version 1.11
// constant weight


import React, { useState, useEffect } from 'react';
import { AppBar, Toolbar, Button, Box, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';
import authService from '../../services/authService';
import SearchBar from './SearchBar';
import UserMenu from './UserMenu';
import Login from './Login';

function Header() {
    const [currentUser, setCurrentUser] = useState(null);
    const [loginOpen, setLoginOpen] = useState(false);

    useEffect(() => {
        updateCurrentUser();
    }, []);

    const updateCurrentUser = () => {
        const user = authService.getCurrentUser();
        if (user && user.user) {
            setCurrentUser(user.user);
        } else {
            setCurrentUser(null);
        }
    };

    const handleLoginOpen = () => setLoginOpen(true);
    const handleLoginClose = () => setLoginOpen(false);

    const handleLoginSuccess = (user) => {
        setCurrentUser(user.user);
        handleLoginClose();
    };

    const handleLogout = () => {
        authService.logout();
        setCurrentUser(null);
    };

    return (
        <>
            <AppBar position="static" sx={{ width: '100%' }}>
                <Toolbar sx={{ width: '100%', maxWidth: 'xl', margin: '0 auto', justifyContent: 'space-between' }}>
                    <Button
                        color="inherit"
                        component={Link}
                        to="/"
                        sx={{ fontSize: '1.25rem', fontWeight: 'bold' }}
                    >
                        CYOA Catalog
                    </Button>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <SearchBar />
                        <Tooltip title={currentUser ? "" : "Login to add a CYOA"} arrow>
                            <span>
                                <Button
                                    color="inherit"
                                    component={Link}
                                    to="/create"
                                    sx={{
                                        mr: 2,
                                        opacity: currentUser ? 1 : 0.5,
                                        '&.Mui-disabled': {
                                            color: 'inherit',
                                        },
                                    }}
                                    disabled={!currentUser}
                                >
                                    Add CYOA
                                </Button>
                            </span>
                        </Tooltip>
                        <Box sx={{ width: 120 }}>
                            {currentUser ? (
                                <UserMenu currentUser={currentUser} onLogout={handleLogout} />
                            ) : (
                                <Button
                                    color="inherit"
                                    onClick={handleLoginOpen}
                                    sx={{
                                        width: '100%',
                                        justifyContent: 'center'
                                    }}
                                >
                                    Login
                                </Button>
                            )}
                        </Box>
                    </Box>
                </Toolbar>
            </AppBar>
            <Login open={loginOpen} onClose={handleLoginClose} onLoginSuccess={handleLoginSuccess} />
        </>
    );
}

export default Header;