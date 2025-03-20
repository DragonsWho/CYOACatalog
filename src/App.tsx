// src/App.tsx
import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { Container, Box, CircularProgress } from '@mui/material';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const CreateGame = lazy(() => import('./components/Add/CreateGame'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel')); // Добавляем
import Login from './components/Header/Login';
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
    (async () => {
      const fetchedTags = await tagsCollection.getFullList({ sort: 'name', fields: 'name' });
      const fetchedAuthors = await authorsCollection.getFullList({ sort: 'name', fields: 'name' });
      setTags(fetchedTags.map((tag) => tag.name));
      setAuthors(fetchedAuthors.map((author) => author.name));
    })();
  }, []);

  useEffect(() => {
    return pb.authStore.onChange(() => {
      setSignedIn(!!pb.authStore.model);
      setUser(pb.authStore.model as User | null);
    });
  }, []);

  useEffect(() => {
    if (location.pathname !== '/' && location.pathname !== '/search') {
      setSelectedTags([]);
      setSelectedAuthors([]);
    }
  }, [location.pathname]);

  function handleTagChange(newTags: string[]) {
    setSelectedTags(newTags);
    if (location.pathname !== '/' && location.pathname !== '/search') navigate('/');
  }

  function handleAuthorChange(newAuthors: string[]) {
    setSelectedAuthors(newAuthors);
    if (location.pathname !== '/' && location.pathname !== '/search') navigate('/');
  }

  return (
    <AuthContext.Provider value={{ signedIn, user, isModerator: user?.isModerator || false }}>
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
          <Suspense fallback={<Box sx={{ display: 'flex' }}><CircularProgress /></Box>}>
            <Routes>
              <Route path="/" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} />} />
              <Route
                path="/search"
                element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} />}
              />
              <Route path="/game/:id" element={<GameDetails />} />
              <Route path="/create" element={signedIn ? <CreateGame /> : <Login />} />
              <Route path="/login" element={<Login />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/moderator" element={<ModeratorPanel />} /> {/* Новый маршрут */}
            </Routes>
          </Suspense>
        </Container>
        <Footer />
      </Box>
    </AuthContext.Provider>
  );
}