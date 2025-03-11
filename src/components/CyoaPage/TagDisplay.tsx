//src/components/CyoaPage/TagDisplay.tsx

import React, { useState, useContext, useEffect } from 'react';
import { Box } from '@mui/material';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, gamesCollection, tagsCollection, pb } from '../../pocketbase/pocketbase';
import AddTagPopover from './AddTagPopover';
import TagCategoryComponent from './TagCategory';
import CustomTagPopover from './CustomTagPopover';

// Constants
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

export const PROPOSED_TAG_VOTE_VALUE = -1000;
export const ACTIVATION_THRESHOLD = 5;
export const INITIAL_ACTIVE_VOTE = -30;
export const HIDDEN_TAG_THRESHOLD = -50; 

export const SECTION_GAP = 0.5;

export default function TagDisplay({
  tags,
  gameId,
}: {
  tags: Tag[];
  gameId: string;
}) {
  const { user } = useContext(AuthContext);
  const [tagVotes, setTagVotes] = useState<Record<string, GameTagVote>>({});
  const [isUpdating, setIsUpdating] = useState<Record<string, boolean>>({});
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [customAnchorEl, setCustomAnchorEl] = useState<null | HTMLElement>(null);
  const [currentCategory, setCurrentCategory] = useState<string>('');
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [categoryTags, setCategoryTags] = useState<Record<string, Tag[]>>({});
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [allAvailableTags, setAllAvailableTags] = useState<Record<string, Tag>>({});
  const [allCategories, setAllCategories] = useState<string[]>([]);

  // Загрузка всех доступных тегов и категорий
  useEffect(() => {
    const loadAllData = async () => {
      try {
        const categoriesResponse = await tagCategoriesCollection.getFullList();
        const categoryNames = categoriesResponse.map(category => category.name);
        setAllCategories(categoryNames);
        
        const tagsResponse = await pb.collection('tags').getFullList({
          expand: 'tag_categories(tags),tag_categories_via_tags'
        });
        
        const tagsMap: Record<string, Tag> = {};
        tagsResponse.forEach(tag => {
          const tagCopy = { ...tag } as any as Tag;
          tagsMap[tag.id] = tagCopy;
        });
        setAllAvailableTags(tagsMap);
        
        const categoriesWithTagsResponse = await tagCategoriesCollection.getFullList({
          expand: 'tags',
        });
        
        const catTags: Record<string, Tag[]> = {};
        categoriesWithTagsResponse.forEach((category) => {
          if (category.expand?.tags) {
            const tagsWithCategory = category.expand.tags.map(tag => {
              const tagWithCategory = structuredClone(tag) as any;
              if (!tagWithCategory.expand) tagWithCategory.expand = {};
              
              const categoryInfo = {
                id: category.id,
                name: category.name
              };
              
              tagWithCategory.expand.tag_categories_via_tags = [categoryInfo as any];
              
              return tagWithCategory as Tag;
            });
            catTags[category.name] = tagsWithCategory;
          } else {
            catTags[category.name] = [];
          }
        });
        
        setCategoryTags(catTags);
      } catch (error) {
        console.error('Ошибка при загрузке данных:', error);
      }
    };
    
    loadAllData();
  }, []);

  // Загрузка голосов и восстановление выбранных пользователем тегов
  useEffect(() => {
    const loadVotes = async () => {
      if (Object.keys(categoryTags).length === 0 || Object.keys(allAvailableTags).length === 0) return;
      
      try {
        const votes = await gameTagVotesCollection.getFullList({
          filter: `gameId = "${gameId}"`,
        });
        
        const voteMap: Record<string, GameTagVote> = {};
        const userSelectedTagIds: string[] = [];
        
        votes.forEach((vote) => {
          voteMap[vote.tagId] = vote;
          
          if (user && vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters?.includes(user.id)) {
            userSelectedTagIds.push(vote.tagId);
          }
          
          if (vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters && vote.upVoters.length >= ACTIVATION_THRESHOLD) {
            activateProposedTag(vote);
          }
        });
        
        setTagVotes(voteMap);
        
        if (user && userSelectedTagIds.length > 0) {
          const selectedTagsToRestore = userSelectedTagIds
            .map(tagId => allAvailableTags[tagId])
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
      } catch (error) {
        console.error('Ошибка при загрузке голосов:', error);
      }
    };
    
    loadVotes();
  }, [gameId, user, allAvailableTags, categoryTags]);

  const activateProposedTag = async (vote: GameTagVote) => {
    if (!vote.id) return;
    
    try {
      const updatedVote = {
        ...vote,
        votes: INITIAL_ACTIVE_VOTE,
      };
      
      await gameTagVotesCollection.update(vote.id, {
        votes: INITIAL_ACTIVE_VOTE,
      });
      
      const game = await gamesCollection.getOne(vote.gameId);
      const tagIds = [...new Set([...game.tags, vote.tagId])];
      
      await gamesCollection.update(vote.gameId, {
        tags: tagIds
      });
      
      setTagVotes(prev => ({
        ...prev,
        [vote.tagId]: updatedVote
      }));
    } catch (error) {
      console.error('Ошибка при активации тега:', error);
    }
  };

  // Group tags by categories
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

  const handleTagClick = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;
  
    const userId = user.id;
    const currentVote = tagVotes[tag.id];
    
    if (currentVote && currentVote.votes === PROPOSED_TAG_VOTE_VALUE && currentVote.upVoters?.includes(userId)) {
      setIsUpdating(prev => ({
        ...prev,
        [tag.id]: true
      }));
      
      try {
        const upVoters = [...(currentVote.upVoters || [])];
        const updatedUpVoters = upVoters.filter(id => id !== userId);
        
        if (currentVote.id) {
          const updatedVote = await gameTagVotesCollection.update(currentVote.id, {
            upVoters: updatedUpVoters
          });
          
          setTagVotes(prev => ({
            ...prev,
            [tag.id]: updatedVote
          }));
        }
        
        setSelectedTags(prev => prev.filter(t => t.id !== tag.id));
      } catch (error) {
        console.error('Ошибка при отмене предложенного тега:', error);
      } finally {
        setIsUpdating(prev => ({
          ...prev,
          [tag.id]: false
        }));
      }
      return;
    }
    
    if ((currentVote?.votes || 0) <= HIDDEN_TAG_THRESHOLD && currentVote?.votes !== PROPOSED_TAG_VOTE_VALUE) return;
    
    let userVoteStatus = 0;
    if (currentVote) {
      if (currentVote.upVoters?.includes(userId)) {
        userVoteStatus = 1;
      } else if (currentVote.downVoters?.includes(userId)) {
        userVoteStatus = -1;
      }
    }
    
    let newUserVoteStatus: number;
    if (userVoteStatus === 0) {
      newUserVoteStatus = 1;
    } else if (userVoteStatus === 1) {
      newUserVoteStatus = -1;
    } else {
      newUserVoteStatus = 0;
    }
    
    setIsUpdating(prev => ({
      ...prev,
      [tag.id]: true
    }));
    
    try {
      if (currentVote?.id) {
        const upVoters = [...(currentVote.upVoters || [])];
        const downVoters = [...(currentVote.downVoters || [])];
        const filteredUpVoters = upVoters.filter(id => id !== userId);
        const filteredDownVoters = downVoters.filter(id => id !== userId);
        
        if (newUserVoteStatus === 1) {
          filteredUpVoters.push(userId);
        } else if (newUserVoteStatus === -1) {
          filteredDownVoters.push(userId);
        }
        
        const newVotes = filteredUpVoters.length - filteredDownVoters.length;
        
        const newVote = {
          ...currentVote,
          votes: newVotes,
          upVoters: filteredUpVoters,
          downVoters: filteredDownVoters
        };
        
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: newVote
        }));
        
        await gameTagVotesCollection.update(currentVote.id, {
          votes: newVotes,
          upVoters: filteredUpVoters,
          downVoters: filteredDownVoters
        });
      } else if (newUserVoteStatus !== 0) {
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tag.id,
          votes: newUserVoteStatus,
          upVoters: newUserVoteStatus === 1 ? [userId] : [],
          downVoters: newUserVoteStatus === -1 ? [userId] : []
        };
        
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: createdVote as GameTagVote
        }));
      }
    } catch (error) {
      console.error('Ошибка при голосовании:', error);
      setTagVotes(prev => {
        const newState = { ...prev };
        if (currentVote) {
          newState[tag.id] = currentVote;
        }
        return newState;
      });
    } finally {
      setTimeout(() => {
        setIsUpdating(prev => ({
          ...prev,
          [tag.id]: false
        }));
      }, 100);
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
      const existingProposedTagIds = Object.keys(tagVotes).filter(tagId => 
        tagVotes[tagId].votes === PROPOSED_TAG_VOTE_VALUE && 
        tagVotes[tagId].upVoters?.includes(user?.id || ''));
      
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
      
      let existingVote: GameTagVote | null = null;
      
      try {
        existingVote = await gameTagVotesCollection.getFirstListItem(`gameId="${gameId}" && tagId="${tag.id}"`);
      } catch (error) {
      }
      
      if (existingVote) {
        const upVoters = [...(existingVote.upVoters || [])];
        if (!upVoters.includes(user.id)) {
          upVoters.push(user.id);
        }
        
        const updatedVote = await gameTagVotesCollection.update(existingVote.id, {
          upVoters: upVoters,
        });
        
        if (upVoters.length >= ACTIVATION_THRESHOLD) {
          await activateProposedTag(updatedVote);
        }
        
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: updatedVote
        }));
      } else {
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tag.id,
          votes: PROPOSED_TAG_VOTE_VALUE,
          upVoters: [user.id],
          downVoters: []
        };
        
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: createdVote as GameTagVote
        }));
      }
      
      setSelectedTags(prev => {
        if (!prev.some(t => t.id === tag.id)) {
          return [...prev, fullTagInfo as Tag];
        }
        return prev;
      });
      
    } catch (error) {
      console.error('Ошибка при добавлении тега:', error);
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
      const existingTag = Object.values(allAvailableTags).find(
        tag => tag.name.toLowerCase() === normalizedTagName.toLowerCase()
      );
      
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
          console.error("Ошибка при работе с категорией Custom:", categoryError);
          throw new Error("Не удалось создать тег в категории Custom");
        }
      }
      
      let existingVote: GameTagVote | null = null;
      
      try {
        existingVote = await gameTagVotesCollection.getFirstListItem(`gameId="${gameId}" && tagId="${tagToUse.id}"`);
      } catch (error) {
      }
      
      if (existingVote) {
        const upVoters = [...(existingVote.upVoters || [])];
        if (!upVoters.includes(user.id)) {
          upVoters.push(user.id);
          
          const updatedVote = await gameTagVotesCollection.update(existingVote.id, {
            upVoters: upVoters
          });
          
          if (upVoters.length >= ACTIVATION_THRESHOLD) {
            await activateProposedTag(updatedVote);
          }
          
          setTagVotes(prev => ({
            ...prev,
            [tagToUse.id]: updatedVote
          }));
        }
      } else {
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tagToUse.id,
          votes: PROPOSED_TAG_VOTE_VALUE,
          upVoters: [user.id],
          downVoters: []
        };
        
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        setTagVotes(prev => ({
          ...prev,
          [tagToUse.id]: createdVote as GameTagVote
        }));
      }
      
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
    
    if (!user) {
      if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD && vote.votes !== PROPOSED_TAG_VOTE_VALUE) {
        return false;
      }
      if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
        return false;
      }
      return true;
    }
    
    if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
      return vote.upVoters?.includes(user.id);
    }
    
    if (selectedTags.some(t => t.id === tag.id)) {
      return true;
    }
    
    if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD) {
      return false;
    }
    
    return true;
  };

  const popoverOpen = Boolean(anchorEl);
  const customPopoverOpen = Boolean(customAnchorEl);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const visibleTags = groupedTags[category].filter(tag => shouldShowTag(tag));
        
        if (visibleTags.length === 0 && !user) return null;
        
        return (
          <TagCategoryComponent
            key={category}
            category={category}
            tags={visibleTags}
            tagVotes={tagVotes}
            isUpdating={isUpdating}
            onTagClick={handleTagClick}
            onAddTagClick={handleAddTagClick}
            user={user}
          />
        );
      })}

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
        availableTags={Object.values(allAvailableTags)} 
        isCreating={Object.values(isUpdating).some(v => v)}
        gameId={gameId}
        tagVotes={tagVotes}
        userId={user?.id}
      />
    </Box>
  );
}