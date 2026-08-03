// src/components/Header/Header.tsx
//
// THE site header (all viewports): one row + a top search dropdown with live
// typeahead, tag/author filter chips and inline semantic search. Grew up on the
// hidden /header-lab preview as the mobile redesign; since 2026-07 it replaces the
// old desktop header everywhere, so in 2026-07-25 it took over the `Header` name
// (it was `MobileHeader.tsx`; the retired desktop pair — Header/UnifiedSearchBar/
// SearchBar/TagAuthorSelector — now lives in archive/site-frontend-header-legacy/).
// On desktop the row sits in a lg container and the search panel is a centered
// 640px dropdown; on phones both span the full width.
//
// What it reuses from the real app (no reinvented logic):
//   • AuthContext (signed-in / user / moderator)        — the app-wide auth provider
//   • FilterSwitch (SFW/ALL/NSFW)                        — identical component
//   • UserMenu + NotificationBell                        — real account menu & bell
//   • pbPublic catalog clients for typeahead             — anonymous, Cloudflare-cacheable
//   • /api/semantic-search                               — same endpoint as SemanticSearchPage
//   • real routes (/game/:id, /search?…, /create)        — react-router navigate
//
// ⚠️ CRITICAL — DO NOT REGRESS: tapping the magnifier must focus the field and pop
// the soft keyboard on iOS Safari (verified on a real iPhone). The proven recipe is:
// the overlay is ALWAYS mounted (never conditionally rendered / portaled), made
// visible by flipping `display` imperatively and forcing a reflow BEFORE `focus()`,
// and that focus() runs synchronously inside the tap handler. No MUI Modal/Dialog/
// Popover here (they mount-on-open and animate with transforms, which both break the
// keyboard on Android Chrome and the synchronous-focus requirement on iOS).

import React, {
  Suspense,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  AppBar,
  Toolbar,
  Box,
  Container,
  Typography,
  IconButton,
  InputBase,
  ButtonBase,
  CircularProgress,
  Tooltip,
  GlobalStyles,
  Menu,
  MenuItem,
  useTheme,
  useMediaQuery,
} from '@mui/material';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import SearchIcon from '@mui/icons-material/Search';
import AddIcon from '@mui/icons-material/Add';
import LoginIcon from '@mui/icons-material/Login';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import VideogameAssetIcon from '@mui/icons-material/VideogameAsset';
import ImageIcon from '@mui/icons-material/Image';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import PersonIcon from '@mui/icons-material/Person';
import MoreVertIcon from '@mui/icons-material/MoreVert';

import {
  AuthContext,
  gamesCollectionPublic,
  authorsCollectionPublic,
  tagsCollectionPublic,
  gameCanonicalKey,
} from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import FilterSwitch from './FilterSwitch';
import UserMenu from './UserMenu';
import NotificationBell from '../Notifications/NotificationBell';
import { SEARCH_FILTER_EVENT, type SearchFilterDetail, requestSearchHome } from '../../utils/searchTagBus';
import { getUsedTagIds } from '../../utils/tagUsage';
import { FORUM_URL, DISCORD_INVITE_URL } from './externalLinks';
import { thinScrollbar } from '../../styles/scrollbar';

// Site mini-chat (components/Shoutbox). Lazy so the drawer code stays out of the
// main bundle; the button renders null while the chunk loads AND whenever the
// server-side feature flag is off. Shown to everyone — anonymous posting is a
// feature, so it is deliberately OUTSIDE the signedIn conditional below.
const ShoutboxButton = lazy(() => import('../Shoutbox/ShoutboxButton'));

const SITE_TITLE = 'CYOA.CAFE';

// Which auth screen a deep link / redirect forces open. Lives here because App and
// Login both need it and the header owns the login entry point (it came over from the
// retired desktop Header.tsx, whose import paths this keeps working).
export type ForcedAuthMode = 'login' | 'register-email' | 'register-anon' | null;

interface HeaderProps {
  filterMode: FilterMode;
  onFilterModeChange: (newMode: FilterMode) => void;
  onLoginClick?: () => void;
}

// Minimal shapes — we only request id + label fields for typeahead.
// `img_or_link` is the catalog's format field ('img' = static image pages, 'link' =
// interactive iframe game) — the same vocabulary SearchPage's format filter uses.
type GameFormat = 'img' | 'link';
interface TitleHit { id: string; slug?: string; title: string; img_or_link?: GameFormat }
interface NameHit { id: string; name: string }
interface Suggestions { titles: TitleHit[]; authors: NameHit[]; tags: NameHit[] }
const EMPTY_SUGGESTIONS: Suggestions = { titles: [], authors: [], tags: [] };

// slug/img_or_link don't come from the semantic endpoint — they're filled in by a
// follow-up catalog lookup (see runSemantic).
interface SemanticHit { id: string; title: string; snippet?: string; slug?: string; img_or_link?: GameFormat }
interface SemanticState { loading: boolean; results: SemanticHit[]; failed: boolean }
const SEM_IDLE: SemanticState = { loading: false, results: [], failed: false };

// Strip characters that would break a PocketBase filter string literal.
const sanitize = (q: string) => q.replace(/["\\]/g, '');

// Suggestions are sourced live from the catalog (anonymous typeahead queries), so
// no tag/author lists need to be passed in.
const Header: React.FC<HeaderProps> = ({
  filterMode,
  onFilterModeChange,
  onLoginClick,
}) => {
  const theme = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const { signedIn, user } = useContext(AuthContext);
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isBelow400px = useMediaQuery('(max-width:399px)');

  const [searchOpen, setSearchOpen] = useState(false);
  // Filters collected as chips (by name). Tapping a game-page tag/author, or one in
  // the typeahead, adds it here; the "Search" button commits both to the catalog
  // (SearchPage reads ?tags=…&authors=…). Authors render as distinct chips.
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [authorFilters, setAuthorFilters] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState<Suggestions>(EMPTY_SUGGESTIONS);
  const [sem, setSem] = useState<SemanticState>(SEM_IDLE);
  // `true` once a semantic search ran — switches the results pane from typeahead
  // to semantic hits. Any keystroke flips it back to typeahead.
  const [semActive, setSemActive] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic request id — ignore responses that arrive after a newer query.
  const seqRef = useRef(0);
  // Timestamp of the last chip added from a page tap. The tap-outside-to-close handler
  // checks it: a tap that just added a tag/author must NOT also dismiss the search.
  const lastFilterAtRef = useRef(0);

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= 2;
  const hasFilters = tagFilters.length > 0 || authorFilters.length > 0;

  // ── open / close ──────────────────────────────────────────────────────────
  // Hardware back must close the panel, not leave the page (the Android reflex).
  // Opening the search pushes one same-URL history entry; the back press/gesture pops
  // it and we just dismiss. armedRef tracks whether that entry is still ours to
  // consume — every close path must settle it exactly once (see dismissSearch / the
  // popstate effect / go()), or back buttons start eating real entries.
  const historyArmedRef = useRef(false);
  const armHistory = useCallback(() => {
    if (historyArmedRef.current) return;
    try {
      window.history.pushState({ mhSearch: true }, '');
      historyArmedRef.current = true;
    } catch { /* Safari pushState rate limit — back will just navigate, no harm */ }
  }, []);

  // openSearch is the keyboard-critical path (see file header). Keep it synchronous.
  const openSearch = useCallback(() => {
    const ov = overlayRef.current;
    if (ov) {
      ov.style.animation = 'none'; // keyboard path: never animate (iOS transform recipe)
      ov.style.display = 'flex';   // make visible NOW (inline beats the sx class)
      void ov.offsetHeight;        // force layout so the field is truly rendered
    }
    inputRef.current?.focus({ preventScroll: true });
    setSearchOpen(true);
    armHistory();
  }, [armHistory]);

  // Top-variant: a game-page tag/author tap opens the real search dropdown with the
  // chips already inside — same overlay as the magnifier, just no keyboard forced (you
  // came to collect tags, not type). No focus() here, so it can animate freely (the iOS
  // synchronous-focus recipe only matters on the magnifier path above).
  const openSearchWithFilters = useCallback(() => {
    const ov = overlayRef.current;
    if (ov) {
      ov.style.display = 'flex';
      ov.style.animation = 'mhExpand 240ms ease-out';
      void ov.offsetHeight;
    }
    setSearchOpen(true);
    armHistory();
  }, [armHistory]);

  // Hide the search but REMEMBER everything — used by ← back, Esc and tap outside.
  // The panel just disappears; the typed query, suggestions, semantic results AND the
  // collected chips all survive, so reopening (magnifier or another page-tag tap)
  // restores exactly what you had. Mis-tapping the next tag therefore costs nothing.
  // The only thing that wipes state is resetSearch (on navigation).
  const dismissSearch = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.style.display = '';   // hand display back to sx
      overlayRef.current.style.animation = ''; // drop any expand animation
    }
    setSearchOpen(false);
    // UI-driven close (← / Esc / tap outside): consume the entry armHistory pushed,
    // otherwise the user's NEXT back press would be a dead click on this page.
    if (historyArmedRef.current) {
      historyArmedRef.current = false;
      window.history.back();
    }
  }, []);

  // Full reset incl. the chips + typed text — used after we navigate away (committed a
  // search or opened a game), where lingering state would bleed onto the next screen.
  const resetSearch = useCallback(() => {
    setTagFilters([]);
    setAuthorFilters([]);
    setQuery('');
    setSuggest(EMPTY_SUGGESTIONS);
    setSem(SEM_IDLE);
    setSemActive(false);
    seqRef.current++; // invalidate any in-flight responses
    dismissSearch();
  }, [dismissSearch]);

  const addTagFilter = useCallback((name: string) => {
    setTagFilters((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }, []);
  // Removing the LAST filter while nothing is typed collapses the whole panel — otherwise
  // it would linger half-open showing just an empty input row.
  const removeTagFilter = useCallback((name: string) => {
    const next = tagFilters.filter((t) => t !== name);
    setTagFilters(next);
    if (next.length === 0 && authorFilters.length === 0 && trimmed.length === 0) dismissSearch();
  }, [tagFilters, authorFilters, trimmed, dismissSearch]);
  const addAuthorFilter = useCallback((name: string) => {
    setAuthorFilters((prev) => (prev.includes(name) ? prev : [...prev, name]));
  }, []);
  const removeAuthorFilter = useCallback((name: string) => {
    const next = authorFilters.filter((a) => a !== name);
    setAuthorFilters(next);
    if (next.length === 0 && tagFilters.length === 0 && trimmed.length === 0) dismissSearch();
  }, [authorFilters, tagFilters, trimmed, dismissSearch]);

  // A game-page tag/author tap (window event) adds a chip and opens the search
  // dropdown with it inside (unified — the same overlay as the magnifier, no separate
  // widget). The dropdown is non-blocking, so you keep tapping more tags below it.
  useEffect(() => {
    const onAddFilter = (e: Event) => {
      const detail = (e as CustomEvent<SearchFilterDetail>).detail;
      if (!detail?.value) return;
      if (detail.kind === 'author') addAuthorFilter(detail.value);
      else addTagFilter(detail.value);
      lastFilterAtRef.current = Date.now(); // tell tap-outside this tap was a chip add
      if (!searchOpen) openSearchWithFilters();
    };
    window.addEventListener(SEARCH_FILTER_EVENT, onAddFilter);
    return () => window.removeEventListener(SEARCH_FILTER_EVENT, onAddFilter);
  }, [addTagFilter, addAuthorFilter, searchOpen, openSearchWithFilters]);

  // Tap outside the panel closes it (keeping the chips + text). Decided on the click, but
  // with one twist: tapping a chip or a suggestion removes that node from the DOM, so by
  // the time the click bubbles to document the target is detached and
  // `overlay.contains(target)` would read "outside" → the panel would vanish on every chip
  // removal / picked suggestion. So: if the target is no longer in the document at all, it
  // WAS inside (only the panel mutates itself mid-click) → keep open. Anything still in the
  // document and outside the panel is a genuine outside tap → close. A tap that just added
  // a chip from the page is excluded via the recent-filter timestamp, so stacking still
  // works. Using the click (not pointerdown) means page scrolling never closes it, and not
  // relying on a remembered pointerdown means a swallowed/synthetic tap can't get stuck.
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (e: MouseEvent) => {
      const ov = overlayRef.current;
      if (!ov) return;
      const t = e.target as Node;
      if (ov.contains(t)) return;                             // tapped inside the panel
      if (!document.contains(t)) return;                      // node detached mid-click → was inside
      if (Date.now() - lastFilterAtRef.current < 350) return; // a page tag/author tap (stacking)
      dismissSearch();
    };
    // listen on the next tick so the opening tap itself doesn't immediately close it
    const id = window.setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onClick);
    };
  }, [searchOpen, dismissSearch]);

  // Any real navigation closes the panel — keeps dismissal consistent if a link on the
  // page (visible behind the non-blocking dropdown) is tapped. The router has already
  // pushed the new page ON TOP of our search history entry, so calling history.back()
  // here would undo the user's navigation — disarm first and let the ghost entry stay
  // behind (one extra back press on that page, harmless and rare).
  useEffect(() => {
    if (searchOpen) {
      historyArmedRef.current = false;
      dismissSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Anchor the panel to the VISUAL viewport while open. `position:fixed; top:0` is laid
  // out against the layout viewport, whose top sits at the URL-bar-HIDDEN position on
  // mobile Chrome. So when you've scrolled down (URL bar hidden) and tap the magnifier,
  // focusing the field pops the keyboard AND makes Chrome slide its URL bar back in — and
  // that bar overlays our top:0 row, hiding the search field. Tracking visualViewport
  // offsetTop/height keeps the panel pinned to what's actually on screen, below the URL
  // bar and above the keyboard. Off the iOS focus path (reacts to vv events), so the
  // synchronous-focus recipe is untouched.
  useEffect(() => {
    const vv = window.visualViewport;
    // Desktop has no soft keyboard / retractable URL bar, so there is nothing to track —
    // and anchoring would pin `top:0`, clobbering a desktop variant's top offset. Only
    // the mobile sheet needs the visual-viewport dance.
    if (!searchOpen || !vv || !isMobile) return;
    const ov = overlayRef.current;
    const apply = () => {
      if (!ov) return;
      ov.style.top = `${vv.offsetTop}px`;
      ov.style.maxHeight = `${vv.height}px`;
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      if (ov) { ov.style.top = ''; ov.style.maxHeight = ''; }
    };
  }, [searchOpen, isMobile]);

  // NB: we deliberately DON'T lock background scroll. The search is a top dropdown, not
  // a full screen — the game page stays visible and scrollable below so you can hunt for
  // a tag/co-author further down the page and tap it into the search while it's open.

  // Esc closes (desktop / hardware keyboards).
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismissSearch(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, dismissSearch]);

  // Hardware back (Android button / iOS edge swipe) closes the panel. The press has
  // ALREADY popped the entry armHistory pushed, so disarm before dismissSearch — it
  // must not call history.back() again and eat a real entry. Same-URL pop means the
  // router just re-renders in place.
  useEffect(() => {
    if (!searchOpen) return;
    const onPop = () => {
      historyArmedRef.current = false;
      dismissSearch();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [searchOpen, dismissSearch]);

  // ── live typeahead (3 anonymous, cacheable list queries) ───────────────────
  // SFW/NSFW gate for the game-title suggestions — same semantics as SearchPage
  // (sfw: exclude nsfw/extreme-tagged games; nsfw: only those; all: no gate). The two
  // tag ids are fetched once, anonymously (Cloudflare-cacheable). `~` matching + a
  // client-side exact pick keeps it case-insensitive without pulling the full tag list.
  const [gateTags, setGateTags] = useState<{ nsfw: string | null; extreme: string | null } | null>(null);
  useEffect(() => {
    tagsCollectionPublic
      .getList(1, 10, { filter: 'name ~ "nsfw" || name ~ "extreme"', fields: 'id,name', skipTotal: true })
      .then((r) => {
        const items = r.items as unknown as NameHit[];
        const idOf = (n: string) => items.find((t) => t.name.toLowerCase() === n)?.id ?? null;
        setGateTags({ nsfw: idOf('nsfw'), extreme: idOf('extreme') });
      })
      .catch(() => setGateTags({ nsfw: null, extreme: null }));
  }, []);

  // Set id используемых тегов — чтобы не подсказывать пустые (0 игр) теги.
  const usedTagIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    getUsedTagIds().then((s) => { usedTagIdsRef.current = s; }).catch(() => {});
  }, []);

  const runSuggest = useCallback((raw: string) => {
    const q = sanitize(raw);
    const my = ++seqRef.current;
    const gameFilter = [`(title ~ "${q}" || aliases ~ "${q}")`];
    if (filterMode === 'sfw') {
      // Mirrors SearchPage: gate on the ids we know; a missing id adds no condition.
      if (gateTags?.nsfw) gameFilter.push(`tags.id != "${gateTags.nsfw}"`);
      if (gateTags?.extreme) gameFilter.push(`tags.id != "${gateTags.extreme}"`);
    } else if (filterMode === 'nsfw') {
      const or = [
        gateTags?.nsfw && `tags ~ "${gateTags.nsfw}"`,
        gateTags?.extreme && `tags ~ "${gateTags.extreme}"`,
      ].filter(Boolean).join(' || ');
      gameFilter.push(or ? `(${or})` : '1=0'); // ids unknown → nothing, not everything
    }
    Promise.all([
      gamesCollectionPublic.getList(1, 6, { filter: gameFilter.join(' && '), fields: 'id,slug,title,img_or_link', skipTotal: true }),
      authorsCollectionPublic.getList(1, 6, { filter: `(name ~ "${q}" || aliases ~ "${q}")`, fields: 'id,name', skipTotal: true }),
      tagsCollectionPublic.getList(1, 8, { filter: `(name ~ "${q}" || aliases ~ "${q}")`, fields: 'id,name', skipTotal: true }),
    ])
      .then(([g, a, t]) => {
        if (my !== seqRef.current) return; // stale
        const used = usedTagIdsRef.current;
        const tagHits = t.items as unknown as NameHit[];
        setSuggest({
          titles: g.items as unknown as TitleHit[],
          authors: a.items as unknown as NameHit[],
          tags: used.size ? tagHits.filter((th) => used.has(th.id)) : tagHits,
        });
      })
      .catch(() => { if (my === seqRef.current) setSuggest(EMPTY_SUGGESTIONS); });
  }, [filterMode, gateTags]);

  // Debounced typeahead on every query change (skips while semantic results show).
  useEffect(() => {
    if (semActive) return;
    if (trimmed.length < 2) { setSuggest(EMPTY_SUGGESTIONS); return; }
    const t = setTimeout(() => runSuggest(trimmed), 280);
    return () => clearTimeout(t);
  }, [trimmed, semActive, runSuggest]);

  // ── semantic search (same endpoint as SemanticSearchPage) ──────────────────
  const runSemantic = useCallback(() => {
    const q = inputRef.current?.value.trim() ?? trimmed;
    if (q.length < 2) return;
    const my = ++seqRef.current;
    setSemActive(true);
    setSem({ loading: true, results: [], failed: false });
    fetch(`/api/semantic-search?q=${encodeURIComponent(q)}&mode=mixed`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d) => {
        if (my !== seqRef.current) return;
        const hits = (d?.results ?? []) as SemanticHit[];
        setSem({ loading: false, results: hits, failed: false });
        // The semantic endpoint only knows id/title/snippet. One extra anonymous
        // (cacheable) catalog lookup adds the slug — for pretty /game/<slug> links —
        // and the format, for the static/interactive row icon. Best effort: on failure
        // the rows just keep record-id links and the neutral icon.
        if (!hits.length) return;
        const filter = hits.map((h) => `id="${sanitize(h.id)}"`).join(' || ');
        gamesCollectionPublic
          .getList(1, hits.length, { filter, fields: 'id,slug,img_or_link', skipTotal: true })
          .then((r) => {
            if (my !== seqRef.current) return;
            const meta = new Map((r.items as unknown as TitleHit[]).map((g) => [g.id, g]));
            setSem((prev) => ({
              ...prev,
              results: prev.results.map((h) => {
                const m = meta.get(h.id);
                return m ? { ...h, slug: m.slug, img_or_link: m.img_or_link } : h;
              }),
            }));
          })
          .catch(() => {});
      })
      .catch(() => { if (my === seqRef.current) setSem({ loading: false, results: [], failed: true }); });
  }, [trimmed]);

  // ── navigation helpers (close overlay, then go to the real route) ──────────
  // If the open search armed a history entry, navigate OVER it (replace) — otherwise
  // back from the destination would land on a ghost duplicate of this page. Disarm
  // before resetSearch so its dismissSearch doesn't also call history.back().
  const go = useCallback((to: string) => {
    const replace = historyArmedRef.current;
    historyArmedRef.current = false;
    resetSearch();
    navigate(to, { replace });
  }, [resetSearch, navigate]);

  // Logo = universal "home". Beyond navigating to "/" (which alone does nothing when
  // already there, and never resets SearchPage's internal tab/filter state), it wipes
  // the header search overlay, tells SearchPage to snap back to the default New feed,
  // and scrolls to the top. Modified clicks (new tab / middle-click) fall through to
  // the Link's href so open-in-new-tab still works.
  const handleLogoClick = useCallback((e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    resetSearch();
    requestSearchHome();
    navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [resetSearch, navigate]);

  // Commit the collected tag filters (and any typed text) to the catalog. SearchPage
  // reads ?tags=a,b,c and ?q=… from the URL (comma-joined names), so this is all the
  // wiring needed. Capture before go() since closeSearch() resets the state.
  const commitSearch = useCallback(() => {
    const params = new URLSearchParams();
    if (tagFilters.length) params.set('tags', tagFilters.join(','));
    if (authorFilters.length) params.set('authors', authorFilters.join(','));
    const q = trimmed;
    if (q) params.set('q', q);
    const qs = params.toString();
    if (!qs) return;
    go(`/search?${qs}`);
  }, [tagFilters, authorFilters, trimmed, go]);

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    if (semActive) { setSemActive(false); setSem(SEM_IDLE); } // back to typeahead on edit
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commitSearch(); // full catalog search over the collected tags + typed text
  };

  // ── render: top bar ────────────────────────────────────────────────────────
  const iconSize = isBelow400px ? '1.25rem' : '1.4rem';
  const btnPad = isBelow400px ? '6px' : '8px';

  // Guest ⋮ menu holds the external community links (signed-in users get the same
  // items inside UserMenu — guests have no avatar menu to put them under).
  const [guestMenuEl, setGuestMenuEl] = useState<null | HTMLElement>(null);

  // Desktop: the open search is a centred command-palette dropdown — top edge meeting
  // the header, fully rounded, framed by its own border + shadow. NON-blocking (no
  // backdrop), so the page stays bright and clickable and you can keep stacking tags
  // from the game page below it, exactly like the full-width mobile sheet. On phones
  // (isMobile) this is null → the base full-width sheet renders, keyboard recipe intact.
  const desktopPanelSx = !isMobile
    ? {
        top: '48px', left: 0, right: 0,
        width: 'min(620px, calc(100% - 32px))', maxWidth: 'unset', mx: 'auto',
        borderRadius: '16px', border: `1px solid ${theme.palette.divider}`,
        boxShadow: '0 24px 70px rgba(0,0,0,.65)', maxHeight: '80vh',
      }
    : null;

  return (
    <>
      <GlobalStyles
        styles={{
          '@keyframes mhExpand': {
            from: { opacity: 0, transform: 'translateY(-12px)' },
            to: { opacity: 1, transform: 'translateY(0)' },
          },
        }}
      />
      <AppBar position="sticky" sx={{ top: 0 }}>
        {/* Same lg container as the rest of the site, so on desktop the row's content
            aligns with the page instead of hugging the screen edges. */}
        <Container maxWidth="lg" disableGutters>
        <Toolbar
          disableGutters
          sx={{ display: 'flex', alignItems: 'center', px: 1, gap: 0.25, minHeight: 54 }}
        >
          <Typography
            component={Link}
            to="/"
            onClick={handleLogoClick}
            sx={{
              color: theme.palette.primary.main,
              textDecoration: 'none',
              fontWeight: 800,
              letterSpacing: '.5px',
              fontSize: isBelow400px ? '1rem' : '1.15rem',
              '&:hover': { color: theme.palette.primary.light },
              // last-resort shrink: protect the right-hand cluster from clipping
              flex: '0 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {SITE_TITLE}
          </Typography>

          <Box sx={{ flexGrow: 1 }} />

          <Box sx={{ flexShrink: 0 }}>
            <FilterSwitch
              filterMode={filterMode}
              onFilterModeChange={onFilterModeChange}
              isBelow400px={isBelow400px}
            />
          </Box>

          <Tooltip title="Search" arrow>
            <IconButton color="inherit" onClick={openSearch} aria-label="Open search" sx={{ p: btnPad }}>
              <SearchIcon sx={{ fontSize: iconSize }} />
            </IconButton>
          </Tooltip>

          {/* Add-game is public: the page shows creator resources to everyone and
              gates only the actions (SuggestLink / ManualCreate prompt login inside).
              Same rationale as the chat bubble below — guests are welcome in. */}
          <Tooltip title="Add or suggest a CYOA" arrow>
            <IconButton
              color="inherit"
              component={Link}
              to="/create"
              aria-label="Add CYOA"
              sx={{ p: btnPad }}
            >
              <AddIcon sx={{ fontSize: iconSize }} />
            </IconButton>
          </Tooltip>

          <Suspense fallback={null}>
            <ShoutboxButton iconFontSize={iconSize} padding={btnPad} />
          </Suspense>

          {signedIn ? (
            <>
              <NotificationBell iconFontSize={iconSize} padding={btnPad} />
              <UserMenu currentUser={user} isMobile={isMobile} isBelow400px={isBelow400px} />
            </>
          ) : (
            <>
              {/* aria-label "Login" (not "Log in") — matches the legacy header, which
                  E2E and muscle memory rely on. */}
              <Tooltip title="Log in" arrow>
                <IconButton color="inherit" onClick={onLoginClick} aria-label="Login" sx={{ p: btnPad }}>
                  <LoginIcon sx={{ fontSize: iconSize }} />
                </IconButton>
              </Tooltip>
              {/* External community links for guests (signed-in users have them in
                  UserMenu instead — no avatar menu to hang them under here). */}
              <IconButton
                color="inherit"
                onClick={(e) => setGuestMenuEl(e.currentTarget)}
                aria-label="More"
                sx={{ p: btnPad }}
              >
                <MoreVertIcon sx={{ fontSize: iconSize }} />
              </IconButton>
              <Menu
                anchorEl={guestMenuEl}
                open={Boolean(guestMenuEl)}
                onClose={() => setGuestMenuEl(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              >
                <MenuItem onClick={() => { setGuestMenuEl(null); navigate('/roulette'); }}>
                  🎲 Bump roulette
                </MenuItem>
                <MenuItem
                  component="a"
                  href={FORUM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setGuestMenuEl(null)}
                >
                  Forum ↗
                </MenuItem>
                <MenuItem
                  component="a"
                  href={DISCORD_INVITE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setGuestMenuEl(null)}
                >
                  Discord ↗
                </MenuItem>
              </Menu>
            </>
          )}
        </Toolbar>
        </Container>

      </AppBar>

      {/* ── search panel — ALWAYS mounted, display-toggled ──────────────────────
          A dropdown anchored to the top, NOT a full screen: it's only as tall as its
          content, so the game page stays visible AND tappable below it. That's the
          point — spot a co-author or tag in the open game and tap it straight into the
          search while the field is up. The results list only appears once there's
          something to show; an empty search is just the input row (no grey void). */}
      <Box
        ref={overlayRef}
        role="dialog"
        aria-label="Search"
        sx={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          // Desktop: a centered command-palette-style dropdown instead of a
          // full-width sheet. Centering via auto margins (left+right+maxWidth),
          // NOT transform — transforms on this node break the mobile keyboard
          // recipe (see file header).
          maxWidth: { xs: '100%', sm: 640 },
          mx: 'auto',
          zIndex: theme.zIndex.modal + 1,
          display: searchOpen ? 'flex' : 'none',
          flexDirection: 'column',
          maxHeight: '100dvh',
          overflow: 'hidden',
          bgcolor: 'background.paper',
          boxShadow: '0 10px 28px rgba(0,0,0,.55)',
          borderBottomLeftRadius: 16,
          borderBottomRightRadius: 16,
          ...(desktopPanelSx || {}),
        }}
      >
        {/* search row */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 0.5,
            py: 0.75,
            bgcolor: 'background.paper',
          }}
        >
          <IconButton color="inherit" onClick={dismissSearch} aria-label="Back" sx={{ flex: '0 0 auto' }}>
            <ArrowBackIcon />
          </IconButton>
          <InputBase
            inputRef={inputRef}
            value={query}
            onChange={onInput}
            onKeyDown={onEnter}
            fullWidth
            type="search"
            placeholder="Title, author or tag…"
            inputProps={{
              'aria-label': 'Search',
              enterKeyHint: 'search',
              autoCapitalize: 'none',
              autoCorrect: 'off',
              spellCheck: false,
            }}
            sx={{
              flex: 1,
              height: 42,
              px: 1.5,
              borderRadius: '9px',
              border: '1px solid #444',
              bgcolor: '#101010',
              color: 'text.primary',
              fontSize: '1rem',
              '&.Mui-focused': { borderColor: theme.palette.primary.main },
              // kill the native iOS blue clear button — we render our own
              '& input::-webkit-search-cancel-button, & input::-webkit-search-decoration': {
                WebkitAppearance: 'none',
                appearance: 'none',
                display: 'none',
              },
            }}
          />
          {query.length > 0 && (
            <IconButton
              aria-label="Clear"
              onClick={() => { setQuery(''); setSemActive(false); setSem(SEM_IDLE); inputRef.current?.focus(); }}
              sx={{ flex: '0 0 auto', color: 'text.secondary' }}
            >
              <CloseIcon sx={{ fontSize: 20 }} />
            </IconButton>
          )}
        </Box>

        {/* selected filter chips + commit CTA (built by tapping game-page tags/authors
            or items in the typeahead below) */}
        {hasFilters && (
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 0.75,
              px: 1.5,
              py: 1,
              bgcolor: 'background.paper',
              borderTop: `1px solid ${theme.palette.divider}`,
            }}
          >
            {authorFilters.map((a) => (
              <FilterChip key={`a-${a}`} label={a} kind="author" onRemove={() => removeAuthorFilter(a)} />
            ))}
            {tagFilters.map((t) => (
              <FilterChip key={`t-${t}`} label={t} kind="tag" onRemove={() => removeTagFilter(t)} />
            ))}
            <Box sx={{ ml: 'auto' }}>
              <CommitButton onClick={commitSearch} />
            </Box>
          </Box>
        )}

        {/* semantic CTA — one stateful button, kept on top so the keyboard never hides
            it. Before a run it triggers the inline Semantic search; once results are
            showing it morphs (icon + label) into a shortcut to the full Semantic Search
            page for the same query — so a second tap in the same spot opens the page
            rather than uselessly re-running an identical search. Editing the query flips
            semActive back to false (see onInput), returning it to the inline action.
            A FAILED run does NOT morph: the full page would almost certainly fail the
            same way, so the button stays "Semantic search" and the tap is a retry. */}
        {hasQuery && (
          <ButtonBase
            onClick={semActive && !sem.failed
              ? () => go(`/semantic-search?q=${encodeURIComponent(trimmed)}`)
              : runSemantic}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.1,
              width: '100%',
              px: 1.75,
              py: 1.1,
              justifyContent: 'flex-start',
              textAlign: 'left',
              bgcolor: '#1b1410',
              borderBottom: '1px solid #3a2a1c',
              '&:hover': { bgcolor: '#241a13' },
            }}
          >
            {semActive && !sem.failed ? (
              <TravelExploreIcon sx={{ color: 'primary.main', fontSize: 21, flex: '0 0 auto' }} />
            ) : (
              <AutoAwesomeIcon sx={{ color: 'primary.main', fontSize: 21, flex: '0 0 auto' }} />
            )}
            <Typography
              noWrap
              sx={{ flex: 1, minWidth: 0, fontSize: '.9rem', color: 'text.primary' }}
            >
              {semActive && !sem.failed ? (
                <>
                  <Box component="b" sx={{ fontWeight: 600 }}>Open in Semantic Search</Box>{' '}
                  <Box component="span" sx={{ color: 'primary.main' }}>“{trimmed}”</Box>
                </>
              ) : (
                <>
                  <Box component="b" sx={{ fontWeight: 600 }}>Semantic search</Box>{' '}
                  <Box component="span" sx={{ color: 'primary.main' }}>“{trimmed}”</Box>
                </>
              )}
            </Typography>
            <ChevronRightIcon sx={{ color: 'text.secondary', flex: '0 0 auto' }} />
          </ButtonBase>
        )}

        {/* results / suggestions — only present once you've typed, so an empty search
            never fills the screen. Scrolls within its own height; the page shows below. */}
        {hasQuery && (
          <Box
            sx={{
              maxHeight: '60vh',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
              borderTop: `1px solid ${theme.palette.divider}`,
              pb: 'env(safe-area-inset-bottom)',
              ...thinScrollbar,
            }}
          >
            {semActive ? (
              // The "open the full page" shortcut now lives in the stateful CTA above
              // (it morphs once results show), so the results list stays clean here.
              <SemanticResults state={sem} onPick={(id) => go(`/game/${id}`)} />
            ) : (
              <TypeaheadResults
                data={suggest}
                query={trimmed}
                onGame={(id) => go(`/game/${id}`)}
                onAuthor={(name) => { addAuthorFilter(name); setQuery(''); inputRef.current?.focus(); }}
                onTag={(name) => { addTagFilter(name); setQuery(''); inputRef.current?.focus(); }}
              />
            )}
          </Box>
        )}
      </Box>
    </>
  );
};

// ── results sub-views (kept small & local) ───────────────────────────────────

// A removable filter pill. Tags use the accent (amber) fill + "#name"; authors use a
// red fill + person icon, matching the red author name on the game page. The WHOLE chip
// is the remove target (far easier to hit on a phone than a tiny ✕); the ✕ stays only as
// an affordance so it still reads as "tap to remove".
const FilterChip: React.FC<{ label: string; kind: 'tag' | 'author'; onRemove?: () => void }> = ({
  label, kind, onRemove,
}) => {
  const isAuthor = kind === 'author';
  const chipSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.25,
    pl: isAuthor ? 0.7 : 1.1,
    pr: onRemove ? 0.8 : (isAuthor ? 1 : 1.3),
    py: 0.4,
    borderRadius: '99px',
    bgcolor: isAuthor ? '#ff5252' : 'primary.main',
    color: isAuthor ? '#fff' : '#000',
    fontSize: '.82rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
  } as const;
  const inner = (
    <>
      {isAuthor && <PersonIcon sx={{ fontSize: 15, ml: 0.3 }} />}
      {isAuthor ? label : `#${label}`}
      {onRemove && <CloseIcon sx={{ fontSize: 15, ml: 0.15, opacity: 0.7 }} />}
    </>
  );
  return onRemove ? (
    <ButtonBase
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      sx={{
        ...chipSx,
        '&:hover': { filter: 'brightness(0.92)' },
        '&:active': { filter: 'brightness(0.88)' },
      }}
    >
      {inner}
    </ButtonBase>
  ) : (
    <Box sx={chipSx}>{inner}</Box>
  );
};

// The commit-search action. A real, rectangular button (not a pill) so it never reads
// as another tag chip.
const CommitButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <ButtonBase
    onClick={onClick}
    aria-label="Search"
    sx={{
      flex: '0 0 auto',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 0.5,
      height: 40,
      px: 1.4,
      borderRadius: '8px',
      bgcolor: 'primary.main',
      color: '#000',
      fontSize: '.85rem',
      fontWeight: 700,
      boxShadow: '0 1px 3px rgba(0,0,0,.4)',
      '&:hover': { filter: 'brightness(1.08)' },
      '&:active': { filter: 'brightness(.9)' },
    }}
  >
    <SearchIcon sx={{ fontSize: 18 }} />
    {'Search'}
  </ButtonBase>
);

const GroupLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography
    sx={{
      px: 2, pt: 1.5, pb: 0.5, fontSize: '.68rem', letterSpacing: '.5px',
      textTransform: 'uppercase', color: 'text.secondary',
    }}
  >
    {children}
  </Typography>
);

// Rows that lead to a real route take `href` and render as a genuine <a>, so
// middle-click / ctrl+click / right-click → "Open in new tab" all work (a bare
// ButtonBase offers none of that). Plain left clicks are still intercepted for SPA
// navigation via onClick; modified and non-primary buttons fall through to the browser.
// Rows without href (author/tag suggestions) only mutate local filter state — nothing
// to link to.
const ROW_SX = {
  display: 'flex', alignItems: 'center', gap: 1.5, width: '100%',
  px: 2, py: 1.4, justifyContent: 'flex-start', textAlign: 'left',
  textDecoration: 'none',
  '&:hover': { bgcolor: 'rgba(255,255,255,.05)' },
  '&:active': { bgcolor: 'rgba(255,255,255,.07)' },
} as const;

// True when a click must stay in the SPA (plain primary-button click). NB: Chrome
// dispatches middle clicks as `auxclick`, so onClick usually doesn't even fire for
// them — the button check is belt and braces for browsers that do.
const isPlainClick = (e: React.MouseEvent) =>
  !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0;

const Row: React.FC<{
  icon: React.ReactNode; primary: string; trailing?: string; href?: string; onClick: () => void;
}> = ({ icon, primary, trailing, href, onClick }) => {
  const inner = (
    <>
      <Box sx={{ flex: '0 0 auto', color: 'text.secondary', display: 'flex' }}>{icon}</Box>
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '.95rem', color: 'text.primary' }}>
        {primary}
      </Typography>
      {trailing && (
        <Typography sx={{ flex: '0 0 auto', fontSize: '.72rem', color: 'text.secondary' }}>{trailing}</Typography>
      )}
    </>
  );
  if (!href) return <ButtonBase onClick={onClick} sx={ROW_SX}>{inner}</ButtonBase>;
  return (
    <ButtonBase
      component="a"
      href={href}
      onClick={(e: React.MouseEvent) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onClick();
      }}
      sx={ROW_SX}
    >
      {inner}
    </ButtonBase>
  );
};

// Format badge for a game row. Deliberately the SAME icons as SearchPage's
// all/static/interactive format filter (ImageIcon / TouchAppIcon), so a suggestion
// reads like the toggle you'd flip to filter for it. Unknown format (e.g. a semantic
// hit whose catalog lookup failed) keeps the neutral controller icon.
const formatIcon = (fmt?: GameFormat) => {
  if (fmt === 'img') return <ImageIcon sx={{ fontSize: 20 }} />;
  if (fmt === 'link') return <TouchAppIcon sx={{ fontSize: 20 }} />;
  return <VideogameAssetIcon sx={{ fontSize: 20 }} />;
};
const formatLabel = (fmt?: GameFormat) =>
  fmt === 'img' ? 'static' : fmt === 'link' ? 'interactive' : 'game';

const EmptyNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography sx={{ p: 3, textAlign: 'center', color: 'text.secondary', fontSize: '.85rem' }}>
    {children}
  </Typography>
);

const TypeaheadResults: React.FC<{
  data: Suggestions;
  query: string;
  onGame: (id: string) => void;
  onAuthor: (name: string) => void;
  onTag: (name: string) => void;
}> = ({ data, query, onGame, onAuthor, onTag }) => {
  const any = data.titles.length || data.authors.length || data.tags.length;
  if (!any) {
    return <EmptyNote>No matches for “{query}”. Try Semantic search ↑</EmptyNote>;
  }
  return (
    <>
      {data.titles.length > 0 && <GroupLabel>Titles</GroupLabel>}
      {data.titles.map((g) => (
        <Row
          key={g.id}
          icon={formatIcon(g.img_or_link)}
          primary={g.title}
          trailing={formatLabel(g.img_or_link)}
          href={`/game/${gameCanonicalKey(g)}`}
          onClick={() => onGame(gameCanonicalKey(g))}
        />
      ))}

      {data.authors.length > 0 && <GroupLabel>Authors</GroupLabel>}
      {data.authors.map((a) => (
        <Row
          key={a.id}
          icon={<PersonIcon sx={{ fontSize: 20 }} />}
          primary={a.name}
          trailing="author"
          onClick={() => onAuthor(a.name)}
        />
      ))}

      {data.tags.length > 0 && <GroupLabel>Tags</GroupLabel>}
      {data.tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, px: 2, py: 1 }}>
          {data.tags.map((t) => (
            <ButtonBase
              key={t.id}
              onClick={() => onTag(t.name)}
              sx={{
                fontSize: '.82rem', px: 1.6, py: 0.9, borderRadius: '99px',
                bgcolor: '#232323', border: '1px solid #333', color: 'text.primary',
                '&:hover': { bgcolor: '#2a2a2a' },
                '&:active': { bgcolor: '#2e2e2e' },
              }}
            >
              #{t.name}
            </ButtonBase>
          ))}
        </Box>
      )}
    </>
  );
};

const SemanticResults: React.FC<{ state: SemanticState; onPick: (id: string) => void }> = ({ state, onPick }) => {
  if (state.loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={26} />
      </Box>
    );
  }
  if (state.failed) return <EmptyNote>Semantic search is unavailable right now.</EmptyNote>;
  if (!state.results.length) return <EmptyNote>Nothing close in meaning.</EmptyNote>;
  return (
    <>
      <GroupLabel>Semantic · {state.results.length}</GroupLabel>
      {state.results.map((r) => {
        const key = gameCanonicalKey(r);
        return (
          <ButtonBase
            key={r.id}
            component="a"
            href={`/game/${key}`}
            onClick={(e: React.MouseEvent) => {
              if (!isPlainClick(e)) return; // let the browser open the link (new tab etc.)
              e.preventDefault();
              onPick(key);
            }}
            sx={{
              display: 'flex', alignItems: 'flex-start', gap: 1.5, width: '100%',
              px: 2, py: 1.4, justifyContent: 'flex-start', textAlign: 'left',
              textDecoration: 'none',
              '&:hover': { bgcolor: 'rgba(255,255,255,.05)' },
              '&:active': { bgcolor: 'rgba(255,255,255,.07)' },
            }}
          >
            {/* format icon (static/interactive), kept in the semantic accent colour */}
            <Box sx={{ color: 'primary.main', flex: '0 0 auto', mt: 0.25, display: 'flex' }}>
              {formatIcon(r.img_or_link)}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: '.95rem', color: 'text.primary' }}>{r.title}</Typography>
              {r.snippet && (
                <Typography noWrap sx={{ fontSize: '.73rem', color: 'text.secondary', mt: 0.25 }}>
                  {r.snippet}
                </Typography>
              )}
            </Box>
          </ButtonBase>
        );
      })}
    </>
  );
};

export default Header;
