// src/components/Header/Header.jsx
// Version: 1.3.1
// Description: Header component with login functionality and user menu

import React, { useState } from 'react';
import { AppBar, Toolbar, Button, Box, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';
import SearchBar from './SearchBar';
import UserMenu from './UserMenu';
import Login from './Login';

function Header({ isAuthenticated, user, onLogout, onLoginSuccess }) {
    const [loginOpen, setLoginOpen] = useState(false);

    const handleLoginOpen = () => setLoginOpen(true);
    const handleLoginClose = () => setLoginOpen(false);

    const handleLoginSuccessInternal = (userData) => {
        onLoginSuccess(userData);
        handleLoginClose();
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
                        <Tooltip title={isAuthenticated ? "" : "Login to add a CYOA"} arrow>
                            <span>
                                <Button
                                    color="inherit"
                                    component={Link}
                                    to="/create"
                                    sx={{
                                        mr: 2,
                                        opacity: isAuthenticated ? 1 : 0.5,
                                        '&.Mui-disabled': {
                                            color: 'inherit',
                                        },
                                    }}
                                    disabled={!isAuthenticated}
                                >
                                    Add CYOA
                                </Button>
                            </span>
                        </Tooltip>
                        <Box sx={{ width: 120 }}>
                            {isAuthenticated ? (
                                <UserMenu currentUser={user} onLogout={onLogout} />
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
            <Login
                open={loginOpen}
                onClose={handleLoginClose}
                onLoginSuccess={handleLoginSuccessInternal}
            />
        </>
    );
}

export default Header;