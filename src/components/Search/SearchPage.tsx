// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
// Убедитесь, что Tag и Game импортированы правильно и содержат нужные поля
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../App'; // Убедитесь, что путь правильный
import GameCard from '../GameCard'; // Убедитесь, что путь правильный

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

interface SearchPageProps {
  selectedTags: string[];
  selectedAuthors: string[];
  filterMode: FilterMode;
  blockedTags: Tag[];
}

export default function SearchPage({
  selectedTags,
  selectedAuthors,
  filterMode,
  blockedTags,
}: SearchPageProps) {
  const theme = useTheme();
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const initialFetchPerformedRef = useRef<boolean>(false);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);

  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[]
  } | null>(null);

  // Effect to find NSFW tag ID once tags are loaded
  useEffect(() => {
    if (tagsLoaded && tagMap.size > 0) {
      let foundNsfwId: string | null = null;
      for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'nsfw') {
          foundNsfwId = id;
          break;
        }
      }
      setNsfwTagId(foundNsfwId);
      if (!foundNsfwId && tagsLoaded) console.warn("[Tag ID Finder] NSFW tag ID not found in loaded tagMap!");
    }
  }, [tagsLoaded, tagMap]);

  // --- fetchGames Function ---
  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
      // Check if we can fetch based on loaded tags and NSFW ID availability if needed
      const canFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

      if (!canFetch) {
        // Keep loading spinner if waiting for dependent data (like NSFW tag ID)
        if (tagsLoaded && nsfwFilterActive && nsfwTagId === null) {
            setLoading(true);
        }
        return;
      }

      setLoading(true);

      try {
        // --- Filter logic ---
        const filterConditions: string[] = [];
        const blockedTagIds = blockedTags.map(tag => tag.id);

        const positiveSelectedTags: string[] = [];
        const negativeSelectedTagNames: string[] = [];
        selectedTags.forEach(tag => {
            if (tag.startsWith('-')) {
                const baseTagName = tag.substring(1);
                if (baseTagName) negativeSelectedTagNames.push(baseTagName);
            } else {
                positiveSelectedTags.push(tag);
            }
        });

        // Positive Tags (AND logic)
        if (positiveSelectedTags.length > 0) {
          const positiveTagIds = Array.from(tagMap.entries())
            .filter(([_, tag]) => positiveSelectedTags.includes(tag.name))
            .map(([id, _]) => id);
          if (positiveTagIds.length === positiveSelectedTags.length) { // Ensure all selected tags were found
             const tagConditions = positiveTagIds.map(id => `tags ~ "${id}"`);
             filterConditions.push(...tagConditions);
          } else {
             console.warn("Some selected positive tags were not found in tagMap. Applying impossible filter.");
             filterConditions.push('(1=0)'); // Force no results if not all tags are valid
          }
        }

        // Authors (OR logic)
        if (selectedAuthors.length > 0) {
          const authorConditions = selectedAuthors.map((author) => `authors_via_games.name ?~ "${author.replace(/"/g, '\\"')}"`);
          filterConditions.push(`(${authorConditions.join(' || ')})`);
        }

        // SFW/NSFW Mode
        if (filterMode === 'sfw') {
          if (nsfwTagId) { filterConditions.push(`tags.id != "${nsfwTagId}"`); }
          else { console.warn("SFW mode active, but NSFW tag ID not found."); }
        } else if (filterMode === 'nsfw') {
           if (nsfwTagId) { filterConditions.push(`tags ~ "${nsfwTagId}"`); }
           else { console.warn("NSFW mode active, but NSFW tag ID not found. Applying impossible filter."); filterConditions.push('(1=0)'); }
        }

        // Negative Tags (AND NOT logic)
        if (negativeSelectedTagNames.length > 0) {
            const negativeTagIds = Array.from(tagMap.entries())
                .filter(([_, tag]) => negativeSelectedTagNames.includes(tag.name))
                .map(([id, _]) => id);
             if (negativeTagIds.length > 0) {
                 const negativeConditions = negativeTagIds.map(id => `tags.id != "${id}"`);
                 filterConditions.push(...negativeConditions);
             }
             // Warn if some negative tags weren't found, but don't block results
             if (negativeTagIds.length !== negativeSelectedTagNames.length) { console.warn("Some negative tags not found in map."); }
        }

        // Blocked Tags (AND NOT logic, excluding those already filtered by negative tags)
        if (blockedTagIds.length > 0) {
          const negativeTagIdsSet = new Set(Array.from(tagMap.entries())
             .filter(([_, tag]) => negativeSelectedTagNames.includes(tag.name))
             .map(([id, _]) => id));
          const finalBlockedIds = blockedTagIds.filter(blockedId => !negativeTagIdsSet.has(blockedId));
          if (finalBlockedIds.length > 0) {
              const blockedConditions = finalBlockedIds.map(id => `tags.id != "${id}"`);
              filterConditions.push(...blockedConditions);
          }
        }
        // --- End of Filter logic ---






        // ... (filter logic) ...
        const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';

        // Указываем expand для разрешения доступа к полям
        const expandRelations = 'authors_via_games,tags,tags.tag_categories_via_tags';

        // *** Оставляем ТОЛЬКО используемые поля, согласно вашему тесту ***
        const fieldsToFetch = [
            // Базовые поля игры
            'id',
            'title',
            'description', // Оставляем, вероятно нужно на странице игры
            'image',
            'image_base64',
            'upvotes_count',
            'comments_count',
            'authors', // ID авторов для связи с expand

            // Поля из развернутых авторов
            'expand.authors_via_games.name', // Имя автора

            // Поля из развернутых тегов
            'expand.tags.name', // Имя тега

            // Поля из развернутых категорий ВНУТРИ тегов
            'expand.tags.expand.tag_categories_via_tags.name', // Имя категории
        ].join(',');

        // Fetch games
        const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
          sort: '-created',
          expand: expandRelations,
          filter: filterString,
          fields: fieldsToFetch, // Используем уточненный список полей
        });

        // Пост-обработка для гарантии структуры массивов (остается)
        const gamesFromApi = fetchedGamesResult.items.map(game => {
            const expandData = game.expand || {};
            // Явно проверяем наличие tags и authors_via_games в expandData после запроса с fields
            const tagsData = expandData.tags;
            const authorsData = expandData.authors_via_games;
            return {
                ...game,
                expand: {
                    // Копируем только то, что есть в expandData
                    ...(expandData.authors_via_games && { authors_via_games: Array.isArray(authorsData) ? authorsData : (authorsData ? [authorsData] : []) }),
                    ...(expandData.tags && { tags: Array.isArray(tagsData) ? tagsData : (tagsData ? [tagsData] : []) }),
                }
            };
        });







        // Update game state
        setGames((prevGames) => {
          const newGames = isReset ? gamesFromApi : [...prevGames, ...gamesFromApi];
          // Deduplicate just in case
          return Array.from(new Map(newGames.map((game) => [game.id, game])).values());
        });

        setHasMore(fetchedGamesResult.items.length === ITEMS_PER_PAGE);

      } catch (error: any) {
        console.error('[fetchGames] Error fetching games:', error);
        if (error?.data?.message) { console.error("Pocketbase Error Details:", error.data.message); }
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    // Dependencies for fetchGames useCallback
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId]
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount
  useEffect(() => {
    let isMounted = true;
    setLoading(true); // Show loading initially
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap');
        const lastUpdated = localStorage.getItem('tagMapLastUpdated');
        const now = Date.now();
        let newTagMap: Map<string, Tag>;
        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
            newTagMap = new Map(JSON.parse(cachedTags));
        } else {
            const fetchedTags = await tagsCollection.getFullList(500, { fields: 'id,name', sort: 'name' });
            const tagsTyped = fetchedTags.map(tag => tag as unknown as Tag);
            newTagMap = new Map(tagsTyped.map((tag) => [tag.id, tag]));
            localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
            localStorage.setItem('tagMapLastUpdated', now.toString());
        }
        if (isMounted) {
            setTagMap(newTagMap);
            setTagsLoaded(true); // Mark tags as loaded
        }
      } catch (error) {
        console.error('[useEffect tags] Error loading tags:', error);
        if (isMounted) {
            setTagsLoaded(true); // Still mark as loaded to allow continuation
            setLoading(false); // Stop loading if tags fail
        }
      }
      // Note: setLoading(false) is handled by fetchGames after its attempt
    })();
    return () => { isMounted = false; };
  }, []); // Run only once on mount

  // 2. Initial Game Fetch (triggered by tagsLoaded/filter readiness)
  useEffect(() => {
    const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
    const readyToFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null) || (!nsfwFilterActive));

    if (readyToFetch && !initialFetchPerformedRef.current) {
      initialFetchPerformedRef.current = true;
      fetchGames(1, true); // Fetch page 1, reset
    }
    // Dependencies correctly trigger re-check when ready
  }, [tagsLoaded, filterMode, nsfwTagId, fetchGames]);


  // 3. Handle Filter Changes (after initial load is done)
  useEffect(() => {
    // Guard against running before initial load or tag load
    if (!initialFetchPerformedRef.current || !tagsLoaded) {
      return;
    }

    const currentBlockedIds = blockedTags.map(t => t.id).sort();
    const sortedSelectedTags = [...selectedTags].sort();
    const sortedSelectedAuthors = [...selectedAuthors].sort();
    const currentFilters = {
      tags: sortedSelectedTags,
      authors: sortedSelectedAuthors,
      mode: filterMode,
      blocked: currentBlockedIds,
    };

    // Initialize ref on first run *after* initial load
    if (prevFiltersRef.current === null ) {
       prevFiltersRef.current = currentFilters;
       return;
    }

    // Check if any filter criteria changed
    const tagsChanged = JSON.stringify(sortedSelectedTags) !== JSON.stringify(prevFiltersRef.current.tags);
    const authorsChanged = JSON.stringify(sortedSelectedAuthors) !== JSON.stringify(prevFiltersRef.current.authors);
    const modeChanged = filterMode !== prevFiltersRef.current.mode;
    const blockedChanged = JSON.stringify(currentBlockedIds) !== JSON.stringify(prevFiltersRef.current.blocked);
    const hasMeaningfulChange = tagsChanged || authorsChanged || modeChanged || blockedChanged;

    if (hasMeaningfulChange) {
      prevFiltersRef.current = currentFilters; // Update previous filters
      setPage(1);         // Reset page
      setHasMore(true);     // Assume more results possible
      // setGames([]); // Optional immediate clear for better UX on filter change
      fetchGames(1, true); // Refetch with reset
    }
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames]); // Dependencies include all filter inputs and fetch function

  // 4. Infinite Scroll - Fetch More Games on Page Change
  useEffect(() => {
    // Fetch next page if page changed, more exist, not loading, and initial load done
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      fetchGames(page, false); // Fetch next page, append
    }
  }, [page, hasMore, loading, initialFetchPerformedRef, fetchGames]); // Dependencies include pagination state and fetch function

  // --- Intersection Observer for Infinite Scroll ---
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading || !hasMore) return; // Don't observe if loading or no more data
      if (observer.current) observer.current.disconnect(); // Disconnect old observer

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
           setPage((prevPage) => prevPage + 1); // Request next page when last element is visible
        }
      });

      if (node) observer.current.observe(node); // Observe the new last element
    },
    [loading, hasMore], // Recreate callback if loading/hasMore changes
  );

  // Memoize games array for performance
  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component ---
  return (
    <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
      <Typography
        variant="h3" component="h1"
        sx={{ mt: -4, mb: 3, textAlign: 'center', fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },
          
          ...(theme.custom?.cardTitle || { fontWeight: 'bold' }),
        }} >
        {isSearchActive ? 'Search Results' : 'Recent Uploads'}
      </Typography>

      {/* Initial Loading */}
      {loading && games.length === 0 && (
         <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}> <CircularProgress /> </Box>
      )}

      {/* Game Grid */}
      {games.length > 0 && (
        <Grid2 container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
            {memoizedGames.map((game, index) => (
                <Grid2
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                    key={`search-${game.id}-${index}`} // Using index helps with potential temporary key issues during loading
                    ref={index === memoizedGames.length - 1 ? lastGameElementRef : null} // Attach observer ref to the last item
                >
                    {/* Pass the game object, now confirmed to have the correct expand structure */}
                    <GameCard game={game} variant="standard"/>
                </Grid2>
            ))}
        </Grid2>
      )}

      {/* Subsequent Page Loading Indicator */}
      {loading && games.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}> <CircularProgress size={30} /> </Box>
      )}

      {/* End of Results Message */}
      {!loading && !hasMore && games.length > 0 && initialFetchPerformedRef.current && (
        <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
      )}

      {/* No Results Message */}
      {!loading && games.length === 0 && initialFetchPerformedRef.current && (
        <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
          {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available at the moment.'}
        </Typography>
      )}
    </Box>
  );
}