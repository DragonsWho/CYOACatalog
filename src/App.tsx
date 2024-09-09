// src/App.tsx
// Version: 1.5.0
// Description: Main application component with routing, authentication state management, and Footer

import { Routes, Route } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import GameList from './components/GameList';
import GameDetails from './components/CyoaPage/GameDetails';
import CreateGame from './components/Add/CreateGame';
import Login from './components/Header/Login';
import Profile from './components/Profile/Profile';
import { AuthContext, pb, User } from './pocketbase/pocketbase';
import { useEffect, useState } from 'react';

export default function App() {
  const [signedIn, setSignedIn] = useState(!!pb.authStore.model);
  const [user, setUser] = useState<User | null>(pb.authStore.model as User | null);
  useEffect(() => {
    return pb.authStore.onChange(() => {
      setSignedIn(!!pb.authStore.model);
      setUser(pb.authStore.model as User | null);
    });
  }, []);

  return (
    <AuthContext.Provider value={{ signedIn, user }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
        <Header />
        <Container
          component="main"
          maxWidth={false}
          sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <Routes>
            <Route path="/" element={<GameList />} />
            <Route path="/game/:id" element={<GameDetails />} />
            <Route path="/create" element={signedIn ? <CreateGame /> : <Login />} />
            <Route path="/login" element={<Login />} />
            <Route path="/profile" element={<Profile />} />
          </Routes>
        </Container>
        <Footer />
      </Box>
    </AuthContext.Provider>
  );
}
