// src/components/Header.jsx
import React from 'react';
import { AppBar, Toolbar, Typography, Button, Box } from '@mui/material';
import { Link } from 'react-router-dom';

function Header() {
    return (
        <AppBar position="static" sx={{ width: '100%' }}>
            <Toolbar sx={{ width: '100%', maxWidth: 'xl', margin: '0 auto' }}>
                <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
                    Game Catalog
                </Typography>
                <Box>
                    <Button color="inherit" component={Link} to="/">
                        Home
                    </Button>
                    <Button color="inherit" component={Link} to="/create">
                        Create Game
                    </Button>
                </Box>
            </Toolbar>
        </AppBar>
    );
}

export default Header;