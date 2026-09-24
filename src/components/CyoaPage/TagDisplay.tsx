import React, { useState, useContext, useEffect, useRef } from 'react';
import { Box, Chip, useMediaQuery, Button, Tooltip } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, tagCategoriesCollectionPublic, tagsCollection } from '../../pocketbase/pocketbase';
import AddTagPopover from './AddTagPopover';
import TagCategoryComponent from './TagCategory';
import CustomTagPopover from './CustomTagPopover';
import { castTagVote, TagVoteResult } from './tagVoteApi';
import { getTagColor, GOLD_ACCENT } from '../../utils/tagColors';
import { requestSearchTag } from '../../utils/searchTagBus';

const CATEGORY_ORDER = [
  'Rating',
  'Interactivity',
  'POV',
  'Player Sexual Role',
  'Playtime',
  'Status',
  'Gameplay',
  'Genre',
  'Setting',
  'Tone',
  'Extra',
  'Narrative Structure',
  'Power Level',
  'Visual Style',
  'Language',
  'Kinks',
  'Custom',
];

// Two scales share game_tag_votes.votes (Go /tag-vote):
// - Proposed tag (not yet on the game), in a reserved low band: votes = PROPOSED_BASE + miniScore;
// votes <= PROPOSED_BAND_MAX = proposed. miniScore -5..+5 (author starts at +1); +PROMOTE_AT
// promotes to accepted at 0, -PROMOTE_AT drops it.
// - Accepted tag: votes = up - down.
// Scoring + bar geometry live in ./tagBar (pure). The re-export below keeps `from './TagDisplay'`
// consumers working (re-exports aren't local bindings, hence the separate import).
import { isProposedVotes, GOLD_THRESHOLD, FADED_MAX } from './tagBar';
export {
  PROPOSED_BASE,
  PROPOSED_BAND_MAX,
  PROMOTE_AT,
  isProposedVotes,
  proposedMiniScore,
  FADED_MAX,
  DELETE_AT,
  GOLD_THRESHOLD,
  ACCEPTED_SATURATION,
  PROPOSED_SATURATION,
  acceptedBar,
  proposedBar,
} from './tagBar';

// Categories where a gold "defining" tag is meaningful. Excluded (Rating, Interactivity, Playtime,
// Status, Extra, Language) never glow even when highly upvoted — a gold "Full" Status highlights
// nothing useful.
export const GOLD_ELIGIBLE = new Set<string>([
  'POV', 'Player Sexual Role', 'Gameplay', 'Genre', 'Setting', 'Tone',
  'Narrative Structure', 'Power Level', 'Visual Style', 'Kinks', 'Custom',
]);

export const SECTION_GAP = 0.5;

// Resolve tags missing from the `allAvailableTags` registry. The registry (`tag_categories` +
// expand tags) is loaded by the ANONYMOUS client (`pbPublic`), and Cloudflare rule R4a caches such
// requests at the edge for a day (infra/cloudflare/proposed_cache_rules.json). So a just-created
// custom tag appears in the registry only after a day — meanwhile its votes arrived but the tag
// didn't resolve and was silently dropped (why a fresh custom tag vanished after reload). Here we
// use the AUTHORIZED client: requests with Authorization bypass that rule and hit origin. Only for
// logged-in users and only when there's something to resolve.
async function resolveMissingTags(tagIds: string[]): Promise<Record<string, Tag>> {
  // PB ids are 15 chars [a-z0-9]; filter so nothing foreign is spliced into the filter expression.
  const ids = Array.from(new Set(tagIds)).filter((id) => /^[a-z0-9]+$/i.test(id));
  if (ids.length === 0) return {};

  const records = await tagsCollection.getFullList<Tag>({
    filter: ids.map((id) => `id = "${id}"`).join(' || '),
    fields: 'id,name,expand.tag_categories_via_tags.id,expand.tag_categories_via_tags.name',
    expand: 'tag_categories_via_tags',
  });

  const resolved: Record<string, Tag> = {};
  records.forEach((tag) => {
    resolved[tag.id] = tag;
  });
  return resolved;
}

export default function TagDisplay({
  tags,
  gameId,
  editing = false,
}: {
  tags: Tag[];
  gameId: string;
  editing?: boolean;
}) {
  const { user, isModerator } = useContext(AuthContext);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  // Resting chip = filter shortcut (searchTagBus); only the compact mobile view renders these.
  const tagTapToSearch = true;
  // On phones the resting view collapses to one wrapping row of compact category-colored chips
  // (like catalog cards). Edit mode and desktop keep the full per-category layout.
  const compact = !editing && isMobile;
  const [tagVotes, setTagVotes] = useState<Record<string, GameTagVote>>({});
  const [isUpdating, setIsUpdating] = useState<Record<string, boolean>>({});
  const [applyingMod, setApplyingMod] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [customAnchorEl, setCustomAnchorEl] = useState<null | HTMLElement>(null);
  const [currentCategory, setCurrentCategory] = useState<string>('');
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [categoryTags, setCategoryTags] = useState<Record<string, Tag[]>>({});
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [allAvailableTags, setAllAvailableTags] = useState<Record<string, Tag>>({});
  const [allCategories, setAllCategories] = useState<string[]>([]);
  // Tags NOT in the shared registry (see resolveMissingTags), kept separately so the vote-loading
  // effect doesn't loop.
  const [extraTags, setExtraTags] = useState<Record<string, Tag>>({});
  // Single tagId → tag resolution point.
  const tagLookup: Record<string, Tag> = { ...allAvailableTags, ...extraTags };

  useEffect(() => {


    const loadAllData = async () => {
        try {
          const combinedResponse = await tagCategoriesCollectionPublic.getFullList({
            fields: 'id,name,expand.tags.id,expand.tags.name',
            expand: 'tags'
          });
      
          const categoryNames: string[] = [];
          const catTags: Record<string, Tag[]> = {};
          const tagsMap: Record<string, Tag> = {};
      
          combinedResponse.forEach((category) => {
            categoryNames.push(category.name);
      
            const currentCategoryProcessedTags: Tag[] = [];
            if (category.expand?.tags) {
              category.expand.tags.forEach(tagFromExpand => {
                // Recreate the expand structure the rest of the code expects (tag with its
                // category).
                const processedTag: Tag = {
                  id: tagFromExpand.id,
                  name: tagFromExpand.name, 
                  expand: {
                    tag_categories_via_tags: [
                      {
                        name: category.name
                      }
                    ]
                  }
                } as any;
      
                currentCategoryProcessedTags.push(processedTag);
      
                // A tag in several categories would be overwritten by the last one; normally one
                // category per tag.
                if (!tagsMap[processedTag.id]) {
                   tagsMap[processedTag.id] = processedTag;
                }
              });
            }
            catTags[category.name] = currentCategoryProcessedTags;
          });
      
          setAllCategories(categoryNames);
          setAllAvailableTags(tagsMap);
          setCategoryTags(catTags);
      
        } catch (error) {
          console.error('Failed to load data:', error);
        }
      };
      
      loadAllData();
  }, []);






  // handleCustomTagCreate sets allAvailableTags/categoryTags with new objects per created tag; the
  // effect below had them in deps and re-ran a full getFullList of votes each time though
  // gameId/user didn't change. The ref holds the "gameId:userId" key already loaded and suppresses
  // refetch until game or user changes.
  const votesLoadedForRef = useRef<string | null>(null);

  useEffect(() => {
    const loadVotes = async () => {
      if (Object.keys(categoryTags).length === 0 || Object.keys(allAvailableTags).length === 0) return;
      const votesKey = `${gameId}:${user?.id ?? ''}`;
      if (votesLoadedForRef.current === votesKey) return;

      try {
        const votes = await gameTagVotesCollection.getFullList<GameTagVote>({
          filter: `gameId = "${gameId}"`,
          fields: 'id,tagId,gameId,votes,upVoters,downVoters'
        });

        const voteMap: Record<string, GameTagVote> = {};
        const userSelectedTagIds: string[] = [];

        votes.forEach((vote) => {
          voteMap[vote.tagId] = vote;

          if (user && isProposedVotes(vote.votes) && vote.upVoters?.includes(user.id)) {
            userSelectedTagIds.push(vote.tagId);
          }
        // Threshold activation is server-side now (POST /api/custom/tag-vote); the client never
        // writes games.tags.
        });

        setTagVotes(voteMap);

        // Votes may reference tags missing from the cached registry (fresh custom tags) — resolve
        // from origin, else the tag drops out of selectedTags and the merge below.
        const resolvedTags: Record<string, Tag> = { ...allAvailableTags, ...extraTags };
        if (user) {
          const missingIds = votes.map(v => v.tagId).filter(tagId => !resolvedTags[tagId]);
          if (missingIds.length > 0) {
            const fetched = await resolveMissingTags(missingIds);
            Object.assign(resolvedTags, fetched);
            if (Object.keys(fetched).length > 0) {
              setExtraTags(prev => ({ ...prev, ...fetched }));
            }
          }
        }

        if (user && userSelectedTagIds.length > 0) {
          const selectedTagsToRestore = userSelectedTagIds
            .map(tagId => resolvedTags[tagId])
            .filter(tag => tag);
          
          const tagsWithCategories = selectedTagsToRestore.map(tag => {
            const tagCopy = structuredClone(tag) as Tag;
            if (!tagCopy.expand) tagCopy.expand = {};
            
            if (!tagCopy.expand.tag_categories_via_tags) {
              tagCopy.expand.tag_categories_via_tags = [{
                id: '',
                created: '',
                updated: '',
                collectionId: 'poldsk30c0ykw9z',
                collectionName: 'tag_categories',
                name: 'Custom',
                allow_new_tags: false,
                min_tags: 0,
                max_tags: 0,
                tags: [],
                description: ''
              }];
            }
            
            return tagCopy;
          });
          
          setSelectedTags(tagsWithCategories);
        }

        votesLoadedForRef.current = votesKey;
      } catch (error) {
        console.error('Failed to load votes:', error);
      }
    };

    loadVotes();
  }, [gameId, user, allAvailableTags, categoryTags]);

  // Apply the server's authoritative vote result locally: update/add, or remove if the proposal was
  // dropped.
  const applyVoteResult = (tagId: string, result: TagVoteResult) => {
    setTagVotes(prev => {
      const next = { ...prev };
      if (result.vote) next[tagId] = result.vote;
      else delete next[tagId];
      return next;
    });
  };

  const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Custom';
    if (!acc[categoryName]) acc[categoryName] = [];
    acc[categoryName].push(tag);
    return acc;
  }, {});

  selectedTags.forEach(tag => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Custom';
    if (!groupedTags[categoryName]) groupedTags[categoryName] = [];
    if (!groupedTags[categoryName].some(t => t.id === tag.id)) {
      groupedTags[categoryName].push(tag);
    }
  });

  // Others' proposed tags aren't in games.tags — merge them from votes so they appear in their rows
  // in edit mode.
  Object.values(tagVotes).forEach(vote => {
    if (!isProposedVotes(vote.votes)) return;
    const proposedTag = tagLookup[vote.tagId];
    if (!proposedTag) return;
    const categoryName = proposedTag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Custom';
    if (!groupedTags[categoryName]) groupedTags[categoryName] = [];
    if (!groupedTags[categoryName].some(t => t.id === proposedTag.id)) {
      groupedTags[categoryName].push(proposedTag);
    }
  });

  allCategories.forEach(category => {
    if (!groupedTags[category]) {
      groupedTags[category] = [];
    }
  });

  if (!groupedTags['Custom']) {
    groupedTags['Custom'] = [];
  }

  const sortedCategories = Object.keys(groupedTags).sort((a, b) => {
    const indexA = CATEGORY_ORDER.indexOf(a);
    const indexB = CATEGORY_ORDER.indexOf(b);
    if (indexA === -1 && indexB === -1) return a.localeCompare(b);
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  // Gold = every accepted tag at GOLD_THRESHOLD+ in an eligible category; no per-game cap.
  const goldTagIds = (() => {
    const ids = new Set<string>();
    sortedCategories.forEach(category => {
      if (!GOLD_ELIGIBLE.has(category)) return;
      groupedTags[category].forEach(tag => {
        const score = tagVotes[tag.id]?.votes ?? 0;
        if (!isProposedVotes(score) && score >= GOLD_THRESHOLD) {
          ids.add(tag.id);
        }
      });
    });
    return ids;
  })();

  const handleTagClick = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;

    const userId = user.id;
    const currentVote = tagVotes[tag.id];

    // One click cycles your vote: none → up → down → clear. The server resolves the rest: promote a
    // proposal past +5, drop one at -5 (or with no support), remove an accepted tag at -20.
    let userVoteStatus = 0;
    if (currentVote) {
      if (currentVote.upVoters?.includes(userId)) userVoteStatus = 1;
      else if (currentVote.downVoters?.includes(userId)) userVoteStatus = -1;
    }
    const action = userVoteStatus === 0 ? 'upvote' : userVoteStatus === 1 ? 'downvote' : 'clear';

    if (!currentVote && action === 'clear') return;

    setIsUpdating(prev => ({ ...prev, [tag.id]: true }));
    try {
      const result = await castTagVote(gameId, tag.id, action);
      applyVoteResult(tag.id, result);
      if (result.deleted) {
        setSelectedTags(prev => prev.filter(t => t.id !== tag.id));
      }
      // Crossed the threshold: the tag is in games.tags now, but the `tags` prop arrives only after
      // reload — keep it in selectedTags or the chip vanishes until refresh.
      if (result.activated) {
        setSelectedTags(prev => (prev.some(t => t.id === tag.id) ? prev : [...prev, tag]));
      }
    } catch (error) {
      console.error('Vote failed:', error);
    } finally {
      setTimeout(() => {
        setIsUpdating(prev => ({ ...prev, [tag.id]: false }));
      }, 100);
    }
  };

  // Tags the moderator already voted on in the carousel, grouped by direction. Direction IS the
  // decision: up = accept, down = remove. There used to be one button repeating the carousel vote,
  // and the first click is always "up": click + "apply" instantly ACCEPTED a tag the moderator
  // meant to remove and zeroed the ballot. Now direction is visible before pressing.
  const pendingMod: { accept: Tag[]; remove: Tag[] } = { accept: [], remove: [] };
  if (isModerator && user) {
    Object.keys(tagVotes).forEach(tagId => {
      const v = tagVotes[tagId];
      const tag = tagLookup[tagId];
      if (!tag) return;
      if (v.upVoters?.includes(user.id)) pendingMod.accept.push(tag);
      else if (v.downVoters?.includes(user.id)) pendingMod.remove.push(tag);
    });
  }

  // mod_override is a decision, not weight: accept puts the tag on the game, remove takes it off
  // with its ballot. Sequential, not parallel: several tags write the same game record and
  // concurrent transactions would lose writes.
  const handleApplyModerator = async (direction: 'accept' | 'remove') => {
    if (applyingMod || !user) return;
    const targets = pendingMod[direction];
    if (targets.length === 0) return;
    setApplyingMod(true);
    try {
      for (const tag of targets) {
        const action = direction === 'accept' ? 'upvote' : 'downvote';
        const result = await castTagVote(gameId, tag.id, action, true);
        applyVoteResult(tag.id, result);
        if (result.deleted) {
          setSelectedTags(prev => prev.filter(t => t.id !== tag.id));
        }
        if (result.activated) {
          setSelectedTags(prev => (prev.some(t => t.id === tag.id) ? prev : [...prev, tag]));
        }
      }
    } catch (error) {
      console.error('Failed to apply moderator votes:', error);
    } finally {
      setApplyingMod(false);
    }
  };

  const handleAddTagClick = (event: React.MouseEvent<HTMLElement>, category: string) => {
    if (category === 'Custom') {
      setCustomAnchorEl(event.currentTarget);
    } else {
      setAnchorEl(event.currentTarget);
      setCurrentCategory(category);
      
      const existingTagIds = tags.map(tag => tag.id);
      const selectedTagIds = selectedTags.map(tag => tag.id);
      // All proposed tags render in their rows (edit mode) with an n/5 scale, so the "add" popup
      // shows only not-yet-proposed tags (no duplicate flat chips).
      const existingProposedTagIds = Object.keys(tagVotes).filter(tagId =>
        isProposedVotes(tagVotes[tagId].votes));

      const allExistingIds = [...existingTagIds, ...existingProposedTagIds, ...selectedTagIds];
      
      const availableCategoryTags = categoryTags[category]?.filter(
        tag => !allExistingIds.includes(tag.id)
      ) || [];
      
      setAvailableTags(availableCategoryTags);
    }
  };

  const handleClosePopover = () => {
    setAnchorEl(null);
  };

  const handleCloseCustomPopover = () => {
    setCustomAnchorEl(null);
  };

  const handleTagSelect = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;
    
    setIsUpdating(prev => ({
      ...prev,
      [tag.id]: true
    }));
    
    try {
      let fullTagInfo = structuredClone(tag) as any;
      if (!fullTagInfo.expand) fullTagInfo.expand = {};
      
      const categoryInfo = { 
        id: '',
        name: currentCategory 
      };
      fullTagInfo.expand.tag_categories_via_tags = [categoryInfo];
      
      // The server finds/creates the vote, adds ONLY the current user to upVoters and activates the
      // tag at the threshold.
      const result = await castTagVote(gameId, tag.id, 'upvote');
      applyVoteResult(tag.id, result);

      setSelectedTags(prev => {
        if (!prev.some(t => t.id === tag.id)) {
          return [...prev, fullTagInfo as Tag];
        }
        return prev;
      });

    } catch (error) {
      console.error('Failed to add tag:', error);
    } finally {
      setIsUpdating(prev => ({
        ...prev,
        [tag.id]: false
      }));
    }
    
    handleClosePopover();
  };

  const handleCustomTagCreate = async (tagName: string) => {
    if (!user || !tagName.trim()) return;
    
    try {
      const normalizedTagName = tagName.trim();
      // The registry is edge-cached up to a day, so "not in registry" ≠ "not in DB". Check locally,
      // then ask origin with an authorized request — otherwise every recently created tag spawned a
      // same-named duplicate.
      let existingTag: Tag | undefined = Object.values(tagLookup).find(
        tag => tag.name.toLowerCase() === normalizedTagName.toLowerCase()
      );
      if (!existingTag) {
        try {
          existingTag = await tagsCollection.getFirstListItem<Tag>(
            `name = "${normalizedTagName.replace(/"/g, '\\"')}"`,
            { expand: 'tag_categories_via_tags' },
          );
        } catch {
        // 404 — the tag truly doesn't exist; create below.
        }
      }

      let tagToUse: Tag;
      
      if (existingTag) {
        tagToUse = existingTag;
      } else {
        let customCategoryId: string;
        
        try {
          const customCategoryResponse = await tagCategoriesCollection.getFirstListItem('name="Custom"');
          customCategoryId = customCategoryResponse.id;
          
          const tagData: {name: string, description?: string} = { 
            name: normalizedTagName,
            description: "Custom user tag" 
          };
          
          const newTag = await tagsCollection.create(tagData);
          
          const category = await tagCategoriesCollection.getOne(customCategoryId);
          const updatedTags = Array.isArray(category.tags) ? [...category.tags, newTag.id] : [newTag.id];
          
          await tagCategoriesCollection.update(customCategoryId, {
            tags: updatedTags
          });
          
          const tagWithCategory = await tagsCollection.getOne(newTag.id, {
            expand: 'tag_categories(tags),tag_categories_via_tags'
          });
          
          tagToUse = tagWithCategory as Tag;
          
          setAllAvailableTags(prev => ({
            ...prev,
            [newTag.id]: tagToUse
          }));
          
          setCategoryTags(prev => {
            const updatedCategoryTags = { ...prev };
            if (!updatedCategoryTags['Custom']) {
              updatedCategoryTags['Custom'] = [tagToUse];
            } else {
              updatedCategoryTags['Custom'] = [...updatedCategoryTags['Custom'], tagToUse];
            }
            return updatedCategoryTags;
          });
        } catch (categoryError) {
          console.error("Custom category error:", categoryError);
          throw new Error("Could not create tag in the Custom category");
        }
      }
      
      // A fresh tag may be missing from the cached registry — put it in extraTags so the proposal
      // merges into its category immediately.
      setExtraTags(prev => (prev[tagToUse.id] ? prev : { ...prev, [tagToUse.id]: tagToUse }));

      const result = await castTagVote(gameId, tagToUse.id, 'upvote');
      applyVoteResult(tagToUse.id, result);

      setSelectedTags(prev => {
        if (!prev.some(t => t.id === tagToUse.id)) {
          return [...prev, tagToUse];
        }
        return prev;
      });
      
    } catch (error) {
      console.error('Error creating custom tag:', error);
    }
    
    handleCloseCustomPopover();
  };

  const shouldShowTag = (tag: Tag) => {
    const vote = tagVotes[tag.id];
    const proposed = vote ? isProposedVotes(vote.votes) : false;
    // Faded = accepted tag in the delete ballot (score <= -5): hidden from the public view, shown
    // grey only in edit mode to finish removal or rescue above -5.
    const faded = !proposed && !!vote && vote.votes <= FADED_MAX;

    // Proposed tags are editor-only (your own suggestion is always visible to you).
    if (!user) return !proposed && !faded;

    if (proposed) {
      if (vote!.upVoters?.includes(user.id)) return true;
      return editing;
    }

    if (faded) return editing;

    return true;
  };

  const popoverOpen = Boolean(anchorEl);
  const customPopoverOpen = Boolean(customAnchorEl);

  if (compact) {
    const compactChips: { tag: Tag; category: string }[] = [];
    sortedCategories.forEach(category => {
      groupedTags[category].forEach(tag => {
        if (shouldShowTag(tag)) compactChips.push({ tag, category });
      });
    });

    if (compactChips.length === 0) return null;

    return (
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignContent: 'flex-start' }}>
        {compactChips.map(({ tag, category }) => {
          const isGold = goldTagIds.has(tag.id);
          return (
            <Chip
              key={tag.id}
              label={tag.name}
              size="small"
              onClick={tagTapToSearch ? () => requestSearchTag(tag.name) : undefined}
              sx={{
                backgroundColor: getTagColor(category, tag.name),
                color: isGold ? GOLD_ACCENT : '#ffffff',
                textShadow: '0px 1px 2px rgba(0,0,0,0.8)',
                fontSize: '0.7rem',
                height: '22px',
                ...(tagTapToSearch && { cursor: 'pointer' }),
                ...(isGold && {
                  border: `1.5px solid ${GOLD_ACCENT}`,
                  fontWeight: 700,
                }),
              }}
            />
          );
        })}
      </Box>
    );
  }

  return (
    <Box>
      {/*
        display:flow-root contains the floating instructions; category rows (each flex) wrap around
        it.
      */}
      <Box sx={{ display: 'flow-root' }}>
        {editing && (
          <Box
            sx={{
              // Desktop: floats right of the short category rows. Mobile: full-width block above
              // all tags.
              float: { xs: 'none', sm: 'right' },
              width: { xs: '100%', sm: 'auto' },
              ml: { sm: 2 },
              mb: 2,
              p: 1.5,
              border: '1px solid',
              borderColor: 'rgba(255,255,255,0.18)',
              borderRadius: 1.5,
              backgroundColor: 'rgba(255,255,255,0.02)',
              fontSize: '0.74rem',
              lineHeight: 1.5,
              color: 'text.secondary',
            }}
          >
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.4, mb: 1.25 }}>
              <Box sx={{ whiteSpace: 'nowrap' }}>
                Click a tag to vote:{' '}
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>Up</Box>
                {' ➔ '}
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>Down</Box>
                {' ➔ '}
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 600 }}>Clear</Box>
              </Box>
              <Box sx={{ whiteSpace: 'nowrap' }}>
                Use{' '}
                <Box component="span" sx={{ color: 'text.primary', fontWeight: 700 }}>+</Box>
                {' '}to suggest a new tag
              </Box>
            </Box>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: 1.5,
                rowGap: 0.75,
                alignItems: 'baseline',
              }}
            >
              <Box sx={{ fontWeight: 600, color: 'text.primary', whiteSpace: 'nowrap' }}>Suggested</Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.4 }}>
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ color: 'success.light', fontWeight: 700 }}>+5</Box> Approve
                </Box>
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ color: 'error.light', fontWeight: 700 }}>−5</Box> Delete
                </Box>
              </Box>

              <Box sx={{ fontWeight: 600, color: 'text.primary', whiteSpace: 'nowrap' }}>Approved</Box>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 1.5, rowGap: 0.4 }}>
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ color: '#f0c040', fontWeight: 700 }}>+15</Box> Gold
                </Box>
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ color: 'error.light', fontWeight: 700 }}>−5</Box> Fade
                </Box>
                <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
                  <Box component="span" sx={{ color: 'error.light', fontWeight: 700 }}>−15</Box> Delete
                </Box>
              </Box>
            </Box>
          </Box>
        )}

        {sortedCategories.map((category) => {
          const visibleTags = groupedTags[category].filter(tag => shouldShowTag(tag));

          // Resting view hides empty categories; edit mode shows all (room to add).
          if (visibleTags.length === 0 && !editing) return null;

          return (
            <TagCategoryComponent
              key={category}
              category={category}
              tags={visibleTags}
              tagVotes={tagVotes}
              goldTagIds={goldTagIds}
              isUpdating={isUpdating}
              editing={editing}
              onTagClick={handleTagClick}
              onAddTagClick={handleAddTagClick}
              user={user}
            />
          );
        })}
      </Box>

      {/*
        Moderator decision: show tag NAMES and direction before pressing — the button acts
        immediately and irreversibly, and direction comes from the carousel vote where the first
        click is "up".
      */}
      {editing && isModerator && (pendingMod.accept.length > 0 || pendingMod.remove.length > 0) && (
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {([
            {
              dir: 'accept' as const,
              tags: pendingMod.accept,
              label: 'Approve as moderator',
              color: 'success' as const,
              hint: 'Put these tags on the game right now, at a neutral score',
            },
            {
              dir: 'remove' as const,
              tags: pendingMod.remove,
              label: 'Remove as moderator',
              color: 'error' as const,
              hint: 'Take these tags off the game right now and drop their votes',
            },
          ]).filter(row => row.tags.length > 0).map(row => (
            <Box key={row.dir} sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
              <Tooltip title={row.hint} arrow>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    color={row.color}
                    disabled={applyingMod}
                    onClick={() => handleApplyModerator(row.dir)}
                  >
                    {row.label} ({row.tags.length})
                  </Button>
                </span>
              </Tooltip>
              <Box component="span" sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                {row.tags.map(t => t.name).join(', ')}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <AddTagPopover
        open={popoverOpen}
        anchorEl={anchorEl}
        currentCategory={currentCategory}
        availableTags={availableTags}
        onClose={handleClosePopover}
        onTagSelect={handleTagSelect}
        isUpdating={isUpdating}
      />

      <CustomTagPopover
        open={customPopoverOpen}
        anchorEl={customAnchorEl}
        onClose={handleCloseCustomPopover}
        onTagCreate={handleCustomTagCreate}
        availableTags={Object.values(tagLookup)}
        isCreating={Object.values(isUpdating).some(v => v)}
      />
    </Box>
  );
}