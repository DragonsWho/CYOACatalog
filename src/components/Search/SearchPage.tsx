// === File: src/components/Search/SearchPage.tsx ===

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Typography, CircularProgress, Grid2, useTheme } from '@mui/material';
import { Game, gamesCollection, tagsCollection, Tag } from '../../pocketbase/pocketbase';
import type { FilterMode } from '../../App';
import GameCard from '../GameCard';

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

  useEffect(() => {
    if (tagsLoaded && tagMap.size > 0) {
      let foundNsfwId: string | null = null;
      for (const [id, tag] of tagMap.entries()) {
        if (tag.name.toLowerCase() === 'nsfw') {
          foundNsfwId = id;
          break; // Found it, no need to continue
        }
      }
      setNsfwTagId(foundNsfwId);
      if (!foundNsfwId) console.warn("[Tag ID Finder] NSFW tag ID not found in tagMap!");
    }
  }, [tagsLoaded, tagMap]);

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
      const canFetch = tagsLoaded && (!nsfwFilterActive || nsfwTagId !== null);

      if (!canFetch) return;
      // Removed the !hasMore check here, let the effect hook handle it

      setLoading(true);

      try {
        const filterConditions: string[] = [];
        const blockedTagIds = blockedTags.map(tag => tag.id);

        const positiveSelectedTags: string[] = [];
        const negativeSelectedTagNames: string[] = [];
        selectedTags.forEach(tag => { if (tag.startsWith('-')) { const baseTagName = tag.substring(1); if (baseTagName) negativeSelectedTagNames.push(baseTagName); } else { positiveSelectedTags.push(tag); } });

        if (positiveSelectedTags.length > 0) {
          const positiveTagIds = Array.from(tagMap.entries())
            .filter(([_, tag]) => positiveSelectedTags.includes(tag.name))
            .map(([id, _]) => id);

          if (positiveTagIds.length > 0) {
             if (positiveTagIds.length !== positiveSelectedTags.length) {
                console.warn("Some selected positive tags were not found in tagMap.");
             }
             const tagConditions = positiveTagIds.map(id => `tags ~ "${id}"`);
             filterConditions.push(...tagConditions);
          } else {
            filterConditions.push('(1=0)'); // No matching tags found
          }
        }

        if (selectedAuthors.length > 0) {
          const authorConditions = selectedAuthors.map((author) => `authors_via_games.name ?~ "${author}"`);
          filterConditions.push(`(${authorConditions.join(' || ')})`);
        }

        if (filterMode === 'sfw') {
          if (nsfwTagId) {
              filterConditions.push(`tags.id != "${nsfwTagId}"`);
          } else {
              filterConditions.push('(1=0)');
          }
        } else if (filterMode === 'nsfw') {
           if (nsfwTagId) {
              filterConditions.push(`tags ~ "${nsfwTagId}"`);
           } else {
               filterConditions.push('(1=0)');
           }
        }

        if (negativeSelectedTagNames.length > 0) {
            const negativeTagIds = Array.from(tagMap.entries())
                .filter(([_, tag]) => negativeSelectedTagNames.includes(tag.name))
                .map(([id, _]) => id);

             if (negativeTagIds.length > 0) {
                 const negativeConditions = negativeTagIds.map(id => `tags.id != "${id}"`);
                 filterConditions.push(...negativeConditions);
             }
        }

        if (blockedTagIds.length > 0) {
          const finalBlockedIds = blockedTagIds.filter(blockedId =>
              !negativeSelectedTagNames.some(negName => tagMap.get(blockedId)?.name === negName)
          );
          if (finalBlockedIds.length > 0) {
              const blockedConditions = finalBlockedIds.map(id => `tags.id != "${id}"`);
              filterConditions.push(...blockedConditions);
          }
        }

        const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
        const fieldsToFetch = 'id,collectionId,title,description,image,image_base64,tags,expand.authors_via_games.name,upvotes_count,comments_count';

        const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
          sort: '-created',
          expand: 'authors_via_games',
          filter: filterString,
          fields: fieldsToFetch,
        });

        const enrichedGames = fetchedGamesResult.items.map((game) => {
          const gameTags = Array.isArray(game.tags) ? game.tags : [];
          const enrichedTags = gameTags
            .map((tagId) => tagMap.get(tagId))
            .filter((tag): tag is Tag => tag !== undefined);
          return { ...game, expand: { ...game.expand, tags: enrichedTags }, };
        });

        setGames((prevGames) => {
          const newGames = isReset ? enrichedGames : [...prevGames, ...enrichedGames];
          // Deduplicate
          return Array.from(new Map(newGames.map((game) => [game.id, game])).values());
        });

        // Update hasMore based on the *current* fetch
        setHasMore(fetchedGamesResult.items.length === ITEMS_PER_PAGE);

      } catch (error: any) {
        console.error('[fetchGames] Error fetching games:', error);
        setHasMore(false); // Assume no more on error
      } finally {
        setLoading(false);
      }
    },
    // Removed `hasMore` from dependencies
    [tagsLoaded, selectedTags, selectedAuthors, tagMap, filterMode, blockedTags, nsfwTagId]
  );

  // 1. Загрузка тегов
  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap');
        const lastUpdated = localStorage.getItem('tagMapLastUpdated');
        const now = Date.now();
        let newTagMap: Map<string, Tag>;

        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
            newTagMap = new Map(JSON.parse(cachedTags));
        } else {
            const fetchedTags = await tagsCollection.getFullList(500, {
              fields: 'id,name',
              sort: 'name'
            });
            const tagsTyped = fetchedTags.map(tag => tag as unknown as Tag);
            newTagMap = new Map(tagsTyped.map((tag) => [tag.id, tag]));
            localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
            localStorage.setItem('tagMapLastUpdated', now.toString());
        }

        if (isMounted) {
            setTagMap(newTagMap);
            setTagsLoaded(true);
        }
      } catch (error) {
        console.error('[useEffect tags] Error loading tags:', error);
        if (isMounted) {
            setTagsLoaded(true); // Still allow fetching games even if tags failed
            setLoading(false);
        }
      }
      // Removed setLoading(false) from successful path, let fetchGames handle it
    })();
    return () => { isMounted = false; };
  }, []);

  // 2. Начальная загрузка игр (вызывает fetchGames напрямую)
  useEffect(() => {
    const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
    const readyToFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null));

    if (readyToFetch && !initialFetchPerformedRef.current) {
      initialFetchPerformedRef.current = true; // Set ref BEFORE fetch
      fetchGames(1, true);
    } else if (tagsLoaded && nsfwFilterActive && nsfwTagId === null && !initialFetchPerformedRef.current) {
      setLoading(true); // Show loading while waiting for tag ID
    } else if (!tagsLoaded && !initialFetchPerformedRef.current) {
        setLoading(true); // Show loading while waiting for tags
    }
    // Removed fetchGames dependency
  }, [tagsLoaded, filterMode, nsfwTagId]);

  // 3. Обработка изменения фильтров (вызывает fetchGames напрямую)
  useEffect(() => {
    if (!initialFetchPerformedRef.current || !tagsLoaded) {
      return; // Don't run filter changes before initial load or tag load
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

    // Initialize ref on first run *after* initial load and tag load
    if (prevFiltersRef.current === null) {
       prevFiltersRef.current = currentFilters;
       return;
    }

    const tagsChanged = JSON.stringify(sortedSelectedTags) !== JSON.stringify(prevFiltersRef.current.tags);
    const authorsChanged = JSON.stringify(sortedSelectedAuthors) !== JSON.stringify(prevFiltersRef.current.authors);
    const modeChanged = filterMode !== prevFiltersRef.current.mode;
    const blockedChanged = JSON.stringify(currentBlockedIds) !== JSON.stringify(prevFiltersRef.current.blocked);

    const hasMeaningfulChange = tagsChanged || authorsChanged || modeChanged || blockedChanged;

    if (hasMeaningfulChange) {
      prevFiltersRef.current = currentFilters; // Update ref
      setPage(1);
      setHasMore(true);
      setGames([]); // Clear games immediately
      fetchGames(1, true);
    }
    // Removed fetchGames dependency
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded]);

  // 4. Бесконечная прокрутка (вызывает fetchGames напрямую)
  useEffect(() => {
    // Fetch next page only if page number increased, there might be more, not currently loading, and initial load happened
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      fetchGames(page, false);
    }
    // Removed fetchGames dependency
  }, [page, hasMore, loading]); // Depends on page, hasMore, loading

  // Intersection Observer
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading || !hasMore) return; // Don't attach if loading or no more items
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          // Only setPage if not loading and hasMore is true
          if (!loading && hasMore) {
             setPage((prevPage) => prevPage + 1);
          }
        }
      });

      if (node) observer.current.observe(node);
    },
    [loading, hasMore], // Depends only on loading and hasMore
  );

  const memoizedGames = useMemo(() => games, [games]);
  const isSearchActive = selectedTags.length > 0 || selectedAuthors.length > 0;
  const isFilterActive = filterMode !== 'all' || blockedTags.length > 0;

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography
        variant="h3"
        sx={{
          mt: -4,
          mb: 2,
          textAlign: 'center',
          // @ts-expect-error custom theme property
          ...theme.custom.cardTitle,
        }}
      >
        {isSearchActive ? 'Search Results' : 'Recent Uploads'}
      </Typography>

      {/* Initial loading indicator */}
      {loading && games.length === 0 && (
         <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
            <CircularProgress />
         </Box>
      )}

      {/* Game grid */}
      {games.length > 0 && (
        <Grid2 container spacing={2} justifyContent="center">
            {memoizedGames.map((game, index) => (
                <Grid2
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                    key={`search-${game.id}-${index}`} // Use index for potential duplicates during loading, though deduplication should prevent this
                    ref={index === memoizedGames.length - 1 ? lastGameElementRef : null} // Attach ref to the last element
                >
                    <GameCard game={game} variant="standard"/>
                </Grid2>
            ))}
        </Grid2>
      )}

      {/* Loading indicator for subsequent pages */}
      {loading && games.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2, height: 40 }}>
             <CircularProgress size={30} />
          </Box>
      )}

      {/* End of results message */}
      {!loading && !hasMore && games.length > 0 && initialFetchPerformedRef.current && (
        <Typography sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
            No more games to load
        </Typography>
      )}

      {/* No results message */}
      {!loading && games.length === 0 && initialFetchPerformedRef.current && (
        <Typography sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
          {isSearchActive || isFilterActive
              ? 'No games found matching your criteria'
              : 'No games available'
          }
        </Typography>
      )}
    </Box>
  );
}