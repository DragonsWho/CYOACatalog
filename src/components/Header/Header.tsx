// THE site header (all viewports): one row + a top search dropdown with live typeahead, tag/author
// filter chips and inline semantic search. Grew up on the hidden /header-lab preview; since 2026-07
// it replaces the old desktop header everywhere (renamed from MobileHeader.tsx on 2026-07-25; the
// retired desktop Header/UnifiedSearchBar/SearchBar/TagAuthorSelector live in
// archive/site-frontend-header-legacy/). Desktop: row in an lg container, search is a centered
// 640px dropdown; phones: both full width.
// Reuses: AuthContext, FilterSwitch (SFW/ALL/NSFW), UserMenu + NotificationBell, pbPublic anonymous
// Cloudflare-cacheable typeahead, /api/semantic-search, real routes via navigate.
// ⚠️ CRITICAL — DO NOT REGRESS: tapping the magnifier must focus the field and pop the soft
// keyboard on iOS Safari (verified on a real iPhone). Recipe: the overlay is ALWAYS mounted (never
// conditionally rendered/portaled), made visible by flipping `display` imperatively and forcing a
// reflow BEFORE `focus()`, and focus() runs synchronously inside the tap handler. No MUI
// Modal/Dialog/Popover here (mount-on-open + transform animations break the keyboard on Android
// Chrome and the synchronous-focus requirement on iOS).

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
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
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
import { SEARCH_FILTER_EVENT, SEARCH_OPEN_EVENT, type SearchFilterDetail, requestSearchHome } from '../../utils/searchTagBus';
import { getUsedTagIds } from '../../utils/tagUsage';
import { getRatingTagIds } from '../../utils/ratingTags';
import { inlineRatingTagIds } from '../../utils/tagDictionary';
import { FORUM_URL } from './externalLinks';
import { thinScrollbar } from '../../styles/scrollbar';

// Site mini-chat (Shoutbox), lazy so the drawer stays out of the main bundle; renders null while
// loading and when the server feature flag is off. Shown to everyone — anonymous posting is a
// feature, so deliberately OUTSIDE the signedIn conditional.
const ShoutboxButton = lazy(() => import('../Shoutbox/ShoutboxButton'));
// Same localStorage flag ShoutboxButton renders from (ENABLED_KEY there).
function chatFlagCached(): boolean {
  try { return localStorage.getItem('shoutbox_enabled') === '1'; } catch { return false; }
}

const SITE_TITLE = 'CYOA.CAFE';

// Which auth screen a deep link/redirect forces open. Lives here because App and Login both need it
// and the header owns the login entry point (import paths from the retired desktop Header.tsx keep
// working).
export type ForcedAuthMode = 'login' | 'register-email' | 'register-anon' | null;

interface HeaderProps {
  filterMode: FilterMode;
  onFilterModeChange: (newMode: FilterMode) => void;
  onLoginClick?: () => void;
}

// Minimal shapes: id + label fields for typeahead. `img_or_link`: 'img' = static image pages,
// 'link' = interactive iframe game (same vocabulary as SearchPage's format filter).
type GameFormat = 'img' | 'link';
interface TitleHit { id: string; slug?: string; title: string; img_or_link?: GameFormat }
interface NameHit { id: string; name: string }
interface Suggestions { titles: TitleHit[]; authors: NameHit[]; tags: NameHit[] }
const EMPTY_SUGGESTIONS: Suggestions = { titles: [], authors: [], tags: [] };

// slug/img_or_link aren't in the semantic response — filled by a follow-up catalog lookup
// (runSemantic).
interface SemanticHit { id: string; title: string; snippet?: string; slug?: string; img_or_link?: GameFormat }
interface SemanticState { loading: boolean; results: SemanticHit[]; failed: boolean }
const SEM_IDLE: SemanticState = { loading: false, results: [], failed: false };

// Strip characters that would break a PocketBase filter string literal.
const sanitize = (q: string) => q.replace(/["\\]/g, '');

const Header: React.FC<HeaderProps> = ({
  filterMode,
  onFilterModeChange,
  onLoginClick,
}) => {
  const theme = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  // On the home page (the catalog) the sheet narrows THAT feed rather than navigating to a results
  // page: it commits filters into the current URL, not /search (and pulls them from there on open).
  // The result-mode row no longer lives in the sheet — it's on the page.
  const feedRoute = location.pathname === '/';
  const { signedIn, user } = useContext(AuthContext);
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const isBelow400px = useMediaQuery('(max-width:399px)');

  const [searchOpen, setSearchOpen] = useState(false);
  // Filters collected as chips (by name). A game-page tag/author tap or a typeahead pick adds one;
  // "Search" commits them (SearchPage reads ?tags=…&authors=…).
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [authorFilters, setAuthorFilters] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [suggest, setSuggest] = useState<Suggestions>(EMPTY_SUGGESTIONS);
  const [sem, setSem] = useState<SemanticState>(SEM_IDLE);
  // `true` once a semantic search ran — switches results from typeahead to semantic hits; any
  // keystroke flips back.
  const [semActive, setSemActive] = useState(false);

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Monotonic request id — ignore responses older than the newest query.
  const seqRef = useRef(0);
  // Timestamp of the last chip added from a page tap: the tap-outside handler must NOT dismiss the
  // search for that same tap.
  const lastFilterAtRef = useRef(0);

  const trimmed = query.trim();
  // "-tag" = exclusion filter (same convention as the feed fields). On phones the header sheet is
  // the ONLY search surface, so the minus must work here — otherwise "-15min" went to TITLE search
  // and results emptied. While a minus is typed only tags are suggested.
  const negMode = trimmed.startsWith('-');
  const needle = negMode ? trimmed.slice(1).trim() : trimmed;
  const hasQuery = needle.length >= 2;
  const hasFilters = tagFilters.length > 0 || authorFilters.length > 0;

  // Hardware back must close the panel, not leave the page (Android reflex). Opening pushes one
  // same-URL history entry; back pops it and we dismiss. armedRef tracks whether that entry is
  // still ours — every close path must settle it exactly once (dismissSearch / popstate effect /
  // go()), or back starts eating real entries.
  const historyArmedRef = useRef(false);
  // URL at open time. The catalog settings row edits params via replace, which overwrites exactly
  // the blank entry we pushed; consuming it afterwards would make Esc call history.back() and drag
  // the user off the settings they just chose (how the selected sort got lost).
  const searchAtOpenRef = useRef('');
  const armHistory = useCallback(() => {
    if (historyArmedRef.current) return;
    try {
      searchAtOpenRef.current = window.location.search;
      window.history.pushState({ mhSearch: true }, '');
      historyArmedRef.current = true;
    } catch { }  // Safari pushState rate limit — back will just navigate, no harm
  }, []);

  // openSearch is the keyboard-critical path (see file header). Keep it synchronous.
  const openSearch = useCallback(() => {
    const ov = overlayRef.current;
    if (ov) {
      ov.style.animation = 'none';  // keyboard path: never animate (iOS transform recipe)
      ov.style.display = 'flex';  // make visible NOW (inline beats the sx class)
      void ov.offsetHeight;  // force layout so the field is truly rendered
    }
    inputRef.current?.focus({ preventScroll: true });
    setSearchOpen(true);
    armHistory();
  }, [armHistory]);

  // A game-page tag/author tap opens the same dropdown with chips inside, but no keyboard (you came
  // to collect tags). No focus() here, so it may animate (the sync-focus recipe matters only on the
  // magnifier path).
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

  // On the catalog page the sheet must open with the CURRENT feed state (it's the only place
  // showing how the feed is narrowed). Pull once on open, not on every URL change, or the settings
  // row (which edits the URL) would overwrite typing.
  useEffect(() => {
    if (!feedRoute || !searchOpen) return;
    const sp = new URLSearchParams(location.search);
    const split = (v: string | null) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
    setTagFilters(split(sp.get('tags')));
    setAuthorFilters(split(sp.get('authors')));
    setQuery(sp.get('q') || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRoute, searchOpen]);

  // Feed settings edited the URL from the open sheet, so our history entry was overwritten: disarm
  // — closing just closes, no back().
  useEffect(() => {
    if (searchOpen && location.search !== searchAtOpenRef.current) {
      historyArmedRef.current = false;
    }
  }, [searchOpen, location.search]);

  // The catalog page asks to open the sheet (phones have no own controls there).
  useEffect(() => {
    const onOpen = () => openSearchWithFilters();
    window.addEventListener(SEARCH_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SEARCH_OPEN_EVENT, onOpen);
  }, [openSearchWithFilters]);

  // Hide the search but REMEMBER everything (← back, Esc, tap outside): query, suggestions,
  // semantic results and chips survive, so reopening restores them; a mis-tap costs nothing. Only
  // resetSearch (on navigation) wipes state.
  const dismissSearch = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.style.display = '';  // hand display back to sx
      overlayRef.current.style.animation = '';  // drop any expand animation
    }
    setSearchOpen(false);
    // UI-driven close: consume the entry armHistory pushed, or the user's NEXT back press would be
    // a dead click.
    if (historyArmedRef.current) {
      historyArmedRef.current = false;
      window.history.back();
    }
  }, []);

  // Full reset (chips + text) after navigating away, or state bleeds onto the next screen.
  const resetSearch = useCallback(() => {
    setTagFilters([]);
    setAuthorFilters([]);
    setQuery('');
    setSuggest(EMPTY_SUGGESTIONS);
    setSem(SEM_IDLE);
    setSemActive(false);
    seqRef.current++;  // invalidate any in-flight responses
    dismissSearch();
  }, [dismissSearch]);

  // A tag and its negation are one condition with different sign: the new sign replaces the old
  // ("#RPG" + "-RPG" = empty feed).
  const addTagFilter = useCallback((name: string) => {
    setTagFilters((prev) => {
      const bare = name.startsWith('-') ? name.slice(1) : name;
      const rest = prev.filter((t) => t !== bare && t !== `-${bare}`);
      return [...rest, name];
    });
  }, []);
  // Removing the LAST filter with nothing typed collapses the panel (no half-open empty input row).
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

  // Game-page tag/author tap (window event) adds a chip and opens the dropdown with it.
  // Non-blocking, so you can keep tapping tags below.
  useEffect(() => {
    const onAddFilter = (e: Event) => {
      const detail = (e as CustomEvent<SearchFilterDetail>).detail;
      if (!detail?.value) return;
      if (detail.kind === 'author') addAuthorFilter(detail.value);
      else addTagFilter(detail.value);
      lastFilterAtRef.current = Date.now();  // tell tap-outside this tap was a chip add
      if (!searchOpen) openSearchWithFilters();
    };
    window.addEventListener(SEARCH_FILTER_EVENT, onAddFilter);
    return () => window.removeEventListener(SEARCH_FILTER_EVENT, onAddFilter);
  }, [addTagFilter, addAuthorFilter, searchOpen, openSearchWithFilters]);

  // Tap outside closes (keeping chips + text), decided on click with a twist: tapping a
  // chip/suggestion removes that node, so when the click reaches document the target is detached
  // and `overlay.contains(target)` reads "outside" → the panel vanished on every chip removal.
  // Rule: target no longer in the document ⇒ it WAS inside (only the panel mutates itself
  // mid-click) → keep open; still in the document and outside ⇒ close. A chip-adding page tap is
  // excluded via the timestamp. Using click (not pointerdown): page scrolling never closes it and a
  // swallowed/synthetic tap can't get stuck.
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (e: MouseEvent) => {
      const ov = overlayRef.current;
      if (!ov) return;
      const t = e.target as Node;
      if (ov.contains(t)) return;  // tapped inside the panel
      if (!document.contains(t)) return;  // node detached mid-click → was inside
      if (Date.now() - lastFilterAtRef.current < 350) return;  // a page tag/author tap (stacking)
      dismissSearch();
    };
    // Listen from the next tick so the opening tap doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('click', onClick);
    };
  }, [searchOpen, dismissSearch]);

  // Real navigation closes the panel. The router already pushed the new page ON TOP of our history
  // entry, so history.back() would undo the navigation — disarm first and leave the ghost entry
  // (one extra back press, harmless and rare).
  useEffect(() => {
    if (searchOpen) {
      historyArmedRef.current = false;
      dismissSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Anchor the panel to the VISUAL viewport while open. `position:fixed; top:0` uses the layout
  // viewport, whose top sits at the URL-bar-HIDDEN position on mobile Chrome; after scrolling down,
  // focusing the field pops the keyboard AND slides the URL bar back over our top:0 row, hiding the
  // field. Tracking visualViewport offsetTop/height keeps it on screen. Reacts to vv events, off
  // the iOS focus path.
  useEffect(() => {
    const vv = window.visualViewport;
    // Desktop has no soft keyboard/retractable URL bar; anchoring would pin top:0 and clobber the
    // desktop top offset. Mobile sheet only.
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

  // Background scroll deliberately NOT locked: the search is a top dropdown; the game page stays
  // scrollable so you can find and tap more tags/authors below.
  useEffect(() => {
    if (!searchOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismissSearch(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen, dismissSearch]);

  // Hardware back closes the panel. The press ALREADY popped our entry, so disarm before
  // dismissSearch — it must not call history.back() again and eat a real entry.
  useEffect(() => {
    if (!searchOpen) return;
    const onPop = () => {
      historyArmedRef.current = false;
      dismissSearch();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [searchOpen, dismissSearch]);

  // Live typeahead (3 anonymous cacheable queries). SFW/NSFW gate for title suggestions like
  // SearchPage (sfw: exclude nsfw/extreme-tagged; nsfw: only those; all: none). The two tag ids
  // come inlined in the HTML (utils/tagDictionary), else one cached lookup.
  const [gateTags, setGateTags] = useState<{ nsfw: string | null; extreme: string | null } | null>(
    () => inlineRatingTagIds(),
  );
  useEffect(() => {
    if (gateTags) return;
    getRatingTagIds().then(setGateTags);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ids of used tags — don't suggest empty (0-game) tags.
  const usedTagIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    getUsedTagIds().then((s) => { usedTagIdsRef.current = s; }).catch(() => {});
  }, []);

  const runSuggest = useCallback((raw: string, tagsOnly = false) => {
    const q = sanitize(raw);
    const my = ++seqRef.current;
    const gameFilter = [`(title ~ "${q}" || aliases ~ "${q}")`];
    if (filterMode === 'sfw') {
      // Mirrors SearchPage: gate on known ids; a missing id adds no condition.
      if (gateTags?.nsfw) gameFilter.push(`tags.id != "${gateTags.nsfw}"`);
      if (gateTags?.extreme) gameFilter.push(`tags.id != "${gateTags.extreme}"`);
    } else if (filterMode === 'nsfw') {
      const or = [
        gateTags?.nsfw && `tags ~ "${gateTags.nsfw}"`,
        gateTags?.extreme && `tags ~ "${gateTags.extreme}"`,
      ].filter(Boolean).join(' || ');
      gameFilter.push(or ? `(${or})` : '1=0');  // ids unknown → nothing, not everything
    }
    const EMPTY_LIST = Promise.resolve({ items: [] as unknown[] });
    Promise.all([
      tagsOnly ? EMPTY_LIST : gamesCollectionPublic.getList(1, 6, { filter: gameFilter.join(' && '), fields: 'id,slug,title,img_or_link', skipTotal: true }),
      tagsOnly ? EMPTY_LIST : authorsCollectionPublic.getList(1, 6, { filter: `(name ~ "${q}" || aliases ~ "${q}")`, fields: 'id,name', skipTotal: true }),
      tagsCollectionPublic.getList(1, 8, { filter: `(name ~ "${q}" || aliases ~ "${q}")`, fields: 'id,name', skipTotal: true }),
    ])
      .then(([g, a, t]) => {
        if (my !== seqRef.current) return;
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

  useEffect(() => {
    if (semActive) return;
    if (needle.length < 2) { setSuggest(EMPTY_SUGGESTIONS); return; }
    const t = setTimeout(() => runSuggest(needle, negMode), 280);
    return () => clearTimeout(t);
  }, [needle, negMode, semActive, runSuggest]);

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
        // The semantic endpoint only knows id/title/snippet. One extra anonymous cacheable lookup
        // adds slug (pretty links) and format (row icon). Best effort: on failure rows keep
        // record-id links and the neutral icon.
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

  // If the search armed a history entry, navigate OVER it (replace), or back from the destination
  // lands on a ghost duplicate. Disarm before resetSearch so dismissSearch doesn't also call
  // history.back().
  const go = useCallback((to: string) => {
    const replace = historyArmedRef.current;
    historyArmedRef.current = false;
    resetSearch();
    navigate(to, { replace });
  }, [resetSearch, navigate]);

  // Logo = universal home: navigating to "/" alone does nothing when already there and never resets
  // SearchPage state, so it also wipes the search overlay, tells the feed to snap back to default
  // and scrolls to top. Modified clicks fall through to the Link href (open in new tab works).
  const handleLogoClick = useCallback((e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    resetSearch();
    requestSearchHome();
    navigate('/');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [resetSearch, navigate]);

  // Commit collected tag filters (and typed text) to the catalog via ?tags=a,b,c&q=…. Capture
  // before go(): closeSearch() resets state.
  const commitSearch = useCallback(() => {
    const params = new URLSearchParams();
    if (tagFilters.length) params.set('tags', tagFilters.join(','));
    if (authorFilters.length) params.set('authors', authorFilters.join(','));
    // "-tag" is a filter, not a title: never goes into ?q=.
    const q = negMode ? '' : trimmed;
    if (q) params.set('q', q);
    const qs = params.toString();
    if (!qs) return;
    // On the new catalog page there's nowhere to go — it is the result. Its own settings (order,
    // period, format, likes) live in the URL and must survive: merge filters into current params,
    // don't replace the query string.
    if (feedRoute) {
      const next = new URLSearchParams(location.search);
      ['tags', 'authors', 'q'].forEach((k) => next.delete(k));
      params.forEach((v, k) => next.set(k, v));
      go(`/?${next.toString()}`);
      return;
    }
    // Search from anywhere lands on the catalog feed, not old /search: otherwise searching from a
    // game page gave a different screen than from home.
    go(`/?${qs}`);
  }, [tagFilters, authorFilters, trimmed, negMode, go, feedRoute, location.search]);

  const onInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    if (semActive) { setSemActive(false); setSem(SEM_IDLE); }  // back to typeahead on edit
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // "-something" + Enter adds an exclusion chip (exact name match, else first suggestion);
    // nothing found → do nothing (title search for "-…" is meaningless).
    if (negMode) {
      const low = needle.toLowerCase();
      const hit = suggest.tags.find((t) => t.name.toLowerCase() === low) ?? suggest.tags[0];
      if (hit) {
        addTagFilter(`-${hit.name}`);
        setQuery('');
        inputRef.current?.focus();
      }
      return;
    }
    commitSearch();  // full catalog search over the collected tags + typed text
  };

  const iconSize = isBelow400px ? '1.25rem' : '1.4rem';
  const btnPad = isBelow400px ? '6px' : '8px';

  // Guest ⋮ menu holds external community links (signed-in users have them in UserMenu).
  const [guestMenuEl, setGuestMenuEl] = useState<null | HTMLElement>(null);

  // Desktop: centered command-palette dropdown meeting the header, own border + shadow,
  // NON-blocking (no backdrop) so the page stays clickable for stacking tags. On phones null →
  // full-width base sheet, keyboard recipe intact.
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
        <Container maxWidth="lg" disableGutters>
        <Toolbar
          disableGutters
          sx={{ display: 'flex', alignItems: 'center', pl: 1.75, pr: 1, gap: 0.25, minHeight: 54 }}
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
              // Fluid title width: the right cluster is fixed-width; the title takes what's left
              // and never clips into "CYOA.CA…".
              fontSize: 'clamp(0.95rem, 4.2vw, 1.35rem)',
              '&:hover': { color: theme.palette.primary.light },
              // Last-resort shrink: protect the right-hand cluster from clipping.
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

          {/*
            Add-game is public: the page shows creator resources to everyone and gates only actions
            (SuggestLink / ManualCreate prompt login inside).
          */}
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

          {/*
            Fallback: an inert copy of the chat button while its chunk loads, when the cached feature
            flag says it will show — otherwise the icon popped out and back in after the pre-paint.
          */}
          <Suspense
            fallback={chatFlagCached() ? (
              <IconButton color="inherit" disabled aria-hidden="true" sx={{ p: btnPad, '&.Mui-disabled': { color: 'inherit' } }}>
                <ChatBubbleOutlineIcon sx={{ fontSize: iconSize }} />
              </IconButton>
            ) : null}
          >
            {/*
              Chat: single vs double click do different things per singleClickFullChat (default:
              single = /chat page); right-to-left swipe opens the quick drawer from any page unless
              narrowed/disabled by swipeOpenMode. Both handled in ShoutboxButton.
            */}
            <ShoutboxButton iconFontSize={iconSize} padding={btnPad} rating={filterMode} />
          </Suspense>

          {signedIn ? (
            <>
              <NotificationBell iconFontSize={iconSize} padding={btnPad} />
              <UserMenu currentUser={user} isMobile={isMobile} isBelow400px={isBelow400px} />
            </>
          ) : (
            <>
              {/* aria-label "Login" (not "Log in") — E2E tests and muscle memory rely on it. */}
              <Tooltip title="Log in" arrow>
                <IconButton color="inherit" onClick={onLoginClick} aria-label="Login" sx={{ p: btnPad }}>
                  <LoginIcon sx={{ fontSize: iconSize }} />
                </IconButton>
              </Tooltip>
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
              </Menu>
            </>
          )}
        </Toolbar>
        </Container>

      </AppBar>

      {/*
        Search panel — ALWAYS mounted, display-toggled. A top dropdown, NOT full screen: only as
        tall as its content, so the game page stays visible and tappable (spot a tag/co-author and
        tap it in). Results appear only when there's something to show.
      */}
      <Box
        ref={overlayRef}
        role="dialog"
        aria-label="Search"
        sx={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          // Desktop centering via auto margins (left+right+maxWidth), NOT transform — transforms on
          // this node break the mobile keyboard recipe.
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
              // Digits in the field must be regular lining figures: on some phones "-15min"
              // rendered "15" at half size in the upper half (the engine picked the font's superior
              // digits). Font set explicitly and all digit variants except lining disabled.
              '& input': {
                fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
                fontSize: '1rem',
                lineHeight: 1.4,
                fontVariantNumeric: 'lining-nums tabular-nums',
                fontVariantPosition: 'normal',
                fontFeatureSettings: '"lnum" 1, "sups" 0, "subs" 0, "onum" 0, "numr" 0, "dnom" 0',
                textTransform: 'none',
                fontSynthesis: 'none',
              },
              // Kill the native iOS blue clear button — we render our own.
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

        {/*
          The catalog result-settings row is NO LONGER here (removed 2026-09-16): the catalog page
          shows search + mode row itself on every screen (HomePage `!panelVisible` block). The
          sheet is search-only everywhere (on game pages feed settings did nothing; on desktop home
          it duplicated the page panel).
        */}
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

        {/*
          Semantic CTA — one stateful button on top so the keyboard never hides it. Before a run it
          triggers inline semantic search; with results it morphs into a shortcut to the full
          Semantic Search page (a second tap opens the page instead of re-running the same search).
          Editing the query flips it back. A FAILED run doesn't morph (the page would fail the same
          way); the tap is a retry.
        */}
        {hasQuery && !negMode && (
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

        {/* Results only once you've typed; scrolls within its own height. */}
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
              <SemanticResults state={sem} onPick={(id) => go(`/game/${id}`)} />
            ) : (
              <TypeaheadResults
                data={suggest}
                query={needle}
                negated={negMode}
                onGame={(id) => go(`/game/${id}`)}
                onAuthor={(name) => { addAuthorFilter(name); setQuery(''); inputRef.current?.focus(); }}
                onTag={(name) => { addTagFilter(negMode ? `-${name}` : name); setQuery(''); inputRef.current?.focus(); }}
              />
            )}
          </Box>
        )}
      </Box>
    </>
  );
};

// Removable filter pill: tags amber + "#name", authors red + person icon (matches the red author
// name on game pages). The WHOLE chip removes (easier on phones than a tiny ✕); the ✕ stays as
// affordance.
const FilterChip: React.FC<{ label: string; kind: 'tag' | 'author'; onRemove?: () => void }> = ({
  label, kind, onRemove,
}) => {
  const isAuthor = kind === 'author';
  // Exclusion tag ("-name"): same amber, outlined and struck through — reads "without", not
  // confused with red author chips.
  const isNeg = !isAuthor && label.startsWith('-');
  const bare = isNeg ? label.slice(1) : label;
  const chipSx = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0.25,
    pl: isAuthor ? 0.7 : 1.1,
    pr: onRemove ? 0.8 : (isAuthor ? 1 : 1.3),
    py: 0.4,
    borderRadius: '99px',
    bgcolor: isNeg ? 'transparent' : isAuthor ? '#ff5252' : 'primary.main',
    color: isNeg ? 'primary.main' : isAuthor ? '#fff' : '#000',
    border: isNeg ? '1px solid' : 'none',
    borderColor: isNeg ? 'primary.main' : 'transparent',
    fontSize: '.82rem',
    fontWeight: 600,
    whiteSpace: 'nowrap',
    flex: '0 0 auto',
  } as const;
  const inner = (
    <>
      {isAuthor && <PersonIcon sx={{ fontSize: 15, ml: 0.3 }} />}
      {isAuthor ? label : (
        <Box component="span" sx={{ textDecoration: isNeg ? 'line-through' : 'none' }}>
          {isNeg ? `−#${bare}` : `#${bare}`}
        </Box>
      )}
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

// Commit action as a rectangular button (not a pill) so it never reads as another chip.
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

// Rows leading to a route take `href` and render a real <a> (middle/ctrl-click, "Open in new tab").
// Plain left clicks are intercepted for SPA navigation; modified/non-primary fall through. Rows
// without href (author/tag suggestions) only mutate filter state.
const ROW_SX = {
  display: 'flex', alignItems: 'center', gap: 1.5, width: '100%',
  px: 2, py: 1.4, justifyContent: 'flex-start', textAlign: 'left',
  textDecoration: 'none',
  '&:hover': { bgcolor: 'rgba(255,255,255,.05)' },
  '&:active': { bgcolor: 'rgba(255,255,255,.07)' },
} as const;

// Chrome dispatches middle clicks as `auxclick`, so onClick usually doesn't fire; the button check
// is belt and braces.
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

// Format badge uses the SAME icons as SearchPage's format filter (ImageIcon / TouchAppIcon).
// Unknown format keeps the neutral controller icon.
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
  // "-name" typed: tag rows add an exclusion filter.
  negated?: boolean;
  onGame: (id: string) => void;
  onAuthor: (name: string) => void;
  onTag: (name: string) => void;
}> = ({ data, query, negated = false, onGame, onAuthor, onTag }) => {
  const any = data.titles.length || data.authors.length || data.tags.length;
  if (!any) {
    return negated
      ? <EmptyNote>No tag matches “{query}”.</EmptyNote>
      : <EmptyNote>No matches for “{query}”. Try Semantic search ↑</EmptyNote>;
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
              {negated ? `−#${t.name}` : `#${t.name}`}
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
              if (!isPlainClick(e)) return;
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
