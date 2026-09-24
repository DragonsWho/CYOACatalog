import { useState, useEffect, useLayoutEffect, lazy, Suspense, useContext, useCallback } from 'react';
import { Routes, Route, useLocation, useNavigate, useNavigationType, useParams, Navigate } from 'react-router-dom';
import {
  Container, Box, GlobalStyles,
  Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions, Button
} from '@mui/material';
import Cookies from 'js-cookie';
import Header from './components/Header/Header';
import Footer from './components/Footer/Footer';
import OverloadNotice from './components/OverloadNotice';
import SearchPage from './components/Search/SearchPage';
import AppErrorBoundary from './components/AppErrorBoundary';
import PrepaintFallback from './components/PrepaintFallback';

const GameDetails = lazy(() => import('./components/CyoaPage/GameDetails'));
const Profile = lazy(() => import('./components/Profile/Profile'));
const PipelineReviewPanel = lazy(() => import('./components/ModeratorPanel/PipelineReviewPanel'));
const CommentsModerationPanel = lazy(() => import('./components/ModeratorPanel/CommentsModerationPanel'));
const PublicationQueuePanel = lazy(() => import('./components/ModeratorPanel/PublicationQueuePanel'));
const ViewStatsPanel = lazy(() => import('./components/ModeratorPanel/ViewStatsPanel'));
const ModRequestsPanel = lazy(() => import('./components/Moderation/ModRequestsPanel'));
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
const ConfirmEmailPage = lazy(() => import('./components/Header/ConfirmEmail'));
import { AuthModel } from 'pocketbase';
import type { ForcedAuthMode } from './components/Header/Header';
const Hosting = lazy(() => import('./components/Hosting/Hosting'));
const AddGamePage = lazy(() => import('./components/AddGame/AddGamePage'));
const SuggestionsPanel = lazy(() => import('./components/ModeratorPanel/SuggestionsPanel'));
const CheatPage = lazy(() => import('./components/Cheat/CheatPage'));
const ChatPage = lazy(() => import('./components/Chat/ChatPage'));
const EmojiLab = lazy(() => import('./components/EmojiLab/EmojiLab'));
const HomePage = lazy(() => import('./components/Home/HomePage'));
const AnnouncementsLog = lazy(() => import('./components/Announcements/AnnouncementsLog'));
const RoulettePage = lazy(() => import('./components/Roulette/RoulettePage'));
const RoulettePanel = lazy(() => import('./components/ModeratorPanel/RoulettePanel'));
const ModAccessPanel = lazy(() => import('./components/ModeratorPanel/ModAccessPanel'));
const ScreenshotStudio = lazy(() => import('./components/ModeratorPanel/ScreenshotStudio'));

import {
  AuthContext,
  MyBuiltGamesContext,
  TagCategoryContext,
  pb,
  refreshAuth,
  User,
  Tag,
} from './pocketbase/pocketbase';
import { fetchMyBuiltGameIds } from './components/CyoaPage/Comments/buildsApi';
import { loadTagDictionary, peekTagDictionary, tagCategoryMapOf } from './utils/tagDictionary';
import { BUILD_POSTED_EVENT } from './utils/cheat';
import { analytics } from './utils/analytics';
import { fetchMyModPerms } from './utils/modPerms';
import type { FilterMode } from './types';

const sameIds = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

// authRefresh and a neighbor tab's `storage` event return a FRESH record object with the same
// content; a new reference in context re-runs every consumer effect (Comments.tsx: a thread reload
// wiped a half-typed reply). Compare system field `updated`; fall back to content compare so
// profile edits aren't stuck.
const sameUser = (a: User | null, b: User | null): boolean => {
  if (a === b) return true;
  if (!a || !b || a.id !== b.id) return false;
  if (a.updated && b.updated) return a.updated === b.updated;
  return JSON.stringify(a) === JSON.stringify(b);
};

// `perm` = a key from mod_perms.go; without it, moderator role is enough. Lacking the perm → home,
// not /login (they're logged in). UI convenience only — real enforcement is in Go handlers.
const ModeratorRoute = ({ children, perm }: { children: JSX.Element; perm?: string }) => {
  const { signedIn, isModerator, hasModPerm } = useContext(AuthContext);
  const location = useLocation();

  if (!signedIn || !isModerator) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  if (perm && !hasModPerm(perm)) {
    return <Navigate to="/" replace />;
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

// Old feed-lab URLs redirect to home keeping their query (testers hold links like
// /feed-lab3?sort=top&tags=…).
const FeedLabRedirect = () => {
  const location = useLocation();
  return <Navigate to={`/${location.search}`} replace />;
};

const LabGameRedirect = () => {
  const { id } = useParams();
  return <Navigate to={`/game/${id}`} replace />;
};

const FILTER_MODE_COOKIE = 'cyoa_filter_mode';
const AGE_VERIFIED_COOKIE = 'cyoa_age_verified';
const DEFAULT_FILTER_MODE: FilterMode = 'sfw';

export default function App() {
  const getInitialUser = (): User | null => {
    // A persisted model with an expired token is a zombie session (header says signed in, every
    // authed write 401s). Only isValid counts.
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
    const dict = peekTagDictionary();
    return dict ? tagCategoryMapOf(dict) : new Map();
  });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [blockedTags, setBlockedTags] = useState<Tag[]>([]);
  const [blockedGameIds, setBlockedGameIds] = useState<string[]>([]);
  const [blockedAuthorIds, setBlockedAuthorIds] = useState<string[]>([]);

  // Moderator perms (mod_perms.go) aren't in the token — fetched once after login. Moderator
  // without explicit perms gets all keys from the backend (legacy).
  const [modPerms, setModPerms] = useState<string[]>([]);

  const [filterMode, setFilterMode] = useState<FilterMode>(() => {
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    if (savedMode === 'sfw' || savedMode === 'all' || savedMode === 'nsfw') {
      return savedMode;
    }
    return DEFAULT_FILTER_MODE;
  });

  const [ageVerified, setAgeVerified] = useState<boolean>(() => {
    if (Cookies.get(AGE_VERIFIED_COOKIE) === 'true') return true;
    const savedMode = Cookies.get(FILTER_MODE_COOKIE);
    return savedMode === 'all' || savedMode === 'nsfw';
  });
  const [ageDialogOpen, setAgeDialogOpen] = useState(false);
  const [pendingFilterMode, setPendingFilterMode] = useState<FilterMode | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  // Chat is full-screen like a messenger: on chat routes (/chat, /chat/r/<slug>, /chat/t/<slug>,
  // /chat/threads) the shell becomes exactly viewport height and container padding is zeroed; only
  // the feed scrolls.
  const chatFullBleed = /^\/chat(\/|$)/.test(location.pathname);
  // One element for all chat routes (ChatPage reads the URL itself). The adult flag comes from the
  // SITE header toggle, so every chat route gets it.
  const chatScreen = <ChatPage rating={filterMode} />;

  // A link to another page opens at its top. Without this the window kept the previous page's scroll
  // (a card deep in the feed opened its game half a screen down). Back/forward (POP) keeps the
  // browser's restoration; #anchors (comment links) scroll themselves.
  const navType = useNavigationType();
  useLayoutEffect(() => {
    if (navType !== 'POP' && !location.hash) window.scrollTo(0, 0);
  }, [location.pathname, navType, location.hash]);

  useEffect(() => {
    // Game pages send their own page_view from GameDetails (title loads async); here: all other
    // routes.
    if (location.pathname.startsWith('/game/')) return;
    window.gtag?.('event', 'page_view', {
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [location]);

  // Forum SSO bounce: Flarum's Log In/Sign Up link here with ?sso=forum. Logged in → bounce to the
  // forum's silent OIDC hop; logged out → drop the marker and let the login modal open.
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

  // Tag names for search options (0-game tags excluded — they'd always return 0 results) and the
  // global tagId → categoryName map (TagCategoryContext; lets catalog queries skip the per-game
  // taxonomy expand). Both from the one tag dictionary (utils/tagDictionary).
  useEffect(() => {
    let isMounted = true;
    loadTagDictionary()
      .then((dict) => {
        if (!isMounted) return;
        const used = new Set(dict.used);
        const visible = used.size ? dict.tags.filter((t) => used.has(t.id)) : dict.tags;
        setTags(visible.map((t) => t.name));
        setTagCategoryMap(tagCategoryMapOf(dict));
      })
      .catch((error) => console.error('Error loading tag dictionary:', error));
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
      // Replace the reference only if the record really changed, else each tab refocus
      // (refreshAuth) re-renders the whole tree.
      setUser((prev) => (sameUser(prev, currentUser) ? prev : currentUser));
      // Replace the array only if contents changed: onChange fires without user action (a neighbor
      // tab refreshing the token via `storage`), i.e. on every card opened in a new tab; a new
      // reference re-ran SearchPage's feed query and re-rolled the Random tab.
      const nextTags = currentUser?.expand?.blocked_tags ?? [];
      setBlockedTags((prev) => (sameIds(prev.map((t) => t.id), nextTags.map((t) => t.id)) ? prev : nextTags));
      const nextGames = currentUser?.blocked_games ?? [];
      setBlockedGameIds((prev) => (sameIds(prev, nextGames) ? prev : nextGames));
      const nextAuthors = currentUser?.blocked_authors ?? [];
      setBlockedAuthorIds((prev) => (sameIds(prev, nextAuthors) ? prev : nextAuthors));
    };

    const unsubscribe = pb.authStore.onChange(handleAuthChange);

    if (pb.authStore.isValid && pb.authStore.model) {
      handleAuthChange(pb.authStore.token, pb.authStore.model as User);
    }

    // Keep the token alive while active: renew on load and on tab focus (throttled). A lapsed
    // session flips the UI to logged-out instead of failing silently.
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

  // Ids of games the user has a build for — one id-only query on `builds`, so cards show the "built
  // this" badge without touching the shared cacheable game list. Refreshed on BUILD_POSTED_EVENT.
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

  const handleBlockedAuthorsUpdate = useCallback(() => {
    if (user) {
      pb
        .collection('users')
        .authRefresh({ expand: 'blocked_tags' })
        .catch((err) => {
          console.error('Failed to refresh user data after blocking authors:', err);
        });
    }
  }, [user]);

  const handleFilterModeChange = useCallback((newMode: FilterMode) => {
    if (newMode === 'sfw' || ageVerified) {
      analytics.filterToggle(newMode);
      setFilterMode(newMode);
      Cookies.set(FILTER_MODE_COOKIE, newMode, { expires: 365 });
    } else {
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
    setFilterMode('sfw');
    Cookies.set(FILTER_MODE_COOKIE, 'sfw', { expires: 365 });
  }, []);

  const isModerator = user?.isModerator || false;

  // Perms fetched once per moderator login. Deps hold only the id: the user reference changes on
  // every record update (see auth-user-identity-churn-trap).
  useEffect(() => {
    if (!signedIn || !isModerator) {
      setModPerms([]);
      return;
    }
    let alive = true;
    void fetchMyModPerms().then((res) => {
      if (alive) setModPerms(res.perms || []);
    });
    return () => {
      alive = false;
    };
  }, [signedIn, isModerator, user?.id]);

  const hasModPerm = useCallback(
    (key: string) => modPerms.includes(key) || modPerms.includes('*'),
    [modPerms],
  );

  return (
    <AuthContext.Provider
      value={{
        signedIn,
        user,
        isModerator,
        modPerms,
        hasModPerm,
        blockedTags,
        blockedGameIds,
        blockedAuthorIds,
      }}
    >
      <TagCategoryContext.Provider value={tagCategoryMap}>
      <MyBuiltGamesContext.Provider value={myBuiltGameIds}>
      <GlobalStyles styles={{ html: { overflowY: 'scroll' } }} />
      {/*
        Backend load-shedding 503 → one plain notice instead of a hung spinner
        (components/OverloadNotice.tsx).
      */}
      <OverloadNotice />
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          // iOS 100vh is the LARGE viewport (content slides under the toolbar); dvh tracks the live
          // one, 100vh is the fallback. Safe-area padding (viewport-fit=cover in index.html) keeps
          // content off the home indicator.
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
            // '1 0 auto', not 1: with an explicit minHeight a 0%-basis flex item stops growing with its
            // content (the automatic min size is gone), so main stayed one screen tall and the footer
            // was drawn over the feed.
            flex: chatFullBleed ? 1 : '1 0 auto',
            display: 'flex',
            flexDirection: 'column',
            // At least a screen tall: while a route chunk / first data loads, the footer then sits
            // below the fold instead of at the bottom of an empty viewport, jumping down when
            // content arrives (CLS ~0.17 on home and game pages).
            ...(chatFullBleed ? null : { minHeight: '100vh' }),
            // minHeight:0 — a flex child won't shrink below its content otherwise, and the feed
            // inside can't scroll.
            ...(chatFullBleed ? { minHeight: 0 } : null),
          }}
        >
          {/*
            Second error boundary inside the header: a failed route chunk only kills the content
            area.
          */}
          <AppErrorBoundary>
            <Suspense fallback={<PrepaintFallback />}>
              <Routes>
                <Route
                  path="/"
                  element={
                    <HomePage
                      selectedTags={selectedTags}
                      selectedAuthors={selectedAuthors}
                      filterMode={filterMode}
                      blockedTags={blockedTags}
                    />
                  }
                />
                {/*
                  The old catalog stays at /search: it hosts "Find Similar" (?similar=<id>), which
                  the new feed lacks, and old shared /search?tags=… links.
                */}
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
                <Route path="/feed-lab" element={<FeedLabRedirect />} />
                <Route path="/feed-lab2" element={<FeedLabRedirect />} />
                <Route path="/feed-lab3" element={<FeedLabRedirect />} />
                <Route path="/header-lab" element={<Navigate to="/" replace />} />
                <Route path="/header-lab/game/:id" element={<LabGameRedirect />} />
                <Route path="/game/:id" element={<GameDetails filterMode={filterMode} />} />
                <Route path="/cheat-lab" element={<CheatPage />} />
                <Route path="/shout-lab" element={<Navigate to="/" replace />} />
                {/*
                  Full-page chat. Header icon click (single/double per the singleClickFullChat
                  setting, ShoutboxButton.tsx). Noindex by author decision. ALL chat routes render
                  the SAME element object: with separate <ChatPage>s, "topic index → topic" was an
                  unmount/remount (feed reloaded, topics section lost on /chat/r/ — wiki/log.md
                  2026-09-15).
                */}
                <Route path="/chat" element={chatScreen} />
                <Route path="/chat/r/:slug" element={chatScreen} />
                <Route path="/chat/t/:slug" element={chatScreen} />
                <Route path="/chat/threads" element={chatScreen} />
                <Route path="/chat-rooms-lab" element={<Navigate to="/chat/threads" replace />} />
                {/*
                  Old lab URLs (/chat-lab: still used by old pushes and the PWA shortcut;
                  /chat-swipe-lab) redirect. /emoji-lab: emoji & reaction bench + pack moderation,
                  not linked from any menu.
                */}
                <Route path="/emoji-lab" element={<EmojiLab />} />
                <Route path="/chat-lab" element={<Navigate to="/chat" replace />} />
                <Route path="/chat-swipe-lab" element={<Navigate to="/chat" replace />} />

                <Route path="/log" element={<AnnouncementsLog />} />
                <Route path="/privacy-policy" element={<PrivacyPolicy />} />
                <Route path="/terms-of-service" element={<TermsOfService />} />
                <Route path="/hosting" element={<Hosting />} />
                <Route path="/roulette" element={<RoulettePage />} />
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
                        blockedAuthorIds={blockedAuthorIds}
                        onBlockedAuthorsUpdate={handleBlockedAuthorsUpdate}
                      />
                    </PrivateRoute>
                  }
                />
                <Route path="/verification" element={<VerificationPage />} />
                <Route path="/confirm-email" element={<ConfirmEmailPage />} />
                <Route
                  path="/moderator/review"
                  element={
                    <ModeratorRoute perm="review">
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
                    <ModeratorRoute perm="queue">
                      <PublicationQueuePanel />
                    </ModeratorRoute>
                  }
                />
                <Route path="/moderator/comments" element={<ModeratorRoute perm="comments"><CommentsModerationPanel /></ModeratorRoute>} />
                <Route
                  path="/moderator/tickets"
                  element={
                    <ModeratorRoute perm="tickets">
                      <ModRequestsPanel />
                    </ModeratorRoute>
                  }
                />
                <Route
                  path="/moderator/stats"
                  element={
                    <ModeratorRoute perm="stats">
                      <ViewStatsPanel />
                    </ModeratorRoute>
                  }
                />
                <Route
                  path="/moderator/access"
                  element={
                    <ModeratorRoute perm="perms">
                      <ModAccessPanel />
                    </ModeratorRoute>
                  }
                />
                <Route
                  path="/moderator/roulette"
                  element={
                    <ModeratorRoute perm="roulette">
                      <RoulettePanel />
                    </ModeratorRoute>
                  }
                />
                <Route
                  path="/moderator/screenshots"
                  element={
                    <ModeratorRoute>
                      <ScreenshotStudio />
                    </ModeratorRoute>
                  }
                />
                {/*
                  Unknown path (/en — language lives in ?lang=, old links, typos) → redirect home.
                  Bots get 404 + noindex from the server (knownAppPaths in seo.go), so no duplicate
                  of the home page gets indexed.
                */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AppErrorBoundary>
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

        <Dialog
          open={ageDialogOpen}
          // No onClose on purpose: a backdrop tap or Escape used to count as "I'm under 18". On
          // phones mis-taps are common; the age answer must be explicit (buttons only).
          disableEscapeKeyDown
          BackdropProps={{
            sx: {
              backdropFilter: 'blur(5px)',
              bgcolor: 'rgba(8, 8, 12, 0.52)',
            },
          }}
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
      </Box>
      </MyBuiltGamesContext.Provider>
      </TagCategoryContext.Provider>
    </AuthContext.Provider>
  );
}
