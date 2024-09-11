// src/App.tsx

import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Container, Box } from '@mui/material';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
import GameDetails from './components/CyoaPage/GameDetails';
import CreateGame from './components/Add/CreateGame';
import Login from './components/Header/Login';
import Profile from './components/Profile/Profile';
import { AuthContext, pb, User } from './pocketbase/pocketbase';
import { tagsCollection, authorsCollection } from './pocketbase/pocketbase';

export default function App() {
  const [signedIn, setSignedIn] = useState(!!pb.authStore.model);
  const [user, setUser] = useState<User | null>(pb.authStore.model as User | null);
  const [tags, setTags] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const fetchTagsAndAuthors = async () => {
      const fetchedTags = await tagsCollection.getFullList({ sort: 'name' });
      const fetchedAuthors = await authorsCollection.getFullList({ sort: 'name' });
      setTags(fetchedTags.map(tag => tag.name));
      setAuthors(fetchedAuthors.map(author => author.name));
    };

    fetchTagsAndAuthors();

    return pb.authStore.onChange(() => {
      setSignedIn(!!pb.authStore.model);
      setUser(pb.authStore.model as User | null);
    });
  }, []);

  // Resetting selected tags and authors when navigating to pages other than the main page
  useEffect(() => {
    if (location.pathname !== '/' && location.pathname !== '/search') {
      setSelectedTags([]);
      setSelectedAuthors([]);
    }
  }, [location.pathname]);

  const handleTagChange = useCallback((newTags: string[]) => {
    setSelectedTags(newTags);
    if (location.pathname !== '/' && location.pathname !== '/search') {
      navigate('/');
    }
  }, [location.pathname, navigate]);

  const handleAuthorChange = useCallback((newAuthors: string[]) => {
    setSelectedAuthors(newAuthors);
    if (location.pathname !== '/' && location.pathname !== '/search') {
      navigate('/');
    }
  }, [location.pathname, navigate]);

  return (
    <AuthContext.Provider value={{ signedIn, user }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
        <Header
          tags={tags}
          authors={authors}
          selectedTags={selectedTags}
          selectedAuthors={selectedAuthors}
          onTagChange={handleTagChange}
          onAuthorChange={handleAuthorChange}
        />
        <Container
          component="main"
          maxWidth={false}
          sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <Routes>
            <Route path="/" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} />} />
            <Route path="/search" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} />} />
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