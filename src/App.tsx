// src/App.tsx
import { useState, useEffect, lazy, Suspense, useContext } from 'react'; // Добавили useContext
import { Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom'; // Добавили Navigate
import { Container, Box, CircularProgress } from '@mui/material';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const CreateGame = lazy(() => import('./components/Add/CreateGame'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel'));
// --- Добавляем импорт для новой страницы ---
const VectorSearchPage = lazy(() => import('./components/Search/VectorSearchPage'));
// -----------------------------------------
import Login from './components/Header/Login';
import { AuthContext, pb, User } from './pocketbase/pocketbase';
import { tagsCollection, authorsCollection } from './pocketbase/pocketbase';

// --- Компонент-обертка для защищенных роутов модератора ---
const ModeratorRoute = ({ children }: { children: JSX.Element }) => {
  const { signedIn, isModerator } = useContext(AuthContext); // Получаем нужные значения из контекста

  // Проверяем, вошел ли пользователь и является ли он модератором
  if (!signedIn || !isModerator) {
    // Если нет, перенаправляем на главную страницу
    // `replace` заменяет текущую запись в истории, чтобы нельзя было вернуться назад кнопкой браузера
    return <Navigate to="/" replace />;
  }

  // Если все проверки пройдены, рендерим дочерний компонент (защищенную страницу)
  return children;
};
// ------------------------------------------------------
  
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
      const fetchedTags = await tagsCollection.getFullList({ sort: 'name' });
      const fetchedAuthors = await authorsCollection.getFullList({ sort: 'name' });
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
          <Suspense fallback={<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}><CircularProgress /></Box>}>
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
              {/* --- Обновляем роут модератора и добавляем новый --- */}
              <Route
                path="/moderator"
                element={
                  <ModeratorRoute>
                    <ModeratorPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/vector-search"
                element={
                  <ModeratorRoute>
                    <VectorSearchPage />
                  </ModeratorRoute>
                }
              />
              {/* ---------------------------------------------- */}
            </Routes>
          </Suspense>
        </Container>
        <Footer />
      </Box>
    </AuthContext.Provider>
  );
}