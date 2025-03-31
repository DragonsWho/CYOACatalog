// src/App.tsx
import { useState, useEffect, lazy, Suspense, useContext } from 'react';
import { Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { Container, Box, CircularProgress } from '@mui/material';
// --- Убираем проблемные импорты ---
// import PocketBase, { Record, Admin } from 'pocketbase';
// ---
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const CreateGame = lazy(() => import('./components/Add/CreateGame'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel'));
const VectorSearchPage = lazy(() => import('./components/Search/VectorSearchPage'));
import Login from './components/Header/Login';
// --- Используем существующие импорты ---
import { AuthContext, pb, User, Tag, tagsCollection, authorsCollection, usersCollection } from './pocketbase/pocketbase';

const ModeratorRoute = ({ children }: { children: JSX.Element }) => {
  const { signedIn, isModerator } = useContext(AuthContext);
  if (!signedIn || !isModerator) {
    return <Navigate to="/" replace />;
  }
  return children;
};

export type FilterMode = 'sfw' | 'all' | 'nsfw';

export default function App() {
  const getInitialUser = (): User | null => {
      const model = pb.authStore.model;
      // Используем проверку collectionName, она должна быть надежной
      return (model && model.collectionName === 'users') ? model as User : null;
  }
  const [user, setUser] = useState<User | null>(getInitialUser);
  const [signedIn, setSignedIn] = useState<boolean>(!!user);

  const [tags, setTags] = useState<string[]>([]);
  const [authors, setAuthors] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [blockedTags, setBlockedTags] = useState<Tag[]>([]);

  const location = useLocation();
  const navigate = useNavigate();

  // Загрузка общих тегов и авторов
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

  // Загрузка заблокированных тегов пользователя
  const fetchBlockedTags = async (userId: string) => {
      try {
          const currentUserData = await usersCollection.getOne(userId, { expand: 'blocked_tags' });
          const userBlockedTags = currentUserData.expand?.blocked_tags || [];
          console.log("Fetched blocked tags for user:", userBlockedTags.map(t => t.name));
          setBlockedTags(userBlockedTags);
      } catch (error) { console.error("Error fetching blocked tags:", error); setBlockedTags([]); }
  };

  // Отслеживание состояния авторизации
  useEffect(() => {
    // --- ИЗМЕНЕНИЕ: Используем 'any' для model ---
    const handleAuthChange = (token: string | null, model: any | null) => {
      console.log("Auth changed raw model:", model);
      // Проверяем, что модель существует и это запись из коллекции 'users'
      // Мы по-прежнему можем безопасно проверять model.collectionName
      const currentUser = (model && model.collectionName === 'users') ? model as User : null;
      console.log("Auth changed currentUser as User:", currentUser);

      setSignedIn(!!currentUser);
      setUser(currentUser);

      if (currentUser) {
        fetchBlockedTags(currentUser.id);
      } else {
        setBlockedTags([]);
      }
    };
    // --- КОНЕЦ ИЗМЕНЕНИЯ ---

    // Вызываем при монтировании
    handleAuthChange(pb.authStore.token, pb.authStore.model); // model здесь тоже будет 'any'

    // Подписываемся
    const unsubscribe = pb.authStore.onChange(handleAuthChange);

    // Отписываемся
    return () => { console.log("Unsubscribing from auth changes."); unsubscribe(); };
  }, []);

  // Сброс выбранных тегов/авторов
  useEffect(() => {
    if (location.pathname !== '/' && location.pathname !== '/search') {
      setSelectedTags([]);
      setSelectedAuthors([]);
    }
  }, [location.pathname]);

  // Обработчики изменения тегов/авторов
  function handleTagChange(newTags: string[]) {
    setSelectedTags(newTags);
    if (location.pathname !== '/' && location.pathname !== '/search') navigate('/');
  }
  function handleAuthorChange(newAuthors: string[]) {
    setSelectedAuthors(newAuthors);
    if (location.pathname !== '/' && location.pathname !== '/search') navigate('/');
  }

  // Рендер
  return (
    <AuthContext.Provider value={{ signedIn, user, isModerator: user?.isModerator || false, blockedTags }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', width: '100%' }}>
        <Header tags={tags} authors={authors} selectedTags={selectedTags} selectedAuthors={selectedAuthors} onTagChange={handleTagChange} onAuthorChange={handleAuthorChange} filterMode={filterMode} onFilterModeChange={setFilterMode} />
        <Container component="main" maxWidth={false} sx={{ mt: 4, mb: 4, flex: 1, display: 'flex', flexDirection: 'column' }} >
          <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress /></Box>}>
            <Routes>
              <Route path="/" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/search" element={<SearchPage selectedTags={selectedTags} selectedAuthors={selectedAuthors} filterMode={filterMode} blockedTags={blockedTags} />} />
              <Route path="/game/:id" element={<GameDetails />} />
              <Route path="/create" element={signedIn ? <CreateGame /> : <Login />} />
              <Route path="/login" element={<Login />} />
              <Route path="/profile" element={<Profile blockedTags={blockedTags} onBlockedTagsUpdate={() => user ? fetchBlockedTags(user.id) : undefined} allTags={tags} />} />
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