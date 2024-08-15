// src/App.jsx
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header';
import GameList from './components/GameList';
import GameDetails from './components/GameDetails';
import CreateGame from './components/CreateGame';
import Login from './components/Login';


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
                </Routes>
            </Container>
        </Box>
    );
}

export default App;