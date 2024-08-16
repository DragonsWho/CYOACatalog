// src/App.jsx
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header/Header';
import GameList from './components/GameList';
import GameDetails from './components/CyoaPage/GameDetails';
import CreateGame from './components/Add/CreateGame';
import Login from './components/Header/Login';
import DiscordCallback from './components/Header/DiscordCallback';
import AuthCallback from './components/AuthCallback';


function App() {
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
            <Header />
            <Container component="main" maxWidth={false} sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}>
                <Routes>
                    <Route path="/" element={<GameList />} />
                    <Route path="/game/:id" element={<GameDetails />} />
                    <Route path="/create" element={<CreateGame />} />
                    <Route path="/login" element={<Login />} />
                    <Route path="/auth/discord/callback" element={<DiscordCallback />} />
                    <Route path="/auth-callback" element={<AuthCallback />} />
                </Routes>
            </Container>
        </Box>
    );
}

export default App;