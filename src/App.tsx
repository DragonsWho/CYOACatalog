import { useState, useEffect, lazy, Suspense, useContext, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Container, Box, CircularProgress, GlobalStyles } from '@mui/material';
import Cookies from 'js-cookie'; // <-- 1. Импорт Cookies
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const CreateGame = lazy(() => import('./components/Add/CreateGame'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel'));
const VectorSearchPage = lazy(() => import('./components/Search/VectorSearchPage'));
import Login from './components/Header/Login';
import { AuthContext, pb, User, Tag, tagsCollection, authorsCollection, usersCollection } from './pocketbase/pocketbase';

const ModeratorRoute = ({ children }: { children: JSX.Element }) => {
  const { signedIn, isModerator } = useContext(AuthContext);
  const location = useLocation();

  if (!signedIn || !isModerator) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return children;
};

const PrivateRoute = ({ children }: { children: JSX.Element }) => {
    const { signedIn } = useContext(AuthContext);
    const location = useLocation();

    if (!signedIn) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }
    return children;
}

export type FilterMode = 'sfw' | 'all' | 'nsfw';

// --- 2. Константы для cookie ---
const FILTER_MODE_COOKIE = 'cyoa_filter_mode';
const DEFAULT_FILTER_MODE: FilterMode = 'all';
// -----------------------------

export default function App() {
  const getInitialUser = (): User | null => {
      const model = pb.authStore.model;
      return (model && model.collectionName === 'users') ? model as User : null;
  }
  const [user, setUser] = useState<User | null>(getInitialUser);
  const [signedIn, setSignedIn] = useState<boolean>(!!user);

  const [tags, setTags] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [blockedTags, setBlockedTags] = useState<Tag[]>([]);

  // --- 3. Инициализация filterMode из cookie ---
  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    if (savedMode === 'sfw' || savedMode === 'all' || savedMode === 'nsfw') {
        return savedMode;
    }
    return DEFAULT_FILTER_MODE;
  });
  // ------------------------------------------

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const [fetchedTags, fetchedAuthors] = await Promise.all([
           tagsCollection.getFullList({ sort: 'name', fields: 'name' }),
           authorsCollection.getFullList({ sort: 'name', fields: 'name' })
        ]);
        if (isMounted) {
            setTags(fetchedTags.map((tag) => tag.name));
            setAuthors(fetchedAuthors.map((author) => author.name));
        }
      } catch (error) { console.error("Error fetching tags or authors:", error); }
    })();
    return () => { isMounted = false; };
  }, []);

  const fetchBlockedTags = async (userId: string) => {
      try {
          const currentUserData = await usersCollection.getOne(userId, { expand: 'blocked_tags' });
          const userBlockedTags = currentUserData.expand?.blocked_tags || [];
          setBlockedTags(userBlockedTags);
      } catch (error) { console.error("Error fetching blocked tags:", error); setBlockedTags([]); }
  };

  useEffect(() => {
    const handleAuthChange = (_token: string | null, model: any | null) => {
      const currentUser = (model && model.collectionName === 'users') ? model as User : null;
      setSignedIn(!!currentUser);
      setUser(currentUser);

      if (currentUser) {
        fetchBlockedTags(currentUser.id);
      } else {
        setBlockedTags([]);
      }
    };

    handleAuthChange(pb.authStore.token, pb.authStore.model);
    const unsubscribe = pb.authStore.onChange(handleAuthChange);
    return () => { unsubscribe(); };
  }, []);

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

  const handleBlockedTagsUpdate = useCallback(() => {
      if (user) {
          fetchBlockedTags(user.id);
      }
  }, [user]);

  // --- 4. Функция для обновления состояния и cookie ---
  const handleFilterModeChange = useCallback((newMode: FilterMode) => {
      setFilterMode(newMode);
      Cookies.set(FILTER_MODE_COOKIE, newMode, { expires: 365 }); // Сохраняем на год
  }, []); // Пустой массив зависимостей, т.к. setFilterMode стабилен
  // ----------------------------------------------------

  return (
    <AuthContext.Provider value={{ signedIn, user, isModerator: user?.isModerator || false, blockedTags }}>
      <GlobalStyles styles={{ html: { overflowY: 'scroll' } }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
        <Header
          tags={tags}
          authors={authors}
          selectedTags={selectedTags}
          selectedAuthors={selectedAuthors}
          onTagChange={handleTagChange}
          onAuthorChange={handleAuthorChange}
          filterMode={filterMode}
          onFilterModeChange={handleFilterModeChange} // <-- 5. Используем новую функцию
        />
        <Container component="main" maxWidth={false} sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }} >
          <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress /></Box>}>
            <Routes>
              {/* Передаем filterMode и blockedTags в SearchPage */}
              <Route path="/" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/search" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/game/:id" element={<GameDetails />} />
              <Route path="/create" element={<PrivateRoute><CreateGame /></PrivateRoute>} />
              <Route path="/login" element={<Login />} />
              <Route path="/profile" element={<PrivateRoute><Profile blockedTags={blockedTags} onBlockedTagsUpdate={handleBlockedTagsUpdate} allTags={tags} /></PrivateRoute>} />
              <Route path="/moderator" element={<ModeratorRoute><ModeratorPanel /></ModeratorRoute>} />
              <Route path="/vector-search" element={<ModeratorRoute><VectorSearchPage /></ModeratorRoute>} />
            </Routes>
          </Suspense>
        </Container>
        <Footer />
      </Box>
    </AuthContext.Provider>
  );
}