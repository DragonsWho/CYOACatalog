// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid, useTheme } from '@mui/material'; // Use Grid instead of Grid2 if Grid2 isn't explicitly needed/installed
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameCard from '../GameCard'; // Ensure this import path is correct

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
  const theme = useTheme(); // Now used in JSX potentially (e.g., sx props)
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [tagMap, setTagMap] = useState<Map<string, Tag>>(new Map());
  const [tagsLoaded, setTagsLoaded] = useState(false);
  const [tagIdsProcessed, setTagIdsProcessed] = useState(false);
  const initialFetchInitiatedRef = useRef<boolean>(false);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);
  const [extremeTagId, setExtremeTagId] = useState<string | null>(null);

  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[],
    nsfwId: string | null,
    extremeId: string | null
  } | null>(null);

  // --- Data Processing Function ---
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
          setTagIdsProcessed(true);
      } else if (tagsLoaded) {
           setTagIdsProcessed(true);
      }
  }, [tagsLoaded, tagMap]);

  // --- Game Fetching Function ---
  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
        if (!tagsLoaded) {
             console.warn("[fetchGames] Attempted fetch before tags loaded.");
             setLoading(true);
             return;
        }
        console.log(`[fetchGames] Fetching page ${pageNum}, Reset: ${isReset}`);
        setLoading(true);

        try {
            // --- Filter logic ---
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
        }
    },
    [tagsLoaded, selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, extremeTagId, tagMap]
  );

  // --- useEffect Hooks ---

  // 1. Fetch and Cache Tags on Mount
  useEffect(() => {
      let isMounted = true;
      setTagIdsProcessed(false);
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
              setTagsLoaded(true);
          }
        } catch (error) {
            console.error('[Tags Effect] Error fetching/caching tags:', error);
             if(isMounted){
                setTagsLoaded(true);
                setTagIdsProcessed(true);
             }
        }
      })();
      return () => { isMounted = false; };
  }, []);

  // 2. Initial Fetch Trigger
  useEffect(() => {
      if (tagsLoaded && tagIdsProcessed && !initialFetchInitiatedRef.current) {
          console.log("[Initial Fetch] Tags and IDs processed, initiating first fetch.");
          initialFetchInitiatedRef.current = true;
          setPage(1);
          fetchGames(1, true);

          const currentBlockedIds = blockedTags.map(t => t.id).sort();
          const sortedTags = [...selectedTags].sort();
          const sortedAuthors = [...selectedAuthors].sort();
           prevFiltersRef.current = JSON.parse(JSON.stringify({
              tags: sortedTags, authors: sortedAuthors, mode: filterMode,
              blocked: currentBlockedIds, nsfwId: nsfwTagId, extremeId: extremeTagId
           }));
      } else if (!tagsLoaded && !initialFetchInitiatedRef.current) {
          setLoading(true);
      }
  }, [tagsLoaded, tagIdsProcessed, fetchGames]);

  // 3. Handle Filter Changes (After Initial Load)
  useEffect(() => {
      if (!initialFetchInitiatedRef.current) {
          return;
      }

      const currentBlockedIds = blockedTags.map(t => t.id).sort();
      const sortedTags = [...selectedTags].sort();
      const sortedAuthors = [...selectedAuthors].sort();
      const currentFilters = {
          tags: sortedTags, authors: sortedAuthors, mode: filterMode,
          blocked: currentBlockedIds, nsfwId: nsfwTagId, extremeId: extremeTagId
      };
      const currentFiltersString = JSON.stringify(currentFilters);

      if (prevFiltersRef.current === null) {
          return;
      }

      if (currentFiltersString === JSON.stringify(prevFiltersRef.current)) {
          return;
      }

      console.log("[Filter Change] Filters changed, fetching page 1.");
      prevFiltersRef.current = JSON.parse(currentFiltersString);
      setPage(1);
      setHasMore(true);
      fetchGames(1, true);

  }, [selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, extremeTagId, fetchGames]);

  // 4. Infinite Scroll - Fetch More Games when page number increases
  useEffect(() => {
    if (page > 1 && hasMore && !loading && initialFetchInitiatedRef.current) {
      console.log(`[Infinite Scroll] Fetching page ${page}`);
      fetchGames(page, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // --- Intersection Observer for Infinite Scroll Trigger ---
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => { // Now used in JSX
     if (loading || !hasMore) {
         if (observer.current) observer.current.disconnect();
         return;
     }
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loading) {
        setPage(p => p + 1);
      }
    }, { threshold: 0.1 });
    if (node) {
        observer.current.observe(node);
    }
  }, [loading, hasMore]);

  // Memoize games array for performance
  const memoizedGames = useMemo(() => games, [games]); // Now used in JSX
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  // --- Render Component --- // <-- THIS WAS MISSING BEFORE
  return (
      <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
          <Typography
              variant="h3" component="h1"
              sx={{
                mt: -4, mb: 3, textAlign: 'center',
                fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },
                // Example of using theme directly or custom properties if defined
                 ...(theme.custom?.cardTitle || { fontWeight: 'bold' }),
              }} >
              {isSearchActive ? 'Search Results' : 'Recent Uploads'}
          </Typography>

          {/* Initial Loading Spinner */}
          {loading && games.length === 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}><CircularProgress /></Box>
          )}

          {/* Games Grid */}
          {games.length > 0 && (
              // Using MUI Grid v1 syntax here. If you use v2 (Grid2), replace Grid with Grid2
              <Grid container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
                  {memoizedGames.map((game, index) => (
                     // Adjust column sizes as needed (xs, sm, md, lg)
                     // Example: 5 columns on lg, 4 on md, 3 on sm, 1 on xs
                     <Grid item xs={12} sm={6} md={4} lg={2.4} // lg={2.4} means 5 columns (12 / 2.4 = 5)
                       key={`search-${game.id}-${index}`} // Make sure key is stable and unique
                       // Assign ref to the last element for infinite scroll trigger
                       ref={index === memoizedGames.length - 1 ? lastGameElementRef : null}
                     >
                       <GameCard game={game} variant="standard"/> {/* Using GameCard */}
                     </Grid>
                   ))}
              </Grid>
          )}

           {/* Infinite Scroll Loading Spinner (at the bottom) */}
          {loading && games.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}><CircularProgress size={30} /></Box>
          )}

          {/* End of List Message */}
          {!loading && !hasMore && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
          )}

          {/* No Results Message */}
          {!loading && games.length === 0 && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
                  {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'}
              </Typography>
          )}
      </Box>
  );
}