// src/components/Search/SearchPage.tsx

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, useContext } from 'react';
import {
  Box,
  Typography,
  CircularProgress,
  Container,
  Tabs,
  Tab,
  TextField,
  Button,
  InputAdornment,
  ToggleButton,
  ToggleButtonGroup,
  Autocomplete,
  Chip,
  useTheme,
  Paper,
  createFilterOptions,
  Grid,
  debounce,
  alpha,
  IconButton,
  Tooltip,
  Divider,
  SxProps,
  Theme,
  AutocompleteRenderGetTagProps
} from '@mui/material';
import { useSearchParams, useNavigate } from 'react-router-dom';

// Icons
import SearchIcon from '@mui/icons-material/Search';
import PsychologyIcon from '@mui/icons-material/Psychology';
import NewReleasesIcon from '@mui/icons-material/NewReleases';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import ShuffleIcon from '@mui/icons-material/Shuffle';
import RefreshIcon from '@mui/icons-material/Refresh';
import TitleIcon from '@mui/icons-material/Title';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import FavoriteIcon from '@mui/icons-material/Favorite';
import ImageIcon from '@mui/icons-material/Image';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import AppsIcon from '@mui/icons-material/Apps';
import FilterNoneIcon from '@mui/icons-material/FilterNone';

// PB & Types
import { Game, gamesCollectionPublic, tagsCollectionPublic, Tag, authorsCollectionPublic, AuthContext, CATALOG_GAME_FIELDS, PINNED_ORIGINAL_DAYS, loadPinnedSeen } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameGrid from './GameGrid';
import AnnouncementBanner from '../Announcements/AnnouncementBanner';
import { analytics } from '../../utils/analytics';
import { buildAliasIndex, resolveAlias, AliasIndex } from '../../utils/fuzzy';
import { getUsedTagIds } from '../../utils/tagUsage';
import { SEARCH_HOME_EVENT } from '../../utils/searchTagBus';

// --- Helper Types ---
interface SemanticResult { id: string; score: number; }
interface SemanticApiResponse { results: SemanticResult[]; }
interface AuthorOption { id: string; name: string; }

type SearchTab = 'recent' | 'top' | 'liked' | 'tags' | 'random' | 'semantic' | 'similar';
type TimeFrame = 'all' | 'month';
type FormatFilter = 'all' | 'img' | 'link';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
// PINNED_ORIGINAL_DAYS (окно закрепа/бейджа) теперь единый — импортируется из
// pocketbase, чтобы GameCard (бейдж) и здесь (пин-запрос) не разъезжались.

const defaultFilter = createFilterOptions<string>();

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
  filterMode: FilterMode;
  blockedTags: Tag[];
}

export default function SearchPage({
  selectedTags: headerSelectedTags,
  selectedAuthors: headerSelectedAuthors,
  filterMode,
  blockedTags,
}: SearchPageProps) {
  const theme = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const { user, blockedGameIds } = useContext(AuthContext);
  // Персональный блеклист игр: набор id, которые юзер спрятал от себя. Фильтруем
  // РЕЗУЛЬТАТ на клиенте (а не в PB-фильтре), чтобы каталожные запросы остались
  // анонимными и кэшируемыми Cloudflare. Покрывает разом все табы, включая
  // сид из window.__CATALOG__, семантику и «похожие».
  const blockedGameSet = useMemo(() => new Set(blockedGameIds), [blockedGameIds]);

  // --- Styles ---
  const paperInputStyles: SxProps<Theme> = {
    p: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    backgroundColor: theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.05) : alpha(theme.palette.common.black, 0.03),
    borderRadius: 3, 
    transition: 'box-shadow 0.2s, background-color 0.2s',
    border: '1px solid transparent',
    '&:hover': {
      backgroundColor: theme.palette.mode === 'dark' ? alpha(theme.palette.common.white, 0.08) : alpha(theme.palette.common.black, 0.05),
    },
    '&:focus-within': {
      backgroundColor: theme.palette.background.paper,
      boxShadow: theme.shadows[2],
      borderColor: theme.palette.primary.main,
    }
  };

  const singleInputContainerSx: SxProps<Theme> = {
      maxWidth: 700, 
      mx: 'auto', 
      mb: 3 
  };

  const textFieldSx: SxProps<Theme> = {
    flex: 1,
    '& .MuiOutlinedInput-root': {
      '& fieldset': { border: 'none' },
      padding: '0 8px !important',
      minHeight: '44px', 
    },
    '& .MuiInputBase-input': {
        padding: '8px 0 !important',
        fontSize: '1rem', 
    },
    '& .MuiInputBase-input::placeholder': {
        fontSize: '0.95rem',
        opacity: 0.6
    }
  };

  const toggleGroupSx: SxProps<Theme> = {
    '& .MuiToggleButton-root': { 
        borderRadius: '10px', 
        px: 2, 
        py: 0.5, 
        border: 0, 
        color: theme.palette.text.secondary,
        bgcolor: alpha(theme.palette.primary.main, 0.05), 
        '&.Mui-selected': { 
            bgcolor: alpha(theme.palette.primary.main, 0.15),
            color: theme.palette.text.primary,
            fontWeight: 600
        },
        '&:hover': {
            bgcolor: alpha(theme.palette.primary.main, 0.1), 
        }
    } 
  };

  // --- UI State ---
  const [currentTab, setCurrentTab] = useState<SearchTab>('recent');
  const [topTimeFrame, setTopTimeFrame] = useState<TimeFrame>('month');
  const [formatFilter, setFormatFilter] = useState<FormatFilter>('all');

  // --- Data State ---
  const [games, setGames] = useState<Game[]>([]);
  // То, что реально показываем: игры минус персональный блеклист. Фильтруем на
  // рендере (а не при fetch), чтобы не рефетчить каталог при правке блеклиста и
  // не трогать кэшируемые запросы. Пагинация/hasMore считаются по сырому games.
  const visibleGames = useMemo(
    () => (blockedGameSet.size ? games.filter((g) => !blockedGameSet.has(g.id)) : games),
    [games, blockedGameSet],
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  // Закреп над лентой: свежие авторские релизы (см. PINNED_ORIGINAL_DAYS).
  const [pinnedGames, setPinnedGames] = useState<Game[]>([]);
  // Персональный дисмисс: id закреплённых игр, которые юзер уже смотрел (сервер
  // для залогиненных, localStorage для анона) — их из строки убираем. seenLoaded
  // гейтит рендер пинов: пока не знаем «что видел», строку не показываем вообще,
  // поэтому «сырой» вариант со всеми пинами не мелькает (без прыжка).
  const [seenPinned, setSeenPinned] = useState<Set<string>>(new Set());
  const [seenLoaded, setSeenLoaded] = useState(false);

  // --- Semantic & Similar State ---
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticScores, setSemanticScores] = useState<Map<string, number>>(new Map());
  
  const [similarSourceGame, setSimilarSourceGame] = useState<Game | null>(null);

  // --- Advanced Search (Tags Tab) State ---
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [allTagsList, setAllTagsList] = useState<string[]>([]);
  const [tagAliasIndex, setTagAliasIndex] = useState<AliasIndex>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);

  const [localSelectedTags, setLocalSelectedTags] = useState<string[]>([]);
  const [tagInputValue, setTagInputValue] = useState('');

  const [localSelectedAuthors, setLocalSelectedAuthors] = useState<string[]>([]);
  const [localTitleQuery, setLocalTitleQuery] = useState('');

  // --- ASYNC AUTOCOMPLETE STATES ---
  const [titleInputValue, setTitleInputValue] = useState('');
  const [titleOptions, setTitleOptions] = useState<Game[]>([]);
  const [loadingTitles, setLoadingTitles] = useState(false);

  const [authorInputValue, setAuthorInputValue] = useState('');
  const [authorOptions, setAuthorOptions] = useState<AuthorOption[]>([]);
  const [loadingAuthors, setLoadingAuthors] = useState(false);
 

  const observer = useRef<IntersectionObserver | null>(null);
  const seedAppliedRef = useRef(false);
  const prevFiltersRef = useRef<string>('');
const lastFetchedPageRef = useRef<number>(1);

const fetchGenerationRef = useRef(0);

  // --- URL SYNC ---
  useEffect(() => {
    const queryParam = searchParams.get('q');
    const tagsParam = searchParams.get('tags');
    const authorsParam = searchParams.get('authors');
    const similarParam = searchParams.get('similar');

    if (similarParam) {
        setCurrentTab('similar');
        fetchSimilarGames(similarParam);
    } else if (queryParam || tagsParam || authorsParam) {
        setCurrentTab('tags');
        if (queryParam) {
            setLocalTitleQuery(queryParam);
            setTitleInputValue(queryParam);
        }
        if (tagsParam) setLocalSelectedTags(tagsParam.split(','));
        if (authorsParam) setLocalSelectedAuthors(authorsParam.split(','));
        setSemanticQuery('');
    }
  }, [searchParams]);

  // --- "RETURN HOME" (logo tap) ---
  // The logo is the site's universal home button, but home is one component with
  // many internal states (tab + filters), not distinct URLs — so a plain nav to "/"
  // can't reset it. This snaps everything back to the default "New" (recent) feed:
  // clears the tab, all filters, semantic/similar state, and drops any ?q/?tags/etc.
  useEffect(() => {
    const onHome = () => {
      setCurrentTab('recent');
      setTopTimeFrame('month');
      setFormatFilter('all');
      setLocalSelectedTags([]);
      setLocalSelectedAuthors([]);
      setLocalTitleQuery('');
      setTitleInputValue('');
      setAuthorInputValue('');
      setTagInputValue('');
      setSemanticQuery('');
      setSemanticScores(new Map());
      setSimilarSourceGame(null);
      setPage(1);
      lastFetchedPageRef.current = 1;
      setHasMore(true);
      setGames([]);
      prevFiltersRef.current = ''; // force the catalog effect to refetch the feed
      setSearchParams({});
    };
    window.addEventListener(SEARCH_HOME_EVENT, onHome);
    return () => window.removeEventListener(SEARCH_HOME_EVENT, onHome);
  }, [setSearchParams]);

  // --- INIT TAGS ---
  useEffect(() => {
      let isMounted = true;
      (async () => {
        try {
          // v3: добавлено поле aliases (синонимы) — старый v2-кэш его не содержит,
          // поэтому ключ кэша поднят. (v2 в своё время подняли из-за протухшего
          // кэша без NSFW-тега, молча выключавшего фильтр.)
          const cachedTags = localStorage.getItem('tagMap_v3');
          const lastUpdated = localStorage.getItem('tagMap_v3_updated');
          const now = Date.now();
          let newTagMap: Map<string, Tag>;

          if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
              newTagMap = new Map(JSON.parse(cachedTags));
          } else {
              const fullTagList = await tagsCollectionPublic.getFullList<Tag>({ fields: 'id,name,aliases', sort: 'name' });
              newTagMap = new Map(fullTagList.map(t => [t.id, t]));
              localStorage.setItem('tagMap_v3', JSON.stringify([...newTagMap]));
              localStorage.setItem('tagMap_v3_updated', now.toString());
              localStorage.removeItem('tagMap');
              localStorage.removeItem('tagMapLastUpdated');
              localStorage.removeItem('tagMap_v2');
              localStorage.removeItem('tagMap_v2_updated');
          }

          // Пустые (0 игр) теги прячем из опций автокомплита (жалоба автора).
          const usedIds = await getUsedTagIds();
          const allTags = Array.from(newTagMap.values());

          if (isMounted) {
              setTagMap(newTagMap);
              setTagAliasIndex(buildAliasIndex(allTags));
              const visible = usedIds.size ? allTags.filter(t => usedIds.has(t.id)) : allTags;
              setAllTagsList(visible.map(t => t.name).sort());
              setTagsLoaded(true);
          }
        } catch (error) {
            console.error(error);
            if(isMounted) setTagsLoaded(true);
        }
      })();
      return () => { isMounted = false; };
  }, []);

 const nsfwTagId = useMemo(() => {
    for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'nsfw') return id;
    }
    return null;
}, [tagMap]);

const extremeTagId = useMemo(() => {
    for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'extreme') return id;
    }
    return null;
}, [tagMap]);

  // --- FETCH SUGGESTIONS ---
  const fetchTitleSuggestions = useMemo(
    () => debounce(async (request: { input: string }, callback: (results?: Game[]) => void) => {
        if (!request.input || request.input.length < 2) { callback([]); return; }
        try {
            const result = await gamesCollectionPublic.getList(1, 10, {
                filter: `(title ~ "${request.input}" || aliases ~ "${request.input}")`, sort: '-created', fields: 'id,title'
            });
            callback(result.items);
        } catch (error) { console.error(error); callback([]); }
    }, 300), []
  );

  useEffect(() => {
    let active = true;
    if (titleInputValue === '') { setTitleOptions([]); return undefined; }
    setLoadingTitles(true);
    fetchTitleSuggestions({ input: titleInputValue }, (results) => {
        if (active && results) { setTitleOptions(results); setLoadingTitles(false); }
    });
    return () => { active = false; };
  }, [titleInputValue, fetchTitleSuggestions]);

  const fetchAuthorSuggestions = useMemo(
      () => debounce(async (request: { input: string }, callback: (results?: AuthorOption[]) => void) => {
          if (!request.input || request.input.length < 2) { callback([]); return; }
          try {
              const result = await authorsCollectionPublic.getList(1, 10, { filter: `(name ~ "${request.input}" || aliases ~ "${request.input}")`, fields: 'id,name' });
              callback(result.items as unknown as AuthorOption[]);
          } catch (error) {
              console.error(error);
              callback([]);
          }
      }, 300), []
  );

  useEffect(() => {
      let active = true;
      if (authorInputValue === '') { setAuthorOptions([]); return undefined; }
      setLoadingAuthors(true);
      fetchAuthorSuggestions({ input: authorInputValue }, (results) => {
          if (active && results) { setAuthorOptions(results || []); setLoadingAuthors(false); }
      });
      return () => { active = false; };
  }, [authorInputValue, fetchAuthorSuggestions]);

  // --- HANDLERS ---
  const filterTagOptions = (options: string[], params: { inputValue: string; getOptionLabel: (option: string) => string; }) => {
    const cleanedInput = params.inputValue.startsWith('-') ? params.inputValue.substring(1) : params.inputValue;
    return defaultFilter(options, { ...params, inputValue: cleanedInput });
  };

  const handleAddTag = (tagToAdd: string | null) => {
    if (!tagToAdd) return;
    const trimmedItem = tagToAdd.trim();
    if (!trimmedItem) return;
    const isNegative = trimmedItem.startsWith('-');
    const baseTagName = isNegative ? trimmedItem.substring(1) : trimmedItem;
    // Резолвим синоним/опечатку в каноническое имя: «Netorare»→NTR,
    // «Gender Swap»→Gender Bender, «trasnformation»→Transformation.
    const canonical =
      resolveAlias(baseTagName, tagAliasIndex) ??
      allTagsList.find(t => t.toLowerCase() === baseTagName.toLowerCase()) ??
      baseTagName;
    const finalTag = isNegative ? `-${canonical}` : canonical;
    setLocalSelectedTags([...new Set([...localSelectedTags, finalTag])]);
    setTagInputValue('');
  };

  // --- CUSTOM CHIP RENDERER ---
  const renderTagChips = (value: string[], getTagProps: AutocompleteRenderGetTagProps) => {
    return value.map((option: string, index: number) => {
      const { key, ...tagProps } = getTagProps({ index });
      const isNegative = option.startsWith('-');
      const label = isNegative ? option.substring(1) : option;
      
      const mainColor = isNegative ? theme.palette.error.main : theme.palette.success.main;

      return (
        <Chip 
            key={key}
            label={label}
            {...tagProps}
            variant="outlined"
            size="small"
            sx={{
                borderColor: mainColor,
                color: theme.palette.text.primary,
                height: '26px',
                fontSize: '0.85rem',
                borderRadius: '6px',
                m: '3px',
                borderWidth: '1px',
                '& .MuiChip-label': {
                    px: 1,
                    fontWeight: 500,
                },
                '& .MuiChip-deleteIcon': {
                    color: mainColor,
                    opacity: 0.7,
                    fontSize: '18px',
                    '&:hover': {
                        color: mainColor,
                        opacity: 1
                    }
                }
            }}
        />
      );
    });
  };

  // --- MAIN FETCH LOGIC ---
   
  const processGameData = (items: Record<string, unknown>[]): Game[] => {
      return items.map((item) => {
          const rawExpand = item['expand'] as Record<string, unknown> | undefined;
          const processedExpand = rawExpand ? {
              ...(rawExpand.authors ? { 
                  authors: Array.isArray(rawExpand.authors) ? rawExpand.authors : [rawExpand.authors] 
              } : {}),
              ...(rawExpand.tags ? { 
                  tags: Array.isArray(rawExpand.tags) ? rawExpand.tags : [rawExpand.tags] 
              } : {})
          } : {};

          return {
              ...item,
              expand: processedExpand
          } as Game;
      });
  };

  // --- FRAME-2 SEED ("впрыск") ---
  // Go inlines the default catalog view into index.html as two `-created` top-page
  // arrays (same shape as a getList response): `window.__CATALOG__` (SFW, nsfw/extreme
  // excluded) and `window.__CATALOG_ALL__` (no filter). Seed the grid from the one that
  // matches the active filter mode BEFORE first paint, so cold visits render real cards
  // immediately instead of the empty→cards CLS jump (and non-SFW skips the spinner).
  // Only seed where the snapshot matches the upcoming fetch exactly (no wrong-content
  // flash): sfw → __CATALOG__, all → __CATALOG_ALL__. nsfw-only is server-filtered to a
  // different set, so it isn't seeded (React fetches; pre-paint showed ALL as filler).
  // The normal fetchGames then reconciles by id. useLayoutEffect runs before paint, so
  // the empty first render is never shown.
  useLayoutEffect(() => {
      if (seedAppliedRef.current) return;
      if (currentTab !== 'recent') return;
      if (filterMode !== 'sfw' && filterMode !== 'all') return;
      if (headerSelectedTags.length || headerSelectedAuthors.length || blockedTags.length) return;
      if (searchParams.get('q') || searchParams.get('tags') || searchParams.get('authors') || searchParams.get('similar')) return;
      const win = window as unknown as { __CATALOG__?: unknown; __CATALOG_ALL__?: unknown };
      const seed = filterMode === 'sfw' ? win.__CATALOG__ : win.__CATALOG_ALL__;
      if (!Array.isArray(seed) || seed.length === 0) return;
      seedAppliedRef.current = true;
      setGames(processGameData(seed as Record<string, unknown>[]));
      setLoading(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Полоса закрепа показывается только в «чистой» ленте recent — без тегов,
  // авторов и формат-фильтра, — чтобы не спорить с активными фильтрами юзера.
  const showPinnedStrip = currentTab === 'recent'
    && headerSelectedTags.length === 0
    && headerSelectedAuthors.length === 0
    && formatFilter === 'all';

  useEffect(() => {
    if (!showPinnedStrip || !tagsLoaded) {
      setPinnedGames([]); setSeenPinned(new Set()); setSeenLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cutoff = new Date(Date.now() - PINNED_ORIGINAL_DAYS * ONE_DAY_IN_MS)
          .toISOString().replace('T', ' ').substring(0, 19);
        // Свежий авторский релиз = булево поле games.original_release (не тег).
        const filters = [`original_release = true`, `created >= "${cutoff}"`];
        if (filterMode === 'sfw') {
          if (nsfwTagId) filters.push(`tags.id != "${nsfwTagId}"`);
          if (extremeTagId) filters.push(`tags.id != "${extremeTagId}"`);
        } else if (filterMode === 'nsfw') {
          const conditions = [];
          if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
          if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
          if (conditions.length) filters.push(`(${conditions.join(' || ')})`);
          else filters.push('(1=0)');
        }
        if (blockedTags.length > 0) filters.push(...blockedTags.map(t => `tags.id != "${t.id}"`));
        const result = await gamesCollectionPublic.getList(1, 10, {
          sort: '-created', expand: 'authors,tags', filter: filters.join(' && '),
          fields: CATALOG_GAME_FIELDS,
        });
        if (cancelled) return;
        const items = processGameData(result.items as unknown as Record<string, unknown>[]);
        // Какие из этих закреплённых юзер уже смотрел — параллельный крохотный
        // запрос (id-only, ограничен ≤10 кандидатами). Ставим оба стейта вместе,
        // React 18 их батчит → один рендер, строка сразу правильная.
        const seen = await loadPinnedSeen(items.map((g) => g.id));
        if (cancelled) return;
        setPinnedGames(items);
        setSeenPinned(seen);
        setSeenLoaded(true);
      } catch {
        if (!cancelled) { setPinnedGames([]); setSeenPinned(new Set()); setSeenLoaded(true); }
      }
    })();
    return () => { cancelled = true; };
    // processGameData пересоздаётся каждый рендер — в deps не кладём (как и сид-эффект).
    // user в deps: при входе/выходе пересчитываем «что видел» (сервер ↔ localStorage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPinnedStrip, tagsLoaded, filterMode, nsfwTagId, extremeTagId, blockedTags, user]);

  // Из закрепа убираем и заблокированные, и уже просмотренные этим юзером
  // (персональный дисмисс). Просмотренный оригинал при этом остаётся в обычной
  // ленте на своём месте — открепляется закреп, не игра.
  const visiblePinned = useMemo(
    () => pinnedGames.filter((g) => !blockedGameSet.has(g.id) && !seenPinned.has(g.id)),
    [pinnedGames, blockedGameSet, seenPinned],
  );
  const pinnedIds = useMemo(() => new Set(visiblePinned.map((g) => g.id)), [visiblePinned]);
  // Финальная лента: закреплённые оригиналы впереди (первыми в строке), затем
  // остальная лента без них — чтобы они не задваивались и не занимали свой ряд.
  // Гейт по seenLoaded: пока не знаем «что видел», пины не выносим вперёд, чтобы
  // не показать закреп, который тут же исчезнет (прыжок).
  const feedGames = useMemo(
    () => (showPinnedStrip && seenLoaded && pinnedIds.size > 0
        ? [...visiblePinned, ...visibleGames.filter((g) => !pinnedIds.has(g.id))]
        : visibleGames),
    [showPinnedStrip, seenLoaded, visiblePinned, pinnedIds, visibleGames],
  );

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
        if (!tagsLoaded) return;
        if (currentTab === 'semantic' || currentTab === 'random' || currentTab === 'similar') return;
        
        if (currentTab === 'liked' && !user) {
            setGames([]);
            setHasMore(false);
            setLoading(false);
            return;
        }

        const generation = ++fetchGenerationRef.current;
        setLoading(true);
        try {
            const filterConditions: string[] = [];
            const isAdvancedTab = currentTab === 'tags';
            const activeTags = isAdvancedTab ? localSelectedTags : headerSelectedTags;
            const activeAuthors = isAdvancedTab ? localSelectedAuthors : headerSelectedAuthors;
            const activeTitleQuery = isAdvancedTab ? localTitleQuery : '';

            if (activeTitleQuery) {
                const q = activeTitleQuery.replace(/"/g, '\\"');
                filterConditions.push(`(title ~ "${q}" || aliases ~ "${q}")`);
            }
            if (activeAuthors.length > 0) filterConditions.push(`(${activeAuthors.map(a => `authors.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`);

            const positiveSelectedTags: string[] = [];
            const negativeSelectedTagNames: string[] = [];
            activeTags.forEach(tag => {
                const neg = tag.startsWith('-');
                const raw = neg ? tag.substring(1) : tag;
                if (!raw) return;
                // Синоним/опечатку из шапки или URL сводим к каноническому имени тега,
                // иначе точный матч по name даст 0 результатов.
                const canon = resolveAlias(raw, tagAliasIndex) ?? raw;
                if (neg) negativeSelectedTagNames.push(canon);
                else positiveSelectedTags.push(canon);
            });

            if (filterMode === 'sfw') {
                if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`);
                if (extremeTagId) filterConditions.push(`tags.id != "${extremeTagId}"`);
            } else if (filterMode === 'nsfw') {
                if (nsfwTagId || extremeTagId) {
                    const conditions = [];
                    if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
                    if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
                    filterConditions.push(`(${conditions.join(' || ')})`);
                } else filterConditions.push('(1=0)');
            }

            if (blockedTags.length > 0) filterConditions.push(...blockedTags.map(t => `tags.id != "${t.id}"`));
            if (negativeSelectedTagNames.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([,t]) => negativeSelectedTagNames.includes(t.name)).map(([id]) => id);
                if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`));
            }
            if (positiveSelectedTags.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([,t]) => positiveSelectedTags.includes(t.name)).map(([id]) => id);
                if (ids.length === positiveSelectedTags.length) filterConditions.push(...ids.map(id => `tags ~ "${id}"`));
                else filterConditions.push('(1=0)');
            }

            if (currentTab === 'top' && topTimeFrame === 'month') {
                const date = new Date(); date.setDate(date.getDate() - 30);
                filterConditions.push(`created >= "${date.toISOString().replace('T', ' ').substring(0, 19)}"`);
            }

            if (currentTab === 'liked' && user) {
                filterConditions.push(`upvotes ?~ "${user.id}"`);
            }

            if (formatFilter !== 'all') {
                filterConditions.push(`img_or_link = "${formatFilter}"`);
            }

            // «new» учитывает бампы: bumped_at сеется = created при создании и
            // двигается вперёд бампом владельца/модера (см. game_edits.go).
            const sortOrder = currentTab === 'top' ? '-upvotes_count,-created' : '-bumped_at,-created';
            const result = await gamesCollectionPublic.getList(pageNum, ITEMS_PER_PAGE, {
                sort: sortOrder, expand: 'authors,tags', filter: filterConditions.join(' && '),
                fields: CATALOG_GAME_FIELDS,
            });

            // Если за время запроса запустился новый fetch — игнорируем устаревший ответ
            if (fetchGenerationRef.current !== generation) return;

            setGames((prev) => {
                 const newG = processGameData(result.items as unknown as Record<string, unknown>[]);
                 if (isReset) return newG;
                 const existingIds = new Set(prev.map(g => g.id));
                 return [...prev, ...newG.filter(g => !existingIds.has(g.id))];
             });
            setHasMore(result.items.length === ITEMS_PER_PAGE);
        } catch (error) { 
            if (fetchGenerationRef.current !== generation) return;
            console.error(error); setHasMore(false); 
        } finally { 
            if (fetchGenerationRef.current === generation) setLoading(false);   // ← ИЗМЕНИТЬ
        }
    },
    [tagsLoaded, headerSelectedTags, headerSelectedAuthors, localSelectedTags, localSelectedAuthors, localTitleQuery, filterMode, blockedTags, currentTab, topTimeFrame, tagMap, tagAliasIndex, nsfwTagId, extremeTagId, formatFilter, user]
);

  const fetchRandomGames = async () => {
      setLoading(true); setGames([]); setHasMore(false);
      try {
          const filterConditions: string[] = [];
          if (filterMode === 'sfw') { if (nsfwTagId) filterConditions.push(`tags.id != "${nsfwTagId}"`); if (extremeTagId) filterConditions.push(`tags.id != "${extremeTagId}"`); }
          else if (filterMode === 'nsfw') {
              // Скобки ОБЯЗАТЕЛЬНЫ: условия склеиваются через ' && ', а в фильтре PB
              // (как в SQL) && связывает сильнее ||. Без них `A || B && формат`
              // разваливалось в `A || (B && формат)` — nsfw-игры проходили мимо
              // формат-фильтра и blocked-тегов. Плюс id подставляем только известные,
              // иначе в строку попадал литерал "null".
              const conditions = [];
              if (nsfwTagId) conditions.push(`tags ~ "${nsfwTagId}"`);
              if (extremeTagId) conditions.push(`tags ~ "${extremeTagId}"`);
              filterConditions.push(conditions.length ? `(${conditions.join(' || ')})` : '1=0');
          }
          if (blockedTags.length > 0) filterConditions.push(...blockedTags.map(t => `tags.id != "${t.id}"`));
          
          if (formatFilter !== 'all') {
             filterConditions.push(`img_or_link = "${formatFilter}"`);
          }

          const allIds = await gamesCollectionPublic.getFullList({ filter: filterConditions.join(' && '), fields: 'id' });
          if (!allIds.length) { setLoading(false); return; }

          const shuffled = allIds.sort(() => 0.5 - Math.random()).slice(0, 20);
          const randomG = await gamesCollectionPublic.getFullList({
              filter: shuffled.map(i => `id="${i.id}"`).join(' || '),
              expand: 'authors,tags',
              fields: CATALOG_GAME_FIELDS,
          });
          setGames(processGameData(randomG as unknown as Record<string, unknown>[]).sort(()=>0.5-Math.random()));
      } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const handleSemanticSearch = async (e?: React.FormEvent) => {
      if (e) e.preventDefault(); if (semanticQuery.trim().length < 2) return;
      analytics.semanticSearch({ source: 'catalog', query_len: semanticQuery.trim().length });
      setLoading(true); setGames([]); setHasMore(false);
      try {
          const res = await fetch(`/api/semantic-search?q=${encodeURIComponent(semanticQuery)}&mode=mixed`);
          if (!res.ok) { const err = await res.json(); throw new Error(err.detail || 'Search failed'); }
          
          const data: SemanticApiResponse = await res.json();
          if (!data.results || data.results.length === 0) { setLoading(false); return; }
          
          const scoreMap = new Map<string, number>();
          data.results.forEach((r) => scoreMap.set(r.id, r.score));
          setSemanticScores(scoreMap);
          
          const pbGames = await gamesCollectionPublic.getFullList({ filter: data.results.map((r)=>`id="${r.id}"`).join('||'), expand: 'authors,tags', fields: CATALOG_GAME_FIELDS });
          
          const matchedGames = data.results
             .map((r) => pbGames.find((g) => g.id === r.id))
             .filter((g): g is Game => !!g);

          setGames(processGameData(matchedGames as unknown as Record<string, unknown>[]));
      } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  // --- Similar Games Fetcher ---
  const fetchSimilarGames = async (gameId: string) => {
    setLoading(true); setGames([]); setHasMore(false);
    try {
        const res = await fetch(`/api/similar-games/${gameId}`);
        if (!res.ok) {
             const err = await res.json();
             if(res.status === 404) { 
                 console.warn("Game AI data not found");
             }
             throw new Error(err.detail || 'Similarity search failed'); 
        }
        
        const data: SemanticApiResponse = await res.json();
        if (!data.results || data.results.length === 0) { setLoading(false); return; }

        const scoreMap = new Map<string, number>();
        data.results.forEach((r) => scoreMap.set(r.id, r.score));
        setSemanticScores(scoreMap);

        const pbGames = await gamesCollectionPublic.getFullList({ filter: data.results.map((r)=>`id="${r.id}"`).join('||'), expand: 'authors,tags', fields: CATALOG_GAME_FIELDS });
        
        const matchedGames = data.results
            .map((r) => pbGames.find((g) => g.id === r.id))
            .filter((g): g is Game => !!g);

        setGames(processGameData(matchedGames as unknown as Record<string, unknown>[]));
    } catch (err) { console.error(err); } finally { setLoading(false); }
  };

  // --- TABS LOGIC ---
  const handleTabChange = (_: React.SyntheticEvent, newValue: SearchTab) => {
      analytics.tabSwitch(newValue);
      setCurrentTab(newValue);
      setPage(1); 
    lastFetchedPageRef.current = 1; 
      setHasMore(true); 
      setGames([]); 
      setSimilarSourceGame(null); 
      prevFiltersRef.current = '';
      
      if (newValue !== 'similar' && newValue !== 'tags') {
          setSearchParams({});
      }

      if (newValue === 'random') fetchRandomGames();
  };

  useEffect(() => {
      if (!tagsLoaded) return;
      if (currentTab === 'semantic' || currentTab === 'random' || currentTab === 'similar') return;
      
      const currentFilters = JSON.stringify({
          headerTags: headerSelectedTags, headerAuthors: headerSelectedAuthors,
          localTags: localSelectedTags, localAuthors: localSelectedAuthors,
          title: localTitleQuery,
          mode: filterMode, blocked: blockedTags.map(t=>t.id), tab: currentTab, time: topTimeFrame,
          format: formatFilter, userId: user?.id,
          nsfwTagId, extremeTagId
      });
      if (prevFiltersRef.current !== currentFilters) {
          prevFiltersRef.current = currentFilters;
          setPage(1); lastFetchedPageRef.current = 1; setHasMore(true); fetchGames(1, true);
      }
  }, [tagsLoaded, headerSelectedTags, headerSelectedAuthors, localSelectedTags, localSelectedAuthors,
      localTitleQuery, filterMode, blockedTags, currentTab, topTimeFrame, formatFilter, user, fetchGames,
      nsfwTagId, extremeTagId
  ]);

  // Random-таб пропускается основным эффектом выше, поэтому смена формата
  // (static/interactive) или NSFW-фильтра не перекидывала список — он висел
  // со старой смешанной выборкой до "Roll Again". Перекидываем сами.
  //
  // Сравниваем ЗНАЧЕНИЯ, а не ссылки (как prevFiltersRef у основной ленты):
  // blockedTags прилетает сверху новым массивом на каждый authStore.onChange —
  // в т.ч. когда соседняя вкладка обновила токен. Открыл карточку средним
  // кликом → новая вкладка рефрешит токен → старая перекатывала рулетку
  // и подборка исчезала из-под пальцев. Теперь такой «пустой» апдейт игнорим.
  const randomRollKeyRef = useRef<string | null>(null);
  useEffect(() => {
      const key = JSON.stringify({
          format: formatFilter,
          mode: filterMode,
          blocked: blockedTags.map((t) => t.id),
      });
      if (randomRollKeyRef.current === key) return;
      randomRollKeyRef.current = key;
      if (currentTab !== 'random') return;
      fetchRandomGames();
      // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatFilter, filterMode, blockedTags]);

useEffect(() => {
    // Проверяем стандартные условия
    const isStandardTab = ['recent','top','liked','tags'].includes(currentTab);
    
    if (page > 1 && hasMore && !loading && isStandardTab) {
        // ЗАЩИТА ОТ ЦИКЛА:
        // Если мы уже запрашивали эту страницу, не делаем это снова
        if (lastFetchedPageRef.current === page) return;

        lastFetchedPageRef.current = page; // Запоминаем текущую страницу
        fetchGames(page, false);
    }
}, [page, hasMore, loading, currentTab, fetchGames]);

  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
      if (loading || !hasMore || ['semantic','random','similar'].includes(currentTab)) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver(entries => { if (entries[0].isIntersecting) setPage(p => p + 1); });
      if (node) observer.current.observe(node);
  }, [loading, hasMore, currentTab]);


  // --- RENDER ---
  return (
      <Container maxWidth={false} disableGutters sx={{ maxWidth: '2200px', mx: 'auto', px: { xs: 1, sm: 2, md: 3 }, pt: 0, pb: 1 }}>

            <AnnouncementBanner />

            {/* --- HEADER & CONTROLS --- */}
            <Box sx={{ mb: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <Paper
                elevation={0}
                sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    p: 0.5,
                    backgroundColor: alpha(theme.palette.text.primary, 0.04),
                    borderRadius: '16px',
                    
                    // ИСПРАВЛЕНИЕ:
                    // 1. fit-content заставит Paper быть шириной ровно по контенту (кнопкам)
                    // 2. maxWidth: '100%' не даст ему вылезти за экран на мобильном
                    width: 'fit-content', 
                    maxWidth: '100%',
                }}
                >
                    <Tabs
                    value={currentTab}
                    onChange={handleTabChange}
                    sx={{
                        minHeight: 'unset',
                        '& .MuiTabs-indicator': { display: 'none' },
                        
                        // Настройки контейнера кнопок
                        '& .MuiTabs-flexContainer': {
                            flexWrap: 'wrap', // Разрешаем перенос
                            justifyContent: 'center', // Центрируем кнопки внутри
                            gap: 0.5 // Расстояние между кнопками
                        },
                        
                        '& .MuiTab-root': {
                            textTransform: 'none',
                            minHeight: '40px',
                            fontWeight: 600,
                            borderRadius: '12px',
                            px: { xs: 1, sm: 2 }, // Чуть плотнее на мобильных
                            mr: 0,
                            
                            // ВАЖНО: 
                            // На мобилках (xs) кнопки растягиваются, заполняя строку (flexGrow: 1).
                            // На планшетах и выше (sm) они занимают только свой размер (flexGrow: 0).
                            flexGrow: { xs: 1, sm: 0 }, 
                            maxWidth: { xs: '100%', sm: 'none' },

                            '&.Mui-selected': {
                                backgroundColor: theme.palette.background.paper,
                                boxShadow: theme.shadows[1],
                                color: theme.palette.primary.main
                            }
                        }
                    }}
                    >
                        <Tab value="recent" label="New" icon={<NewReleasesIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="top" label="Top" icon={<EmojiEventsIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="liked" label="Liked" icon={<FavoriteIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="tags" label="Search" icon={<SearchIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="random" label="Random" icon={<ShuffleIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="similar" label="Similar" icon={<FilterNoneIcon fontSize="small" />} iconPosition="start"/>
                        <Tab value="semantic" label="Semantic" icon={<PsychologyIcon fontSize="small" />} iconPosition="start"/>
                    </Tabs>
                </Paper>
                 

              {/* SECONDARY CONTROLS */}
              {['recent', 'top', 'liked', 'tags'].includes(currentTab) && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', alignItems: 'center' }}>
                      <ToggleButtonGroup value={formatFilter} exclusive onChange={(_, n) => n && setFormatFilter(n)} size="small" sx={toggleGroupSx}>
                          <ToggleButton value="all" aria-label="All Formats"><Tooltip title="All Formats"><AppsIcon fontSize="small" /></Tooltip></ToggleButton>
                          <ToggleButton value="img" aria-label="Static Images"><Tooltip title="Static Images"><ImageIcon fontSize="small" /></Tooltip></ToggleButton>
                          <ToggleButton value="link" aria-label="Interactive"><Tooltip title="Interactive"><TouchAppIcon fontSize="small" /></Tooltip></ToggleButton>
                      </ToggleButtonGroup>
                      {currentTab === 'top' && (
                          <>
                            <Divider orientation="vertical" flexItem sx={{ height: 24, alignSelf: 'center' }} />
                            <ToggleButtonGroup value={topTimeFrame} exclusive onChange={(_, n) => n && setTopTimeFrame(n)} size="small" sx={toggleGroupSx}>
                                <ToggleButton value="month">Month</ToggleButton>
                                <ToggleButton value="all">All Time</ToggleButton>
                            </ToggleButtonGroup>
                          </>
                      )}
                  </Box>
              )}

              {currentTab === 'random' && (
                  <Box sx={{ display: 'flex', gap: 2 }}>
                     <ToggleButtonGroup value={formatFilter} exclusive onChange={(_, n) => n && setFormatFilter(n)} size="small" sx={toggleGroupSx}>
                          <ToggleButton value="all"><AppsIcon fontSize="small" /></ToggleButton>
                          <ToggleButton value="img"><ImageIcon fontSize="small" /></ToggleButton>
                          <ToggleButton value="link"><TouchAppIcon fontSize="small" /></ToggleButton>
                      </ToggleButtonGroup>
                      <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => fetchRandomGames()} disabled={loading} size="small" sx={{ borderRadius: 3, px:3 }}>
                        Roll Again
                      </Button>
                  </Box>
              )}
          </Box>

          {/* --- SEARCH INTERFACES --- */}

          {/* 1. Advanced Search Grid */}
          {currentTab === 'tags' && (
              <Box sx={{ maxWidth: 1000, mx: 'auto', mb: 3 }}>
                  <Grid container spacing={1.5} alignItems="center">
                      <Grid item xs={12} md={3.5}>
                          <Paper sx={paperInputStyles} elevation={0}>
                              <TitleIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                              <Autocomplete
                                  freeSolo fullWidth options={titleOptions} loading={loadingTitles}
                                  getOptionLabel={(o) => (typeof o === 'string' ? o : o.title)} inputValue={titleInputValue}
                                  onInputChange={(_, v) => { setTitleInputValue(v); if (!v) setLocalTitleQuery(''); }}
                                  onChange={(_, v) => setLocalTitleQuery(typeof v === 'string' ? v : v?.title || '')}
                                  renderInput={(params) => (<TextField {...params} placeholder="Title..." sx={textFieldSx} InputProps={{ ...params.InputProps, endAdornment: loadingTitles ? <CircularProgress size={16} /> : null }} />)}
                              />
                          </Paper>
                      </Grid>
                      <Grid item xs={12} md={5}>
                          <Paper sx={paperInputStyles} elevation={0}>
                              <LocalOfferIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                              <Autocomplete
                                multiple freeSolo fullWidth options={allTagsList} value={localSelectedTags} inputValue={tagInputValue}
                                onInputChange={(_, v) => setTagInputValue(v)}
                                onChange={(_, v, r, d) => { if (r === 'selectOption' && d?.option) handleAddTag(tagInputValue.startsWith('-') ? `-${d.option}` : d.option); else setLocalSelectedTags(v as string[]); }}
                                filterOptions={filterTagOptions} 
                                // Исправлено: удален третий аргумент 'tag'
                                renderTags={(v, p) => renderTagChips(v, p)}
                                renderInput={(params) => (<TextField {...params} placeholder={localSelectedTags.length ? '' : "Tags (e.g. RPG, -Horror)"} sx={textFieldSx} onKeyDown={(e) => { if (e.key==='Enter' && tagInputValue) { e.preventDefault(); handleAddTag(tagInputValue); } }} />)}
                              />
                          </Paper>
                      </Grid>
                      <Grid item xs={12} md={3.5}>
                           <Paper sx={paperInputStyles} elevation={0}>
                                <PersonSearchIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.2rem' }} />
                                <Autocomplete
                                    multiple freeSolo fullWidth options={authorOptions} loading={loadingAuthors}
                                    getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)} inputValue={authorInputValue}
                                    onInputChange={(_, v) => setAuthorInputValue(v)} value={localSelectedAuthors.map(n => ({ id: n, name: n }))}
                                    onChange={(_, v) => setLocalSelectedAuthors(v.map(i => typeof i === 'string' ? i : i.name))}
                                    // Исправлено: удален третий аргумент 'author'
                                    renderTags={(v, p) => renderTagChips(v.map(i => typeof i === 'string' ? i : i.name), p)}
                                    renderInput={(params) => (<TextField {...params} placeholder={localSelectedAuthors.length ? '' : "Authors..."} sx={textFieldSx} InputProps={{ ...params.InputProps, endAdornment: loadingAuthors ? <CircularProgress size={16} /> : null }} />)}
                                />
                           </Paper>
                      </Grid>
                  </Grid>
              </Box>
          )}

          {/* 2. Similar Search Interface */}
          {currentTab === 'similar' && (
             <Box sx={singleInputContainerSx}>
                <Paper sx={paperInputStyles} elevation={0}>
                    <FilterNoneIcon color="action" sx={{ ml: 1, mr: 1, fontSize: '1.4rem' }} />
                    <Autocomplete
                        freeSolo fullWidth
                        options={titleOptions}
                        loading={loadingTitles}
                        getOptionLabel={(o) => (typeof o === 'string' ? o : o.title)}
                        inputValue={titleInputValue}
                        onInputChange={(_, v) => setTitleInputValue(v)}
                        onChange={(_, v) => {
                            if (v && typeof v !== 'string') {
                                setSimilarSourceGame(v);
                                fetchSimilarGames(v.id);
                            }
                        }}
                        renderInput={(params) => (
                            <TextField 
                                {...params} 
                                placeholder="Type game name to find lookalikes..." 
                                sx={textFieldSx}
                                InputProps={{ 
                                    ...params.InputProps, 
                                    endAdornment: loadingTitles ? <CircularProgress size={16} /> : null 
                                }}
                            />
                        )}
                    />
                </Paper>
             </Box>
          )}

          {/* 3. Semantic Search Bar */}
          {currentTab === 'semantic' && (
             <Box sx={singleInputContainerSx}>
                <Paper
                    component="form"
                    onSubmit={handleSemanticSearch}
                    elevation={0}
                    sx={paperInputStyles}
                >
                    <InputAdornment position="start" sx={{ pl: 1, mr: 1 }}>
                        <PsychologyIcon color="action" sx={{ fontSize: '1.4rem' }} />
                    </InputAdornment>
                    <TextField
                        fullWidth variant="outlined"
                        placeholder="Describe the game you are looking for..."
                        value={semanticQuery}
                        onChange={(e) => setSemanticQuery(e.target.value)}
                        sx={textFieldSx}
                    />
                    <Tooltip title="Search">
                        <IconButton type="submit" color="primary" sx={{ p: '8px', mr: 0.5 }} disabled={loading}>
                            {loading ? <CircularProgress size={20} /> : <SearchIcon />}
                        </IconButton>
                    </Tooltip>
                </Paper>
             </Box>
          )}

          {/* --- RESULTS & EMPTY STATES --- */}
          <Box sx={{ minHeight: 400 }}>
            
            {currentTab === 'liked' && !user && (
                <Box sx={{ textAlign: 'center', mt: 8, opacity: 0.8 }}>
                    <FavoriteIcon sx={{ fontSize: 60, color: 'text.secondary', mb: 2, opacity: 0.5 }} />
                    <Typography variant="h5" gutterBottom>Your Favorites</Typography>
                    <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
                        Login to see the games you've liked.
                    </Typography>
                    <Button variant="contained" color="primary" onClick={() => navigate('/login')}>
                        Login / Sign Up
                    </Button>
                </Box>
            )}

            {loading && visibleGames.length === 0 && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8 }}><CircularProgress /></Box>}

            {!loading && visibleGames.length === 0 && (currentTab !== 'liked' || user) && (
                <Box sx={{ textAlign: 'center', mt: 8, opacity: 0.7, maxWidth: 600, mx: 'auto' }}>
                    
                    {/* --- EMPTY STATE: SEMANTIC --- */}
                    {currentTab === 'semantic' && (
                        <Box>
                            <Typography variant="body1" sx={{ mb: 1, fontSize: '1.05rem' }}>
                                Find games by describing them in plain English.
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                                Try: <i>"Isekai with kingdom building"</i> or <i>"Horror game about being trapped in a loop"</i>.
                            </Typography>
                        </Box>
                    )}

                    {/* --- EMPTY STATE: SIMILAR --- */}
                    {currentTab === 'similar' && (
                         <Box>
                            {similarSourceGame ? (
                                // Game selected but API returned 0 results
                                <>
                                    <Typography variant="h6">No similarities found</Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        We couldn't find games close enough to {similarSourceGame.title}.
                                    </Typography>
                                </>
                            ) : (
                                // No game selected yet (Initial state)
                                <>
                                     <Typography variant="body1" sx={{ mb: 1, fontSize: '1.05rem' }}>
                                        Find Similar Games
                                    </Typography>
                                    <Typography variant="body2" color="text.secondary">
                                        Select a game from the list above to see what matches its vibe.
                                    </Typography>
                                </>
                            )}
                        </Box>
                    )}

                    {/* --- EMPTY STATE: STANDARD --- */}
                    {currentTab !== 'semantic' && currentTab !== 'similar' && (
                        <>
                            <Typography variant="h6">No results found</Typography>
                            <Typography variant="body2" color="text.secondary">
                                {currentTab === 'liked' ? "You haven't liked any games yet." : "Try adjusting your filters."}
                            </Typography>
                        </>
                    )}
                </Box>
            )}
            
            {/* Show source game info for Similar tab if results exist */}
            {currentTab === 'similar' && similarSourceGame && !loading && visibleGames.length > 0 && (
                 <Typography variant="body2" color="text.secondary" align="center" sx={{ mb: 2, opacity: 0.8 }}>
                    Showing games similar to <b>{similarSourceGame.title}</b>
                </Typography>
            )}

            {/* Закреп: свежие авторские релизы едут в НАЧАЛЕ общей ленты (первыми
                в строке, с чипом ORIGINAL) — не отдельной полосой, чтобы одна игра
                не занимала весь первый ряд. Из хвоста ленты они убираются, дедуп. */}
            {feedGames.length > 0 && (
                <GameGrid
                    games={feedGames}
                    scores={currentTab === 'semantic' || currentTab === 'similar' ? semanticScores : undefined}
                    lastElementRef={lastGameElementRef}
                />
            )}

            {loading && visibleGames.length > 0 && <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}><CircularProgress size={24} /></Box>}
          </Box>

      </Container>
  );
}