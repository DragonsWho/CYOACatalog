// src/App.tsx

import { useState, useEffect, lazy, Suspense, useContext, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Container, Box, CircularProgress, GlobalStyles } from '@mui/material';
import Cookies from 'js-cookie';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const CreateGame = lazy(() => import('./components/Add/CreateGame'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel'));
const VectorSearchPage = lazy(() => import('./components/Search/VectorSearchPage'));
import Login from './components/Header/Login';
import { AuthModel } from 'pocketbase';

const SsoLoginPage = lazy(() => import('./components/Sso/SsoLoginPage'));
const SsoSignupPage = lazy(() => import('./components/Sso/SsoSignupPage'));
const SsoLogoutPage = lazy(() => import('./components/Sso/SsoLogoutPage'));
import { AuthContext, pb, User, Tag, tagsCollection, authorsCollection } from './pocketbase/pocketbase'; // Убрал usersCollection, т.к. больше не используется напрямую
import type { FilterMode } from './types';

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

const FILTER_MODE_COOKIE = 'cyoa_filter_mode';
const DEFAULT_FILTER_MODE: FilterMode = 'all';

export default function App() {
  const getInitialUser = (): User | null => {
      const model = pb.authStore.model;
      // Приводим модель к типу User, если она валидна
      return (model && 'collectionName' in model && model.collectionName === 'users') ? model as User : null;
  }
  const [user, setUser] = useState<User | null>(getInitialUser);
  const [signedIn, setSignedIn] = useState<boolean>(!!user);

  const [tags, setTags] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [blockedTags, setBlockedTags] = useState<Tag[]>([]);

  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    if (savedMode === 'sfw' || savedMode === 'all' || savedMode === 'nsfw') {
        return savedMode;
    }
    return DEFAULT_FILTER_MODE;
  });

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

  // --- НАЧАЛО ИЗМЕНЕНИЙ: Обновленный useEffect для аутентификации ---
  useEffect(() => {
    // Эта функция будет вызываться при логине, логауте и обновлении токена
    const handleAuthChange = (_token: string | null, model: AuthModel | null) => {
    // Проверяем, является ли модель пользователем, и приводим тип
    const currentUser = (model && 'collectionName' in model && model.collectionName === 'users') ? model as User : null;

    setSignedIn(!!currentUser);
    setUser(currentUser);

    if (currentUser && currentUser.expand?.blocked_tags) {
        setBlockedTags(currentUser.expand.blocked_tags);
    } else {
        setBlockedTags([]);
    }
};

    // Подписываемся на изменения в хранилище аутентификации
    const unsubscribe = pb.authStore.onChange(handleAuthChange);

    // Вызываем один раз при загрузке, чтобы установить начальное состояние из localStorage
    if (pb.authStore.isValid && pb.authStore.model) {
        handleAuthChange(pb.authStore.token, pb.authStore.model as User);
    }

    // Отписываемся при размонтировании компонента, чтобы избежать утечек памяти
    return () => {
        unsubscribe();
    };
  }, []); // Пустой массив зависимостей, выполняется один раз при монтировании
  // --- КОНЕЦ ИЗМЕНЕНИЙ ---

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
      // После сохранения в профиле, данные пользователя в pb.authStore могут обновиться,
      // но для надежности можно инициировать перезапрос или дождаться, когда onChange сработает.
      // В нашем новом useEffect'е, onChange должен сработать сам.
      // Если нет, можно принудительно обновить authStore:
      if (user) {
         pb.collection('users').authRefresh({ expand: 'blocked_tags' }).catch(err => {
            console.error("Failed to refresh user data after blocking tags:", err);
         });
      }
  }, [user]);

  const handleFilterModeChange = useCallback((newMode: FilterMode) => {
      setFilterMode(newMode);
      Cookies.set(FILTER_MODE_COOKIE, newMode, { expires: 365 });
  }, []);

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
          onFilterModeChange={handleFilterModeChange}
        />
        <Container component="main" maxWidth={false} sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }} >
          <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress /></Box>}>
            <Routes>
              <Route path="/" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/search" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/game/:id" element={<GameDetails />} />
              <Route path="/create" element={<PrivateRoute><CreateGame /></PrivateRoute>} />
              <Route path="/login" element={<Login />} />
              <Route path="/sso-login" element={<SsoLoginPage />} />
              <Route path="/sso-signup" element={<SsoSignupPage />} />
              <Route path="/sso-logout" element={<SsoLogoutPage />} />
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