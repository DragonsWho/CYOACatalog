// src/components/Header/Header.jsx
// Version: 1.3.0
// Description: Enhanced Header component with prop types, memoization, and accessibility improvements

import React, { useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { AppBar, Toolbar, Button, Box, Tooltip } from '@mui/material';
import { Link } from 'react-router-dom';
import SearchBar from './SearchBar';
import UserMenu from './UserMenu';
import Login from './Login';

const SITE_TITLE = "CYOA Catalog";
const ADD_CYOA_TEXT = "Add CYOA";
const LOGIN_TEXT = "Login";
const LOGIN_TOOLTIP = "Login to add a CYOA";

const Header = React.memo(function Header({ isAuthenticated, user, onLogout, onLoginSuccess }) {
    const [loginOpen, setLoginOpen] = useState(false);

    const handleLoginOpen = useCallback(() => setLoginOpen(true), []);
    const handleLoginClose = useCallback(() => setLoginOpen(false), []);

    const handleLoginSuccessInternal = useCallback((userData) => {
        onLoginSuccess(userData);
        handleLoginClose();
    }, [onLoginSuccess, handleLoginClose]);

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
                        {SITE_TITLE}
                    </Button>
                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <SearchBar />
                        <Tooltip title={isAuthenticated ? "" : LOGIN_TOOLTIP} arrow>
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
                                    aria-label={ADD_CYOA_TEXT}
                                >
                                    {ADD_CYOA_TEXT}
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
                                    aria-label={LOGIN_TEXT}
                                >
                                    {LOGIN_TEXT}
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
});

Header.propTypes = {
    isAuthenticated: PropTypes.bool.isRequired,
    user: PropTypes.object,
    onLogout: PropTypes.func.isRequired,
    onLoginSuccess: PropTypes.func.isRequired,
};

export default Header;