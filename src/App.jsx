// src/App.jsx
// Version: 1.3.0
// Description: Main application component with routing and authentication state management

import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header/Header';
import GameList from './components/GameList';
import GameDetails from './components/CyoaPage/GameDetails';
import CreateGame from './components/Add/CreateGame';
import Login from './components/Header/Login';
import AuthCallback from './components/AuthCallback';
import authService from './services/authService';

function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        const checkAuth = () => {
            const authStatus = authService.isAuthenticated();
            setIsAuthenticated(authStatus);
            if (authStatus) {
                setUser(authService.getCurrentUser().user);
            }
        };

        checkAuth();
    }, []);

    const handleLoginSuccess = (userData) => {
        setIsAuthenticated(true);
        setUser(userData.user);
    };

    const handleLogout = () => {
        authService.logout();
        setIsAuthenticated(false);
        setUser(null);
        navigate('/');
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
            <Header
                isAuthenticated={isAuthenticated}
                user={user}
                onLogout={handleLogout}
                onLoginSuccess={handleLoginSuccess}
            />
            <Container component="main" maxWidth={false} sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <Routes>
                    <Route path="/" element={<GameList />} />
                    <Route path="/game/:id" element={<GameDetails />} />
                    <Route
                        path="/create"
                        element={
                            isAuthenticated ? <CreateGame /> : <Login onLoginSuccess={handleLoginSuccess} />
                        }
                    />
                    <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
                    <Route
                        path="/auth-callback"
                        element={<AuthCallback onLoginSuccess={handleLoginSuccess} />}
                    />
                </Routes>
            </Container>
        </Box>
    );
}

export default App;