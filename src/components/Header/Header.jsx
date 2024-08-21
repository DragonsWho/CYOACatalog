// src/components/Header/Header.jsx
// Version: 1.8.3
// Description: Added padding to the sides of the header content for better centralization

import React, { useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { AppBar, Toolbar, Typography, Box, Tooltip, useTheme, Container } from '@mui/material';
import { Link } from 'react-router-dom';
import SearchBar from './SearchBar';
import UserMenu from './UserMenu';
import Login from './Login';
import Button from '@mui/material/Button';

const SITE_TITLE = "CYOA.CAFE";
const ADD_CYOA_TEXT = "Add CYOA";
const LOGIN_TEXT = "Login";
const LOGIN_TOOLTIP = "Login to add a CYOA";

const Header = React.memo(function Header({ isAuthenticated, user, onLogout, onLoginSuccess }) {
    const [loginOpen, setLoginOpen] = useState(false);
    const theme = useTheme();

    const handleLoginOpen = useCallback(() => setLoginOpen(true), []);
    const handleLoginClose = useCallback(() => setLoginOpen(false), []);

    const handleLoginSuccessInternal = useCallback((userData) => {
        onLoginSuccess(userData);
        handleLoginClose();
    }, [onLoginSuccess, handleLoginClose]);

    return (
        <>
            <AppBar position="static" sx={{ width: '100%' }}>
                <Container maxWidth="lg">
                    <Toolbar disableGutters>
                        <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Typography
                                component={Link}
                                to="/"
                                variant="h6"
                                sx={{
                                    color: theme.palette.primary.main,
                                    textDecoration: 'none',
                                    fontWeight: 'bold',
                                    '&:hover': {
                                        color: theme.palette.primary.light,
                                    },
                                    transition: 'color 0.3s ease',
                                }}
                            >
                                {SITE_TITLE}
                            </Typography>
                            <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                <SearchBar />
                                <Tooltip title={isAuthenticated ? "" : LOGIN_TOOLTIP} arrow>
                                    <span>
                                        <Button
                                            color="inherit"
                                            component={Link}
                                            to="/create"
                                            sx={{
                                                ml: 2,
                                                mr: 1,
                                                opacity: isAuthenticated ? 1 : 0.5,
                                                '&.Mui-disabled': {
                                                    color: 'inherit',
                                                },
                                                fontSize: '0.875rem',
                                                padding: '4px 10px',
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
                                                justifyContent: 'center',
                                                fontSize: '0.875rem',
                                                padding: '4px 10px',
                                            }}
                                            aria-label={LOGIN_TEXT}
                                        >
                                            {LOGIN_TEXT}
                                        </Button>
                                    )}
                                </Box>
                            </Box>
                        </Box>
                    </Toolbar>
                </Container>
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