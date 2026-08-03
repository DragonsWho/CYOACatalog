// src/App.tsx

import { useState, useEffect, lazy, Suspense, useContext, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate, useParams, Navigate } from 'react-router-dom';
import {
  Container, Box, CircularProgress, GlobalStyles,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button
} from '@mui/material';
import Cookies from 'js-cookie';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import OverloadNotice from './components/OverloadNotice';
import SearchPage from './components/Search/SearchPage';
const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const ModeratorPanel = lazy(() => import('./components/ModeratorPanel/ModeratorPanel'));
const PipelineReviewPanel = lazy(() => import('./components/ModeratorPanel/PipelineReviewPanel'));
const PublicationQueuePanel = lazy(() => import('./components/ModeratorPanel/PublicationQueuePanel'));
const ViewStatsPanel = lazy(() => import('./components/ModeratorPanel/ViewStatsPanel'));
const ModRequestsPanel = lazy(() => import('./components/Moderation/ModRequestsPanel'));
const VectorSearchPage = lazy(() => import('./components/Search/VectorSearchPage'));
const SemanticSearchPage = lazy(() => import('./components/Search/SemanticSearchPage'));
const PrivacyPolicy = lazy(() => import('./components/Header/Legal/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./components/Header/Legal/TermsOfService'));
import Login from './components/Header/Login';
import Recovery from './components/Header/Recovery';
import EmailVerificationPrompt, {
  EMAIL_VERIFICATION_PROMPT_QUERY,
  EMAIL_VERIFICATION_PROMPT_VALUE,
} from './components/Header/EmailVerificationPrompt';
const VerificationPage = lazy(() => import('./components/Header/Verification'));
import { AuthModel } from 'pocketbase';
import type { ForcedAuthMode } from './components/Header/Header';
const Hosting = lazy(() => import('./components/Hosting/Hosting'));
// Скрытая тест-версия переработанной «Добавить игру» — после апрува заменит /create.
const AddGamePage = lazy(() => import('./components/AddGame/AddGamePage'));
const SuggestionsPanel = lazy(() => import('./components/ModeratorPanel/SuggestionsPanel'));
const CheatLab = lazy(() => import('./components/CheatLab/CheatLab'));
const ChatLab = lazy(() => import('./components/ChatLab/ChatLab'));
const AnnouncementsLog = lazy(() => import('./components/Announcements/AnnouncementsLog'));
const RoulettePage = lazy(() => import('./components/Roulette/RoulettePage'));
const RoulettePanel = lazy(() => import('./components/ModeratorPanel/RoulettePanel'));

import {
  AuthContext,
  MyBuiltGamesContext,
  TagCategoryContext,
  pb,
  refreshAuth,
  User,
  Tag,
  tagsCollectionPublic,
  tagCategoriesCollectionPublic,
} from './pocketbase/pocketbase';
import { fetchMyBuiltGameIds } from './components/CyoaPage/Comments/buildsApi';
import { getUsedTagIds } from './utils/tagUsage';
import { BUILD_POSTED_EVENT } from './utils/cheat';
import { analytics } from './utils/analytics';
import type { FilterMode } from './types';

// Совпадают ли два списка id (порядок значим — PB отдаёт стабильный порядок).
// Нужно, чтобы не подсовывать вниз новую ссылку на тот же самый список.
const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

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
};

// Old shared /header-lab/game/:id links → the real game page.
const LabGameRedirect = () => {
  const { id } = useParams();
  return <Navigate to={`/game/${id}`} replace />;
};

const FILTER_MODE_COOKIE = 'cyoa_filter_mode';
const AGE_VERIFIED_COOKIE = 'cyoa_age_verified';
const DEFAULT_FILTER_MODE: FilterMode = 'sfw';              // ← ИЗМЕНЕНО: было 'all'

export default function App() {
  const getInitialUser = (): User | null => {
    // A persisted model with an expired token is a zombie session: the header
    // would show the user as signed in while every authed write 401s. Only an
    // isValid token counts as signed in.
    if (!pb.authStore.isValid) return null;
    const model = pb.authStore.model;
    return model && 'collectionName' in model && model.collectionName === 'users'
      ? (model as User)
      : null;
  };
  const [user, setUser] = useState<User | null>(getInitialUser);
  const [signedIn, setSignedIn] = useState<boolean>(!!user);

  const [loginOpen, setLoginOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [forcedMode, setForcedMode] = useState<ForcedAuthMode>(null);
  const [verificationPromptOpen, setVerificationPromptOpen] = useState(false);

  const [tags, setTags] = useState<string[]>([]);
  const [tagCategoryMap, setTagCategoryMap] = useState<Map<string, string>>(() => {
    // Lazy-init from the localStorage cache so categories are present on the very
    // first paint (no empty-tags flash) when the map was already cached.
    try {
      const cached = localStorage.getItem('tagCategoryMap_v1');
      return cached ? new Map(JSON.parse(cached) as [string, string][]) : new Map();
    } catch {
      return new Map();
    }
  });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [blockedTags, setBlockedTags] = useState<Tag[]>([]);
  // Персональный блеклист игр (id). Живёт на users.blocked_games, отдаётся вниз
  // через AuthContext + пропом в SearchPage, где скрывает игры на клиенте.
  const [blockedGameIds, setBlockedGameIds] = useState<string[]>([]);

  // ── Filter mode (сохраняется в куки) ──
  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    if (savedMode === 'sfw' || savedMode === 'all' || savedMode === 'nsfw') {
      return savedMode;
    }
    return DEFAULT_FILTER_MODE;
  });

  // ── Age gate ──────────────────────────────────────────────── НОВОЕ
  const [ageVerified, setAgeVerified] = useState<boolean>(() => {
    // Если уже есть кука подтверждения — ок
    if (Cookies.get(AGE_VERIFIED_COOKIE) === 'true') return true;
    // Если пользователь ранее сохранил all/nsfw — значит уже подтверждал
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    return savedMode === 'all' || savedMode === 'nsfw';
  });
  const [ageDialogOpen, setAgeDialogOpen] = useState(false);
  const [pendingFilterMode, setPendingFilterMode] = useState<FilterMode | null>(null);
  // ──────────────────────────────────────────────────────────────

  const location = useLocation();
  const navigate = useNavigate();

  // Чат живёт во весь экран, как мессенджер: без полей по бокам, без подвала и
  // без прокрутки страницы — прокручивается только лента внутри него. Поэтому на
  // этом маршруте оболочка сайта из «минимум высоты» превращается в «ровно
  // высота экрана», а поля контейнера обнуляются.
  const chatFullBleed = location.pathname === '/chat-lab';

  useEffect(() => {
    // Страницы игр шлют свой page_view из GameDetails — там document.title уже
    // выставлен в название игры (оно грузится асинхронно, на момент навигации
    // ещё неизвестно). Здесь — все остальные роуты.
    if (location.pathname.startsWith('/game/')) return;
    window.gtag?.('event', 'page_view', {
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [location]);

  // --- Forum SSO bounce ---------------------------------------------------
  // The Flarum forum sends its Log In / Sign Up buttons here with ?sso=forum.
  // If the visitor is already logged into the catalog, bounce them straight
  // back to the forum's silent OIDC hop — instant login, no extra clicks.
  // If they're logged out, just drop the marker and let the login/registration
  // modal below open: they're already looking at the cyoa.cafe auth form, and
  // there's nothing to return yet.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('sso') !== 'forum') return;

    if (pb.authStore.isValid) {
      window.location.replace('https://forum.cyoa.cafe/auth/oidc?provider=cyoa&display=page');
      return;
    }

    params.delete('sso');
    const rest = params.toString();
    navigate(
      { pathname: location.pathname, search: rest ? `?${rest}` : '' },
      { replace: true },
    );
  }, [location.search, location.pathname, navigate]);

  // --- Routing Logic for Modals ---
  useEffect(() => {
    if (location.pathname.startsWith('/login')) {
      setLoginOpen(true);
      setRecoveryOpen(false);
    } else if (location.pathname.startsWith('/recovery')) {
      setRecoveryOpen(true);
      setLoginOpen(false);
    }
  }, [location.pathname]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const flowId = params.get('flow');
    const flowType = params.get('flow_type');

    if (!flowId || !flowType) {
      setForcedMode(null);
      return;
    }

    if (flowType === 'recovery') {
      setRecoveryOpen(true);
      setLoginOpen(false);
      return;
    }

    if (flowType !== 'registration' && flowType !== 'login') {
      return;
    }

    if (!loginOpen) {
      setLoginOpen(true);
      setRecoveryOpen(false);
    }

    if (flowType === 'registration') {
      setForcedMode('register-email');
    } else {
      setForcedMode('login');
    }
  }, [location.search, loginOpen]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const prompt = params.get(EMAIL_VERIFICATION_PROMPT_QUERY);
    setVerificationPromptOpen(prompt === EMAIL_VERIFICATION_PROMPT_VALUE);
  }, [location.search]);

  const handleCloseVerificationPrompt = () => {
    setVerificationPromptOpen(false);
    const params = new URLSearchParams(location.search);
    if (params.has(EMAIL_VERIFICATION_PROMPT_QUERY)) {
      params.delete(EMAIL_VERIFICATION_PROMPT_QUERY);
      const nextSearch = params.toString();
      navigate(
        {
          pathname: location.pathname,
          search: nextSearch ? `?${nextSearch}` : '',
        },
        { replace: true },
      );
    }
  };

  const handleCloseLogin = () => {
    setLoginOpen(false);
    setForcedMode(null);
    if (location.pathname.startsWith('/login')) {
      navigate('/');
    }
  };

  const handleCloseRecovery = () => {
    setRecoveryOpen(false);
    if (location.pathname.startsWith('/recovery')) {
      navigate('/');
    }
  };

  // Full tag list feeds Profile's blocked-tags editor. (The header used to also
  // need a full authors list for its autocomplete — the unified header does live
  // typeahead instead, so that per-page-load getFullList is gone.)
  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        // Пустые (0 игр) теги исключаем из опций поиска — иначе они «выпрыгивают»
        // в подсказках, но по ним всегда 0 результатов. Курируемые категории в
        // форме Add показываются отдельно (другой компонент), их это не трогает.
        const [fetchedTags, usedIds] = await Promise.all([
          tagsCollectionPublic.getFullList({ sort: 'name', fields: 'id,name' }),
          getUsedTagIds(),
        ]);
        if (isMounted) {
          const names = usedIds.size
            ? fetchedTags.filter((t) => usedIds.has(t.id)).map((t) => t.name)
            : fetchedTags.map((t) => t.name); // фолбэк: агрегат не собрался — не режем
          setTags(names);
        }
      } catch (error) {
        console.error('Error fetching tags:', error);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  // Global tagId → categoryName map (taxonomy is identical for every game). Loaded
  // once and shared via TagCategoryContext so catalog queries can drop the per-game
  // `tags.tag_categories_via_tags` expand. Cached in localStorage for 24h, mirroring
  // the existing tagMap_v2 caching in SearchPage.
  useEffect(() => {
    let isMounted = true;
    const CACHE_KEY = 'tagCategoryMap_v1';
    const CACHE_TS_KEY = 'tagCategoryMap_v1_updated';
    const TTL = 24 * 60 * 60 * 1000;
    (async () => {
      try {
        // Fresh cache was already applied by the lazy useState initializer; only
        // hit the network when it's missing or older than the TTL.
        const ts = localStorage.getItem(CACHE_TS_KEY);
        if (localStorage.getItem(CACHE_KEY) && ts && Date.now() - Number(ts) < TTL) {
          return;
        }
        const categories = await tagCategoriesCollectionPublic.getFullList({ fields: 'name,tags' });
        const map = new Map<string, string>();
        for (const category of categories) {
          for (const tagId of category.tags ?? []) {
            map.set(tagId, category.name);
          }
        }
        if (isMounted) setTagCategoryMap(map);
        localStorage.setItem(CACHE_KEY, JSON.stringify([...map]));
        localStorage.setItem(CACHE_TS_KEY, Date.now().toString());
      } catch (error) {
        console.error('Error fetching tag categories:', error);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const handleAuthChange = (_token: string | null, model: AuthModel | null) => {
      const currentUser =
        pb.authStore.isValid &&
        model && 'collectionName' in model && model.collectionName === 'users'
          ? (model as User)
          : null;
      setSignedIn(!!currentUser);
      setUser(currentUser);
      // ВАЖНО: подменяем массив только если реально изменился состав. onChange
      // прилетает и без действий юзера — например, соседняя вкладка обновила
      // токен (LocalAuthStore слушает `storage`), т.е. на КАЖДОЕ открытие
      // карточки в новой вкладке. Новая ссылка на тот же список дёргала эффекты
      // ниже по дереву (SearchPage: перезапрос ленты и перекат Random-таба).
      const nextTags = currentUser?.expand?.blocked_tags ?? [];
      setBlockedTags((prev) => (sameIds(prev.map((t) => t.id), nextTags.map((t) => t.id)) ? prev : nextTags));
      // blocked_games приходит как массив id прямо на записи (без expand).
      const nextGames = currentUser?.blocked_games ?? [];
      setBlockedGameIds((prev) => (sameIds(prev, nextGames) ? prev : nextGames));
    };

    const unsubscribe = pb.authStore.onChange(handleAuthChange);

    if (pb.authStore.isValid && pb.authStore.model) {
      handleAuthChange(pb.authStore.token, pb.authStore.model as User);
    }

    // Keep the token alive while the user is active: renew it on load and each
    // time the tab regains focus (throttled). onChange above propagates both the
    // refreshed model and a clear() (dead token) into signedIn, so a lapsed
    // session immediately flips the UI to logged-out instead of silently failing.
    void refreshAuth();
    let lastRefresh = Date.now();
    const maybeRefresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - lastRefresh < 5 * 60 * 1000) return;
      lastRefresh = Date.now();
      void refreshAuth();
    };
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);

    return () => {
      unsubscribe();
      window.removeEventListener('focus', maybeRefresh);
      document.removeEventListener('visibilitychange', maybeRefresh);
    };
  }, []);

  useEffect(() => {
    if (location.pathname !== '/' && location.pathname !== '/search') {
      setSelectedTags([]);
      setSelectedAuthors([]);
    }
  }, [location.pathname]);

  // Ids of games the user has a build for — one id-only query against the
  // `builds` registry, so the catalog cards can show the "built this" die badge
  // without touching the shared (anonymous, cacheable) game list payload.
  // Refreshed when a build is posted from the cheat bridge (BUILD_POSTED_EVENT).
  const [myBuiltGameIds, setMyBuiltGameIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let isMounted = true;
    if (!user) {
      setMyBuiltGameIds(new Set());
      return;
    }
    const load = () => {
      fetchMyBuiltGameIds()
        .then((ids) => {
          if (isMounted) setMyBuiltGameIds(ids);
        })
        .catch(() => {
          /* badge is cosmetic — stay silent if the collection isn't reachable */
        });
    };
    load();
    window.addEventListener(BUILD_POSTED_EVENT, load);
    return () => {
      isMounted = false;
      window.removeEventListener(BUILD_POSTED_EVENT, load);
    };
  }, [user]);

  const handleBlockedTagsUpdate = useCallback(() => {
    if (user) {
      pb
        .collection('users')
        .authRefresh({ expand: 'blocked_tags' })
        .catch((err) => {
          console.error('Failed to refresh user data after blocking tags:', err);
        });
    }
  }, [user]);

  // После изменения персонального блеклиста игр (из профиля или кнопки на
  // странице игры) обновляем модель — authRefresh триггерит onChange выше, и
  // blockedGameIds пересчитывается из свежего currentUser.blocked_games.
  const handleBlockedGamesUpdate = useCallback(() => {
    if (user) {
      pb
        .collection('users')
        .authRefresh({ expand: 'blocked_tags' })
        .catch((err) => {
          console.error('Failed to refresh user data after blocking games:', err);
        });
    }
  }, [user]);

  // ── Filter mode change с age gate ──────────────────────── ИЗМЕНЕНО
  const handleFilterModeChange = useCallback((newMode: FilterMode) => {
    // Переключение на SFW — всегда без вопросов
    if (newMode === 'sfw' || ageVerified) {
      analytics.filterToggle(newMode);
      setFilterMode(newMode);
      Cookies.set(FILTER_MODE_COOKIE, newMode, { expires: 365 });
    } else {
      // Первый раз пытается уйти с SFW — спрашиваем возраст
      setPendingFilterMode(newMode);
      setAgeDialogOpen(true);
    }
  }, [ageVerified]);

  const handleAgeConfirm = useCallback(() => {
    setAgeVerified(true);
    Cookies.set(AGE_VERIFIED_COOKIE, 'true', { expires: 365 });
    if (pendingFilterMode) {
      analytics.filterToggle(pendingFilterMode);
      setFilterMode(pendingFilterMode);
      Cookies.set(FILTER_MODE_COOKIE, pendingFilterMode, { expires: 365 });
    }
    setAgeDialogOpen(false);
    setPendingFilterMode(null);
  }, [pendingFilterMode]);

  const handleAgeDecline = useCallback(() => {
    setAgeDialogOpen(false);
    setPendingFilterMode(null);
    // Остаёмся на SFW
    setFilterMode('sfw');
    Cookies.set(FILTER_MODE_COOKIE, 'sfw', { expires: 365 });
  }, []);
  // ──────────────────────────────────────────────────────────────

  return (
    <AuthContext.Provider
      value={{
        signedIn,
        user,
        isModerator: user?.isModerator || false,
        blockedTags,
        blockedGameIds,
      }}
    >
      <TagCategoryContext.Provider value={tagCategoryMap}>
      <MyBuiltGamesContext.Provider value={myBuiltGameIds}>
      <GlobalStyles styles={{ html: { overflowY: 'scroll' } }} />
      {/* Turns the backend's load-shedding 503 into one plain notice instead of
          a hung spinner (see components/OverloadNotice.tsx). */}
      <OverloadNotice />
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          // 100vh on iOS is the LARGE viewport (it excludes the collapsible
          // browser toolbar), so the footer/last content slides under the
          // bottom bar. dvh tracks the live viewport; keep 100vh as a fallback
          // for the rare browser without dvh support. The safe-area padding
          // (now live thanks to viewport-fit=cover in index.html) keeps the
          // bottom content off the iOS home indicator.
          minHeight: '100vh',
          '@supports (min-height: 100dvh)': { minHeight: '100dvh' },
          paddingBottom: 'env(safe-area-inset-bottom)',
          width: '100%',
          ...(chatFullBleed ? {
            height: '100vh',
            '@supports (height: 100dvh)': { height: '100dvh', minHeight: '100dvh' },
            overflow: 'hidden',
          } : null),
        }}
      >
        {/* The one site header for all viewports (grew up as the /header-lab mobile
            redesign; the retired desktop pair lives in archive/). */}
        <Header
          filterMode={filterMode}
          onFilterModeChange={handleFilterModeChange}
          onLoginClick={() => setLoginOpen(true)}
        />

        <Container
          component="main"
          maxWidth={false}
          disableGutters={chatFullBleed}
          sx={{
            mt: chatFullBleed ? 0 : 4,
            mb: chatFullBleed ? 0 : 4,
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            // minHeight:0 — иначе flex-элемент не даёт ленте внутри прокручиваться:
            // по умолчанию он не сжимается ниже своего содержимого.
            ...(chatFullBleed ? { minHeight: 0 } : null),
          }}
        >
          <Suspense
            fallback={
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  height: '100%',
                }}
              >
                <CircularProgress />
              </Box>
            }
          >
            <Routes>
              <Route
                path="/"
                element={
                  <SearchPage
                    selectedTags={selectedTags}
                    selectedAuthors={selectedAuthors}
                    filterMode={filterMode}
                    blockedTags={blockedTags}
                  />
                }
              />
              <Route
                path="/search"
                element={
                  <SearchPage
                    selectedTags={selectedTags}
                    selectedAuthors={selectedAuthors}
                    filterMode={filterMode}
                    blockedTags={blockedTags}
                  />
                }
              />
              <Route path="/semantic-search" element={<SemanticSearchPage />} />
              {/* The header preview graduated to being THE header — redirect old
                  shared /header-lab links to their real pages. */}
              <Route path="/header-lab" element={<Navigate to="/" replace />} />
              <Route path="/header-lab/game/:id" element={<LabGameRedirect />} />
              <Route path="/game/:id" element={<GameDetails />} />
              {/* Hidden cheat prototype — see components/CheatLab + cheat.go. */}
              <Route path="/cheat-lab" element={<CheatLab />} />
              {/* The shoutbox graduated to the header chat bubble; its old test bench
                  route just goes home. */}
              <Route path="/shout-lab" element={<Navigate to="/" replace />} />
              {/* Chat v2 test bench — hidden while it's being polished, noindex.
                  Spec: wiki/components/shoutbox-v2-spec.md */}
              <Route path="/chat-lab" element={<ChatLab />} />

              <Route path="/log" element={<AnnouncementsLog />} />
              <Route path="/privacy-policy" element={<PrivacyPolicy />} />
              <Route path="/terms-of-service" element={<TermsOfService />} />
              <Route path="/hosting" element={<Hosting />} />
              <Route path="/roulette" element={<RoulettePage />} />
              {/* Reworked add-game page: public education sections + login-gated
                  actions inside (SuggestLink / Hosting / ManualCreate self-gate).
                  Canonical at /create; /add-next is the old preview URL → redirect. */}
              <Route path="/create" element={<AddGamePage />} />
              <Route path="/add-next" element={<Navigate to="/create" replace />} />
              <Route
                path="/login"
                element={
                  <SearchPage
                    selectedTags={selectedTags}
                    selectedAuthors={selectedAuthors}
                    filterMode={filterMode}
                    blockedTags={blockedTags}
                  />
                }
              />
              <Route
                path="/recovery"
                element={
                  <SearchPage
                    selectedTags={selectedTags}
                    selectedAuthors={selectedAuthors}
                    filterMode={filterMode}
                    blockedTags={blockedTags}
                  />
                }
              />
              <Route
                path="/profile"
                element={
                  <PrivateRoute>
                    <Profile
                      blockedTags={blockedTags}
                      onBlockedTagsUpdate={handleBlockedTagsUpdate}
                      allTags={tags}
                      blockedGameIds={blockedGameIds}
                      onBlockedGamesUpdate={handleBlockedGamesUpdate}
                    />
                  </PrivateRoute>
                }
              />
              <Route path="/verification" element={<VerificationPage />} />
              <Route
                path="/moderator"
                element={
                  <ModeratorRoute>
                    <ModeratorPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/review"
                element={
                  <ModeratorRoute>
                    <PipelineReviewPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/suggestions"
                element={
                  <ModeratorRoute>
                    <SuggestionsPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/queue"
                element={
                  <ModeratorRoute>
                    <PublicationQueuePanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/tickets"
                element={
                  <ModeratorRoute>
                    <ModRequestsPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/stats"
                element={
                  <ModeratorRoute>
                    <ViewStatsPanel />
                  </ModeratorRoute>
                }
              />
              <Route
                path="/moderator/roulette"
                element={
                  <ModeratorRoute>
                    <RoulettePanel />
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
            </Routes>
          </Suspense>
        </Container>
        {!chatFullBleed && <Footer />}

        <EmailVerificationPrompt
          open={verificationPromptOpen}
          onClose={handleCloseVerificationPrompt}
        />
        <Login
          open={loginOpen}
          onClose={handleCloseLogin}
          onLoginSuccess={handleCloseLogin}
          forcedMode={forcedMode}
        />
        <Recovery
          open={recoveryOpen}
          onClose={handleCloseRecovery}
        />

        {/* ── Age Verification Dialog ──────────────────── НОВОЕ */}
        <Dialog
          open={ageDialogOpen}
          onClose={handleAgeDecline}
          PaperProps={{
            sx: {
              borderRadius: 3,
              maxWidth: 420,
              mx: 'auto',
            },
          }}
        >
          <DialogTitle sx={{ textAlign: 'center', fontWeight: 700, pb: 1 }}>
            Age Verification
          </DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ textAlign: 'center', lineHeight: 1.7 }}>
              The content you are about to view may contain material intended
              for <strong>mature audiences only</strong>.
              <br /><br />
              By proceeding, you confirm that you are <strong>at least
              18&nbsp;years old</strong> and that viewing adult content is legal
              in your jurisdiction.
            </DialogContentText>
          </DialogContent>
          <DialogActions sx={{ justifyContent: 'center', gap: 1, pb: 2.5, px: 3 }}>
            <Button
              onClick={handleAgeDecline}
              variant="outlined"
              color="inherit"
              sx={{ borderRadius: 2, px: 3, textTransform: 'none' }}
            >
              No, take me back
            </Button>
            <Button
              onClick={handleAgeConfirm}
              variant="contained"
              color="primary"
              sx={{ borderRadius: 2, px: 3, textTransform: 'none', fontWeight: 600 }}
            >
              Yes, I'm 18+
            </Button>
          </DialogActions>
        </Dialog>
        {/* ────────────────────────────────────────────────────── */}
      </Box>
      </MyBuiltGamesContext.Provider>
      </TagCategoryContext.Provider>
    </AuthContext.Provider>
  );
}