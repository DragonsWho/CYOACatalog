// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameCard from '../GameCard';

const ITEMS_PER_PAGE = 25;
const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;

// REMOVED: declare global block for __INITIAL_DATA__

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
  // Start loading initially, as there's no preload anymore
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);
  // Tracks if the *very first* fetch has been initiated or completed
  const initialFetchInitiatedRef = useRef<boolean>(false);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);
  const [extremeTagId, setExtremeTagId] = useState<string | null>(null);

  // Stores the previous filters to compare against for refetching
  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[],
    nsfwId: string | null,
    extremeId: string | null
  } | null>(null);

  // --- Data Processing Function ---
  // (No changes needed in this function)
  const processGameData = (items: any[]): Game[] => {
      return items.map(game => {
          const expandData = game.expand || {};
          const tagsData = expandData.tags;
          const authorsData = expandData.authors_via_games;
          return {
              ...game,
              expand: {
                  ...(expandData.authors_via_games && { authors_via_games: Array.isArray(authorsData) ? authorsData : (authorsData ? [authorsData] : []) }),
                  ...(expandData.tags && { tags: Array.isArray(tagsData) ? tagsData : (tagsData ? [tagsData] : []) }),
              }
          } as Game;
      });
  };

  // --- Effect to find NSFW and Extreme tag IDs ---
  // (No changes needed in this effect)
  useEffect(() => {
      if (tagsLoaded && tagMap.size > 0) {
          let foundNsfwId: string | null = null;
          let foundExtremeId: string | null = null;
          for (const [id, tag] of tagMap.entries()) {
              const lowerCaseName = tag.name.toLowerCase();
              if (lowerCaseName === 'nsfw') foundNsfwId = id;
              else if (lowerCaseName === 'extreme') foundExtremeId = id;
              if (foundNsfwId && foundExtremeId) break;
          }
          setNsfwTagId(foundNsfwId);
          setExtremeTagId(foundExtremeId);
      }
  }, [tagsLoaded, tagMap]);

  // --- Game Fetching Function ---
  // (No changes needed in this function itself)
  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
        if (!tagsLoaded) {
            console.warn("[fetchGames] Attempted fetch before tags loaded.");
            setLoading(true); // Keep loading state if called prematurely
            return;
        }
        console.log(`[fetchGames] Fetching page ${pageNum}, Reset: ${isReset}`);
        setLoading(true);

        try {
            // --- Filter logic (Server-side) ---
            const filterConditions: string[] = [];
            const blockedTagIds = blockedTags.map(tag => tag.id);
            const positiveSelectedTags: string[] = [];
            const negativeSelectedTagNames: string[] = [];

            selectedTags.forEach(tag => { if (tag.startsWith('-')) { const n = tag.substring(1); if(n) negativeSelectedTagNames.push(n); } else { positiveSelectedTags.push(tag); } });

            if (positiveSelectedTags.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([_,t])=>positiveSelectedTags.includes(t.name)).map(([id,_])=>id);
                if (ids.length === positiveSelectedTags.length) { filterConditions.push(...ids.map(id=>`tags ~ "${id}"`)); }
                else { filterConditions.push('(1=0)'); }
            }
            if (selectedAuthors.length > 0) { filterConditions.push(`(${selectedAuthors.map(a => `authors_via_games.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`); }

            if (filterMode === 'sfw') {
                const sfwConditions: string[] = [];
                if (nsfwTagId) sfwConditions.push(`tags.id != "${nsfwTagId}"`);
                if (extremeTagId) sfwConditions.push(`tags.id != "${extremeTagId}"`);
                if (sfwConditions.length > 0) filterConditions.push(`(${sfwConditions.join(' && ')})`);
            }
            else if (filterMode === 'nsfw') {
                const nsfwOrExtremeConditions: string[] = [];
                if (nsfwTagId) nsfwOrExtremeConditions.push(`tags ~ "${nsfwTagId}"`);
                if (extremeTagId) nsfwOrExtremeConditions.push(`tags ~ "${extremeTagId}"`);
                if (nsfwOrExtremeConditions.length > 0) filterConditions.push(`(${nsfwOrExtremeConditions.join(' || ')})`);
                else { filterConditions.push('(1=0)'); }
            }

            if (negativeSelectedTagNames.length > 0) {
                const ids = Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id);
                if (ids.length > 0) filterConditions.push(...ids.map(id => `tags.id != "${id}"`));
            }
            if (blockedTagIds.length > 0) {
                const negativeTagIds = new Set(Array.from(tagMap.entries()).filter(([_,t])=>negativeSelectedTagNames.includes(t.name)).map(([id,_])=>id));
                const sfwModeActive = filterMode === 'sfw';
                const restrictedTagIds = new Set<string>();
                if (sfwModeActive) {
                    if (nsfwTagId) restrictedTagIds.add(nsfwTagId);
                    if (extremeTagId) restrictedTagIds.add(extremeTagId);
                }
                const finalBlocked = blockedTagIds.filter(bId => !negativeTagIds.has(bId) && !(sfwModeActive && restrictedTagIds.has(bId)));
                if (finalBlocked.length > 0) filterConditions.push(...finalBlocked.map(id => `tags.id != "${id}"`));
            }
            // --- End Server Filter ---
            const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
            const expandRelations = 'authors_via_games,tags,tags.tag_categories_via_tags';
            const fieldsToFetch = ['id','title','description','image','image_base64','upvotes_count','comments_count','authors','expand.authors_via_games.name','expand.tags.id','expand.tags.name','expand.tags.expand.tag_categories_via_tags.name'].join(',');

            const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, { sort: '-created', expand: expandRelations, filter: filterString, fields: fieldsToFetch });
            const gamesFromApi = processGameData(fetchedGamesResult.items);

            setGames((prevGames) => {
                 const newGames = isReset ? gamesFromApi : [...prevGames, ...gamesFromApi];
                 const uniqueGames = Array.from(new Map(newGames.map(g => [g.id, g])).values());
                 return uniqueGames;
             });
            setHasMore(fetchedGamesResult.items.length === ITEMS_PER_PAGE);

        } catch (error: any) {
            console.error(`[fetchGames] API call FAILED for page ${pageNum}:`, error);
            setHasMore(false);
        } finally {
            setLoading(false);
             // Mark initial fetch as done *after* the first fetch completes (or fails)
             // if (isReset) initialFetchPerformedRef.current = true; // Moved this logic
        }
    },
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, extremeTagId, tagMap]
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount
  // (No changes needed in this effect)
  useEffect(() => {
      let isMounted = true;
      (async () => {
        try {
          const cachedTags = localStorage.getItem('tagMap');
          const lastUpdated = localStorage.getItem('tagMapLastUpdated');
          const now = Date.now();
          let newTagMap: Map<string, Tag>;
          if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
              newTagMap = new Map(JSON.parse(cachedTags));
          } else {
              const fullTagList = await tagsCollection.getFullList<Tag>(500, { fields: 'id,name', sort: 'name' });
              newTagMap = new Map(fullTagList.map(t => [t.id, t]));
              localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
              localStorage.setItem('tagMapLastUpdated', now.toString());
          }
          if (isMounted) {
              setTagMap(newTagMap);
              setTagsLoaded(true); // Set tagsLoaded here
          }
        } catch (error) {
            console.error('[Tags Effect] Error fetching/caching tags:', error);
             if(isMounted){
                setTagsLoaded(true); // Still set loaded on error to unblock other effects
                // Keep loading true if tags fail, initial fetch won't run
             }
        }
      })();
      return () => { isMounted = false; };
  }, []);

  // 2. Initial Fetch Trigger (Replaces Initial Data Handling)
  useEffect(() => {
      // Conditions: Tags must be loaded AND the initial fetch hasn't been initiated yet.
      if (tagsLoaded && !initialFetchInitiatedRef.current) {
          console.log("[Initial Fetch] Tags loaded, initiating first fetch.");
          initialFetchInitiatedRef.current = true; // Mark as initiated to prevent re-triggering
          setPage(1); // Ensure we fetch page 1
          fetchGames(1, true); // Fetch the first page with reset flag

          // Store initial filters when the first fetch is triggered
          const currentBlockedIds = blockedTags.map(t => t.id).sort();
          const sortedTags = [...selectedTags].sort();
          const sortedAuthors = [...selectedAuthors].sort();
           prevFiltersRef.current = JSON.parse(JSON.stringify({
              tags: sortedTags, authors: sortedAuthors, mode: filterMode,
              blocked: currentBlockedIds, nsfwId: nsfwTagId, extremeId: extremeTagId
           }));
      } else if (!tagsLoaded && !initialFetchInitiatedRef.current) {
          // Optional: Keep loading indicator true while waiting for tags
          setLoading(true);
      }
  // Dependencies: Run when tagsLoaded changes, or potentially filterMode/IDs change *before* the first fetch is initiated
  // fetchGames is included because it's called inside.
  }, [tagsLoaded, filterMode, nsfwTagId, extremeTagId, blockedTags, selectedTags, selectedAuthors, fetchGames]);


  // 3. Handle Filter Changes (After Initial Load)
  useEffect(() => {
      // Wait for the initial fetch to have been *initiated* and tags to be ready.
      // We use initialFetchInitiatedRef instead of checking games.length to handle cases
      // where the first fetch might return 0 results but still needs subsequent filters applied.
      if (!initialFetchInitiatedRef.current || !tagsLoaded) {
           // console.log("[Filter Change] Skipping, initial fetch not initiated or tags not loaded.");
          return;
      }

      // Prepare current filter state for comparison
      const currentBlockedIds = blockedTags.map(t => t.id).sort();
      const sortedTags = [...selectedTags].sort();
      const sortedAuthors = [...selectedAuthors].sort();
      const currentFilters = {
          tags: sortedTags, authors: sortedAuthors, mode: filterMode,
          blocked: currentBlockedIds, nsfwId: nsfwTagId, extremeId: extremeTagId
      };
      const currentFiltersString = JSON.stringify(currentFilters);

      // If prevFiltersRef is still null here, it means the initial fetch effect hasn't stored it yet
      // (or is in progress), so we wait.
      if (prevFiltersRef.current === null) {
           // console.log("[Filter Change] Skipping, prevFiltersRef is null (initial fetch likely in progress).");
          return;
      }

      // If filters haven't changed since the last fetch (initial or subsequent), do nothing
      if (currentFiltersString === JSON.stringify(prevFiltersRef.current)) {
           // console.log("[Filter Change] Skipping, filters haven't changed.");
          return;
      }

      // Filters HAVE changed: update ref, reset page, and fetch page 1
      console.log("[Filter Change] Filters changed, fetching page 1.");
      prevFiltersRef.current = JSON.parse(currentFiltersString);
      setPage(1);
      setHasMore(true); // Assume new filters might have more results
      fetchGames(1, true); // Fetch with reset flag

  // Dependencies: React to changes in any filter input or resolved tag IDs.
  // fetchGames is included because it's called inside. tagsLoaded ensures tagMap is ready.
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames, nsfwTagId, extremeTagId]);


  // 4. Infinite Scroll - Fetch More Games when page number increases
  useEffect(() => {
    // Fetch more only if page > 1, hasMore is true, not currently loading, and initial fetch was initiated.
    if (page > 1 && hasMore && !loading && initialFetchInitiatedRef.current) {
      console.log(`[Infinite Scroll] Fetching page ${page}`);
      fetchGames(page, false); // Fetch with append flag
    }
  // Only trigger explicitly on 'page' changes for subsequent pages.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]); // Dependencies: fetchGames, hasMore, loading, initialFetchInitiatedRef are checked inside


  // --- Intersection Observer for Infinite Scroll Trigger ---
  // (No changes needed in this callback)
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
     if (loading || !hasMore) {
         if (observer.current) observer.current.disconnect();
         return;
     }
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loading) { // Add !loading check here too
        setPage(p => p + 1);
      }
    }, { threshold: 0.1 });
    if (node) {
        observer.current.observe(node);
    }
  }, [loading, hasMore]);

  // Memoize games array for performance
  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component ---
  // (No changes needed in the JSX return)
  return (
      <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
          <Typography variant="h3" component="h1" sx={{ mt: -4, mb: 3, textAlign: 'center', fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },   ...(theme.custom?.cardTitle || { fontWeight: 'bold' }), }} >
              {isSearchActive ? 'Search Results' : 'Recent Uploads'}
          </Typography>
          {/* Show spinner initially OR when loading more games */}
          {loading && games.length === 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}><CircularProgress /></Box>
          )}
          {games.length > 0 && (
              <Grid2 container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
                  {memoizedGames.map((game, index) => (
                     <Grid2
                       size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                       key={`search-${game.id}-${index}`} // Use stable key if possible
                       ref={index === memoizedGames.length - 1 ? lastGameElementRef : null}
                     >
                       <GameCard game={game} variant="standard"/>
                     </Grid2>
                   ))}
              </Grid2>
          )}
           {/* Spinner shown at bottom only when loading more pages (loading=true AND games already exist) */}
          {loading && games.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}><CircularProgress size={30} /></Box>
          )}
          {/* End of List Message: Show only if not loading, there's no more data, and initial fetch *was* initiated */}
          {!loading && !hasMore && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
          )}
          {/* No Results Message: Show if not loading, no games rendered, and initial fetch *was* initiated */}
          {!loading && games.length === 0 && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
                  {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'}
              </Typography>
          )}
      </Box>
  );
}