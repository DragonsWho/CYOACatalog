// src/App.tsx
// Version: 1.5.0
// Description: Main application component with routing, authentication state management, and Footer

import { useState, useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import GameList from './components/GameList';
import GameDetails from './components/CyoaPage/GameDetails';
import CreateGame from './components/Add/CreateGame';
import Login from './components/Header/Login';
import Profile from './components/Profile/Profile';
import { pb } from './services/api';
import { User } from './pocketbase/pocketbase';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<User | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    return pb.authStore.onChange((_, model) => {
      setIsAuthenticated(!!model);
      setUser(model as User | null);
    }, true);
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
      <Header
        isAuthenticated={isAuthenticated}
        user={user}
        onLogout={() => {
          pb.authStore.clear();
          navigate('/');
        }}
      />
      <Container
        component="main"
        maxWidth={false}
        sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}
      >
        <Routes>
          <Route path="/" element={<GameList />} />
          <Route path="/game/:id" element={<GameDetails />} />
          <Route path="/create" element={isAuthenticated ? <CreateGame /> : <Login />} />
          <Route path="/login" element={<Login />} />
          <Route path="/profile" element={<Profile />} />
        </Routes>
      </Container>
      <Footer />
    </Box>
  );
}
