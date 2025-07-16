// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../types';
import GameCard from '../GameCard';
import AdCard from '../AdCard';

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
  const [tagIdsProcessed, setTagIdsProcessed] = useState(false);
  const initialFetchInitiatedRef = useRef<boolean>(false);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);
  const [extremeTagId, setExtremeTagId] = useState<string | null>(null);
  const [adPosition, setAdPosition] = useState<number>(-1);

  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[],
    nsfwId: string | null,
    extremeId: string | null
  } | null>(null);





  const generateRandomAdPosition = () => {
      const minIndex = 99999;
      const maxIndex = 9999910;
      const randomAdIndex = Math.floor(Math.random() * (maxIndex - minIndex + 1)) + minIndex;
      setAdPosition(randomAdIndex);
      console.log(`[Ad] New random ad position set to index: ${randomAdIndex}`);
  };







  

  const processGameData = (items: any[]): Game[] => {
      return items.map(game => {
          const expandData = game.expand || {};
          const tagsData = expandData.tags;
          const authorsData = expandData.authors;
          return {
              ...game,
              expand: {
                  ...(expandData.authors && { authors: Array.isArray(authorsData) ? authorsData : (authorsData ? [authorsData] : []) }),
                  ...(expandData.tags && { tags: Array.isArray(tagsData) ? tagsData : (tagsData ? [tagsData] : []) }),
              }
          } as Game;
      });
  };

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
            if (selectedAuthors.length > 0) { filterConditions.push(`(${selectedAuthors.map(a => `authors.name ?~ "${a.replace(/"/g, '\\"')}"`).join(' || ')})`); }

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

            const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
            const expandRelations = 'authors,tags,tags.tag_categories_via_tags';

            const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
                sort: '-created',
                expand: expandRelations,
                filter: filterString
            });
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

  useEffect(() => {
      if (tagsLoaded && tagIdsProcessed && !initialFetchInitiatedRef.current) {
          console.log("[Initial Fetch] Tags and IDs processed, initiating first fetch.");
          initialFetchInitiatedRef.current = true;
          setPage(1);
          
          generateRandomAdPosition();
          
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
      // [ИСПРАВЛЕНИЕ] Заменил `extremeId` на `extremeTagId` в массиве зависимостей
  }, [tagsLoaded, tagIdsProcessed, fetchGames, blockedTags, extremeTagId, filterMode, nsfwTagId, selectedAuthors, selectedTags]);

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

      generateRandomAdPosition();
      
      fetchGames(1, true);

  }, [selectedTags, selectedAuthors, filterMode, blockedTags, nsfwTagId, extremeTagId, fetchGames]);

  useEffect(() => {
    if (page > 1 && hasMore && !loading && initialFetchInitiatedRef.current) {
      console.log(`[Infinite Scroll] Fetching page ${page}`);
      fetchGames(page, false);
    }
  }, [page, hasMore, loading, fetchGames]);

  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback((node: HTMLElement | null) => {
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

  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  return (
      <Box sx={{ width: '100%', p: { xs: 1, sm: 2, md: 3 } }}>
          <Typography
              variant="h3" component="h1"
              sx={{
                mt: -4, mb: 3, textAlign: 'center',
                fontSize: { xs: '1.8rem', sm: '2.2rem', md: '2.5rem' },
                 ...(theme.custom?.cardTitle || { fontWeight: 'bold' }),
              }} >
              {isSearchActive ? 'Search Results' : 'Recent Uploads'}
          </Typography>

          {loading && games.length === 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4, mb: 4 }}><CircularProgress /></Box>
          )}

          {games.length > 0 && (
              <Grid container spacing={{ xs: 1, sm: 2 }} justifyContent="center">
                  {memoizedGames.map((game, index) => {
                     
                     const isAdSpot = index === adPosition;

                     if (isAdSpot) {
                        const adId = `ad-container-${index}`;
                        return (
                          <Grid item xs={12} sm={6} md={4} lg={2.4}
                            key={adId}
                          >
                            <AdCard adId={adId} />
                          </Grid>
                        );
                     }

                     return (
                       <Grid item xs={12} sm={6} md={4} lg={2.4}
                         key={`search-${game.id}-${index}`}
                         ref={index === memoizedGames.length - 1 ? lastGameElementRef : null}
                       >
                         <GameCard game={game} variant="standard"/>
                       </Grid>
                     );
                  })}
              </Grid>
          )}

          {loading && games.length > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3, height: 40, mb: 2 }}><CircularProgress size={30} /></Box>
          )}

          {!loading && !hasMore && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 3, mb: 2, textAlign: 'center', color: 'text.secondary' }}> You've reached the end! </Typography>
          )}

          {!loading && games.length === 0 && initialFetchInitiatedRef.current && (
              <Typography sx={{ mt: 4, textAlign: 'center', color: 'text.secondary' }}>
                  {isSearchActive || isFilterActive ? 'No games found matching your criteria.' : 'No games available.'}
              </Typography>
          )}
      </Box>
  );
}