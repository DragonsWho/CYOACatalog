// src/components/Search/SearchPage.tsx
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

  // --- УДАЛЕНО СОСТОЯНИЕ sfwTagId ---
  // const [sfwTagId, setSfwTagId] = useState<string | null>(null);
  const [nsfwTagId, setNsfwTagId] = useState<string | null>(null);

  const prevFiltersRef = useRef<{
    tags: string[],
    authors: string[],
    mode: FilterMode,
    blocked: string[]
  } | null>(null);

  // Находим ID для nsfw тега после загрузки tagMap
  useEffect(() => {
    if (tagsLoaded && tagMap.size > 0) {
      // --- УДАЛЕНА ЛОГИКА ДЛЯ sfwTagId ---
      // let foundSfwId: string | null = null;
      let foundNsfwId: string | null = null;
      console.log("[Tag ID Finder] Searching in tagMap size:", tagMap.size);
      for (const [id, tag] of tagMap.entries()) {
        // if (tag.name.toLowerCase() === 'sfw') {
        //   foundSfwId = id;
        //   console.log(`[Tag ID Finder] Found SFW Tag: ID=${id}, Name=${tag.name}`);
        // } else
        if (tag.name.toLowerCase() === 'nsfw') {
          foundNsfwId = id;
          console.log(`[Tag ID Finder] Found NSFW Tag: ID=${id}, Name=${tag.name}`);
        }
      }
      // setSfwTagId(foundSfwId);
      setNsfwTagId(foundNsfwId);
      // if (!foundSfwId) console.warn("[Tag ID Finder] SFW tag ID not found in tagMap!");
      if (!foundNsfwId) console.warn("[Tag ID Finder] NSFW tag ID not found in tagMap!");
    }
  }, [tagsLoaded, tagMap]);

  const fetchGames = useCallback(
    async (pageNum = 1, isReset = false) => {
      // Используем только nsfwTagId для проверки возможности загрузки
      const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
      const canFetch = tagsLoaded && (!nsfwFilterActive || nsfwTagId !== null);

      if (!canFetch) {
          if (!tagsLoaded) {
              console.log('[fetchGames] Waiting for tags to load...');
          } else if (nsfwFilterActive && nsfwTagId === null) {
              console.log('[fetchGames] Waiting for NSFW tag ID...');
          } else {
              console.log('[fetchGames] Cannot fetch, condition not met.', {tagsLoaded, nsfwFilterActive, nsfwTagId});
          }
          return;
      }
      if (!isReset && !hasMore) {
          console.log('[fetchGames] No more games to fetch.');
          return;
      }

      console.log('fetchGames called with:', { pageNum, isReset, filterMode, selectedTags });
      setLoading(true);

      try {
        const filterConditions: string[] = [];
        const blockedTagIds = blockedTags.map(tag => tag.id);

        const positiveSelectedTags: string[] = [];
        const negativeSelectedTagNames: string[] = [];
        selectedTags.forEach(tag => { if (tag.startsWith('-')) { const baseTagName = tag.substring(1); if (baseTagName) negativeSelectedTagNames.push(baseTagName); } else { positiveSelectedTags.push(tag); } });
        console.log('[fetchGames] Parsed tags:', { positiveSelectedTags, negativeSelectedTagNames });


        if (positiveSelectedTags.length > 0) {
          const positiveTagIds = Array.from(tagMap.entries())
            .filter(([_, tag]) => positiveSelectedTags.includes(tag.name))
            .map(([id, _]) => id);

          if (positiveTagIds.length > 0) {
             if (positiveTagIds.length !== positiveSelectedTags.length) {
                console.warn("Some selected positive tags were not found in tagMap. Search results might be incomplete or empty.");
             }
             const tagConditions = positiveTagIds.map(id => `tags ~ "${id}"`);
             filterConditions.push(...tagConditions);
             console.log(`Applying POSITIVE tags filter (AND): requiring all of IDs ${positiveTagIds.join(', ')}`);
          } else {
            console.warn("Selected positive tags not found in tagMap, filtering resulted in no matches.");
            filterConditions.push('(1=0)');
          }
        }

        if (selectedAuthors.length > 0) {
          const authorConditions = selectedAuthors.map((author) => `authors_via_games.name ?~ "${author}"`);
          filterConditions.push(`(${authorConditions.join(' || ')})`);
        }

        if (filterMode === 'sfw') {
          if (nsfwTagId) {
              filterConditions.push(`tags.id != "${nsfwTagId}"`);
              console.log(`Applying SFW filter: excluding tag ID ${nsfwTagId}`);
          } else {
              console.error("SFW filter active, but NSFW tag ID is null! Blocking results.");
              filterConditions.push('(1=0)');
          }
        } else if (filterMode === 'nsfw') {
           if (nsfwTagId) {
              filterConditions.push(`tags ~ "${nsfwTagId}"`);
              console.log(`Applying NSFW filter: requiring tag ID ${nsfwTagId} using '~' operator`);
           } else {
               console.error("NSFW filter active, but NSFW tag ID is null! Blocking results.");
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
                 console.log(`Applying NEGATIVE tags filter: excluding IDs ${negativeTagIds.join(', ')}`);
             } else {
                 console.warn("Selected negative tags were specified, but their base names were not found in tagMap.");
             }
        }

        if (blockedTagIds.length > 0) {
          const finalBlockedIds = blockedTagIds.filter(blockedId =>
              !negativeSelectedTagNames.some(negName => tagMap.get(blockedId)?.name === negName)
          );
          if (finalBlockedIds.length > 0) {
              const blockedConditions = finalBlockedIds.map(id => `tags.id != "${id}"`);
              filterConditions.push(...blockedConditions);
              console.log(`Applying BLOCKED tags filter: excluding IDs ${finalBlockedIds.join(', ')}`);
          }
        }

        const filterString = filterConditions.length > 0 ? filterConditions.join(' && ') : '';
        console.log('[fetchGames] Final filter string:', filterString || '<no filter>');
        console.log('[fetchGames] Requesting page:', pageNum);

        const fieldsToFetch = 'id,collectionId,title,description,image,image_base64,tags,expand.authors_via_games.name,upvotes_count,comments_count';

        const fetchedGamesResult = await gamesCollection.getList(pageNum, ITEMS_PER_PAGE, {
          sort: '-created',
          expand: 'authors_via_games',
          filter: filterString,
          fields: fieldsToFetch,
        });

        console.log(`[fetchGames] RAW response (page ${pageNum}):`, fetchedGamesResult.items.length, 'items received.');

        const enrichedGames = fetchedGamesResult.items.map((game) => {
          const gameTags = Array.isArray(game.tags) ? game.tags : [];
          const enrichedTags = gameTags
            .map((tagId) => tagMap.get(tagId))
            .filter((tag): tag is Tag => tag !== undefined);
          return { ...game, expand: { ...game.expand, tags: enrichedTags }, };
        });

        if (negativeSelectedTagNames.length > 0) {
           const negativeTagIds = Array.from(tagMap.entries())
               .filter(([_, tag]) => negativeSelectedTagNames.includes(tag.name))
               .map(([id, _]) => id);
           const gamesWithNegativeTags = enrichedGames.filter(g =>
               g.expand?.tags?.some(t => negativeTagIds.includes(t.id))
           );
            if (gamesWithNegativeTags.length > 0) {
              console.warn(`[POST-CHECK] Negative tags filter applied, but ${gamesWithNegativeTags.length} games with excluded tags found AFTER enrichment! IDs:`, gamesWithNegativeTags.map(g => g.id));
            }
        }

        if (filterMode === 'nsfw' && nsfwTagId) {
           const gamesWithNsfw = enrichedGames.filter(g => g.expand?.tags?.some(t => t.id === nsfwTagId));
            if (enrichedGames.length > 0 && gamesWithNsfw.length === 0) {
               console.warn(`[POST-CHECK] WARNING: NSFW filter active, games received (${enrichedGames.length}), but NONE seem to have the NSFW tag after enrichment.`);
           }
        }

        console.log(`[fetchGames] Enriched ${enrichedGames.length} games (page ${pageNum}/${fetchedGamesResult.totalPages})`);

        setGames((prevGames) => {
          const newGames = isReset ? enrichedGames : [...prevGames, ...enrichedGames];
          const uniqueGames = Array.from(new Map(newGames.map((game) => [game.id, game])).values());
          console.log(`[setGames] Total unique games: ${uniqueGames.length}`);
          return uniqueGames;
        });

        setHasMore(fetchedGamesResult.items.length === ITEMS_PER_PAGE);
        console.log(`[fetchGames] hasMore set to: ${fetchedGamesResult.items.length === ITEMS_PER_PAGE} (based on items received)`);

      } catch (error: any) {
        console.error('[fetchGames] Error fetching games:', error);
        if (error.isAbort) { console.warn('[fetchGames] Request was aborted.'); }
        else { console.error('[fetchGames] PocketBase error details:', error.data); }
        setHasMore(false);
      } finally {
        setLoading(false);
        console.log('[fetchGames] Loading set to false');
      }
    },
    [tagsLoaded, hasMore, selectedTags, selectedAuthors, tagMap, filterMode, blockedTags, nsfwTagId]
  );

  // 1. Загрузка тегов
  useEffect(() => {
    let isMounted = true;
    console.log("[useEffect tags] Starting tags load...");
    setLoading(true);
    (async () => {
      try {
        const cachedTags = localStorage.getItem('tagMap');
        const lastUpdated = localStorage.getItem('tagMapLastUpdated');
        const now = Date.now();
        let newTagMap: Map<string, Tag>;

        if (cachedTags && lastUpdated && now - parseInt(lastUpdated) < ONE_DAY_IN_MS) {
            console.log("[useEffect tags] Using cached tags.");
            newTagMap = new Map(JSON.parse(cachedTags));
        } else {
            console.log("[useEffect tags] Fetching tags from server...");
            const fetchedTags = await tagsCollection.getFullList(500, {
              fields: 'id,name',
              sort: 'name'
            });
            const tagsTyped = fetchedTags.map(tag => tag as unknown as Tag);
            newTagMap = new Map(tagsTyped.map((tag) => [tag.id, tag]));
            localStorage.setItem('tagMap', JSON.stringify([...newTagMap]));
            localStorage.setItem('tagMapLastUpdated', now.toString());
            console.log("[useEffect tags] Tags fetched and cached. Map size:", newTagMap.size);
        }

        if (isMounted) {
            setTagMap(newTagMap);
            setTagsLoaded(true);
            console.log("[useEffect tags] Tags state updated, tagsLoaded set to true.");
        }

      } catch (error) {
        console.error('[useEffect tags] Error loading tags:', error);
        if (isMounted) {
            setTagsLoaded(true);
            setLoading(false);
            console.log("[useEffect tags] Error loading tags, setting tagsLoaded=true, loading=false.");
        }
      }
    })();

    return () => { isMounted = false; };
  }, []);

  // 2. Начальная загрузка игр
  useEffect(() => {
    const nsfwFilterActive = filterMode === 'nsfw' || filterMode === 'sfw';
    // Используем только nsfwTagId для проверки
    const readyToFetch = tagsLoaded && (filterMode === 'all' || (nsfwFilterActive && nsfwTagId !== null));

    console.log("[useEffect initial load] Checking conditions:", { tagsLoaded, filterMode, nsfwFilterActive, nsfwTagIdExists: nsfwTagId !== null, initialFetchPerformed: initialFetchPerformedRef.current });

    if (readyToFetch && !initialFetchPerformedRef.current) {
      console.log("[useEffect initial load] Conditions met. Fetching initial games...");
      initialFetchPerformedRef.current = true;
      fetchGames(1, true);
    } else if (tagsLoaded && nsfwFilterActive && nsfwTagId === null && !initialFetchPerformedRef.current) {
      console.log("[useEffect initial load] Waiting for NSFW tag ID...");
      setLoading(true);
    } else if (!tagsLoaded && !initialFetchPerformedRef.current) {
        console.log("[useEffect initial load] Waiting for tags...");
        setLoading(true);
    }
  }, [tagsLoaded, filterMode, nsfwTagId, fetchGames]);

  // 3. Обработка изменения фильтров
  useEffect(() => {
    if (!initialFetchPerformedRef.current) {
      return;
    }
     if (!tagsLoaded) {
        return;
    }

    const currentBlockedIds = blockedTags.map(t => t.id).sort();

    if (prevFiltersRef.current === null) {
      console.log("[useEffect filters] Initializing prevFiltersRef.");
      prevFiltersRef.current = {
        tags: [...selectedTags],
        authors: [...selectedAuthors],
        mode: filterMode,
        blocked: currentBlockedIds,
      };
      return;
    }

    const tagsChanged = JSON.stringify(selectedTags.sort()) !== JSON.stringify(prevFiltersRef.current.tags.sort());
    const authorsChanged = JSON.stringify(selectedAuthors.sort()) !== JSON.stringify(prevFiltersRef.current.authors.sort());
    const modeChanged = filterMode !== prevFiltersRef.current.mode;
    const blockedChanged = JSON.stringify(currentBlockedIds) !== JSON.stringify(prevFiltersRef.current.blocked);

    const hasMeaningfulChange = tagsChanged || authorsChanged || modeChanged || blockedChanged;

    if (hasMeaningfulChange) {
      console.log('[useEffect filters] Filters changed, fetching...', { tagsChanged, authorsChanged, modeChanged, blockedChanged });
      prevFiltersRef.current = {
        tags: [...selectedTags],
        authors: [...selectedAuthors],
        mode: filterMode,
        blocked: currentBlockedIds,
      };
      setPage(1);
      setHasMore(true);
      setGames([]);
      fetchGames(1, true);
    }
  }, [selectedTags, selectedAuthors, filterMode, blockedTags, tagsLoaded, fetchGames]);

  // 4. Бесконечная прокрутка
  useEffect(() => {
    if (page > 1 && hasMore && !loading && initialFetchPerformedRef.current) {
      console.log('[useEffect pagination] Loading next page:', page);
      fetchGames(page, false);
    }
  }, [page, hasMore, loading, fetchGames]);

  // Intersection Observer
  const observer = useRef<IntersectionObserver | null>(null);
  const lastGameElementRef = useCallback(
    (node: HTMLElement | null) => {
      if (loading || !hasMore) return;
      if (observer.current) observer.current.disconnect();
      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          console.log('[Observer] Last element visible, requesting next page');
          setPage((prevPage) => prevPage + 1);
        }
      });
      if (node) observer.current.observe(node);
    },
    [loading, hasMore],
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

      {loading && (games.length === 0 || (initialFetchPerformedRef.current && page === 1)) && (
         <Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
            <CircularProgress />
         </Box>
      )}

      {games.length > 0 && (
        <Grid2 container spacing={2} justifyContent="center">
            {memoizedGames.map((game, index) => (
                <Grid2
                    size={{ xs: 12, sm: 6, md: 4, lg: 2.4 }}
                    key={`search-${game.id}-${index}`}
                    ref={index === memoizedGames.length - 1 && hasMore ? lastGameElementRef : null}
                >
                    <GameCard game={game} key={game.id} variant="standard"/>
                </Grid2>
            ))}
        </Grid2>
      )}

      {loading && games.length > 0 && page > 1 && (
          <CircularProgress sx={{ mt: 2, display: 'block', margin: 'auto' }} />
      )}

      {initialFetchPerformedRef.current && !loading && !hasMore && games.length > 0 && (
        <Typography sx={{ mt: 2, textAlign: 'center', color: 'text.secondary' }}>
            No more games to load
        </Typography>
      )}

      {initialFetchPerformedRef.current && !loading && games.length === 0 && (
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