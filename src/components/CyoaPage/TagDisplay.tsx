//src/components/CyoaPage/TagDisplay.tsx

import React, { useState, useContext, useEffect } from 'react';
import { Box } from '@mui/material';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, gamesCollection, pb } from '../../pocketbase/pocketbase';
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
  'Genre',
  'Setting',
  'Tone',
  'Extra',
  'Narrative Structure',
  'Power Level',
  'Visual Style',
  'Language',
  'Kinks',
  'Custom', // Added Custom to the order instead of Uncategorized
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
  const [customAnchorEl, setCustomAnchorEl] = useState<null | HTMLElement>(null); // New state for custom tag popover
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
        // Загружаем категории
        const categoriesResponse = await tagCategoriesCollection.getFullList();
        
        // Создаем список всех категорий
        const categoryNames = categoriesResponse.map(category => category.name);
        setAllCategories(categoryNames);
        
        // Загружаем теги с информацией о категориях
        const tagsResponse = await pb.collection('tags').getFullList({
          expand: 'tag_categories(tags),tag_categories_via_tags'
        });
        
        const tagsMap: Record<string, Tag> = {};
        tagsResponse.forEach(tag => {
          // Создаем копию с приведением типа
          const tagCopy = { ...tag } as any as Tag;
          tagsMap[tag.id] = tagCopy;
        });
        setAllAvailableTags(tagsMap);
        
        // Загружаем категории с тегами
        const categoriesWithTagsResponse = await tagCategoriesCollection.getFullList({
          expand: 'tags',
        });
        
        const catTags: Record<string, Tag[]> = {};
        categoriesWithTagsResponse.forEach((category) => {
          if (category.expand?.tags) {
            // Добавляем информацию о категории к каждому тегу
            const tagsWithCategory = category.expand.tags.map(tag => {
              // Создаем совместимую копию тега
              const tagWithCategory = structuredClone(tag) as any;
              if (!tagWithCategory.expand) tagWithCategory.expand = {};
              
              // Создаем кортеж с одним элементом
              const categoryInfo = {
                id: category.id,
                name: category.name
              };
              
              // Присваиваем через any чтобы обойти проверку типов
              tagWithCategory.expand.tag_categories_via_tags = [categoryInfo as any];
              
              return tagWithCategory as Tag;
            });
            catTags[category.name] = tagsWithCategory;
          } else {
            // Добавляем пустой массив для категорий без тегов
            catTags[category.name] = [];
          }
        });
        
        setCategoryTags(catTags);
        
        // Отладка
        console.log('Categories loaded:', categoriesResponse);
        console.log('Tags with categories:', tagsMap);
        console.log('Category tags:', catTags);
        console.log('All category names:', categoryNames);
      } catch (error) {
        console.error('Ошибка при загрузке данных:', error);
      }
    };
    
    loadAllData();
  }, []);

// Загрузка голосов и восстановление выбранных пользователем тегов
useEffect(() => {
  const loadVotes = async () => {
    // Убираем проверку на наличие пользователя, загружаем голоса всегда
    if (Object.keys(categoryTags).length === 0 || Object.keys(allAvailableTags).length === 0) return;
    
    try {
      const votes = await gameTagVotesCollection.getFullList({
        filter: `gameId = "${gameId}"`,
      });
      
      const voteMap: Record<string, GameTagVote> = {};
      const userSelectedTagIds: string[] = [];
      
      votes.forEach((vote) => {
        voteMap[vote.tagId] = vote;
        
        // Проверяем, является ли тег предложенным пользователем (только для авторизованных)
        if (user && vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters?.includes(user.id)) {
          userSelectedTagIds.push(vote.tagId);
        }
        
        if (vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters && vote.upVoters.length >= ACTIVATION_THRESHOLD) {
          activateProposedTag(vote);
        }
      });
      
      setTagVotes(voteMap);
      
      // Восстанавливаем выбранные пользователем теги (только для авторизованных)
      if (user && userSelectedTagIds.length > 0) {
        // Находим теги в allAvailableTags по их идентификаторам
        const selectedTagsToRestore = userSelectedTagIds
          .map(tagId => allAvailableTags[tagId])
          .filter(tag => tag); // Отфильтровываем undefined значения
        
        // Добавляем информацию о категории для каждого тега
        const tagsWithCategories = selectedTagsToRestore.map(tag => {
          // Создаем копию тега
          const tagCopy = structuredClone(tag) as Tag;
          
          // Проверяем, существует ли структура expand и tag_categories_via_tags
          if (!tagCopy.expand) tagCopy.expand = {};
          
          // Устанавливаем категорию 'Custom' по умолчанию, если другая не известна
          if (!tagCopy.expand.tag_categories_via_tags) {
            tagCopy.expand.tag_categories_via_tags = [{
              id: '',
              created: '',
              updated: '',
              collectionId: 'poldsk30c0ykw9z', // ID коллекции tag_categories из вашей схемы
              collectionName: 'tag_categories',
              name: 'Custom',
              allow_new_tags: false, // необязательное поле
              min_tags: 0,           // необязательное поле
              max_tags: 0,           // необязательное поле
              tags: [],              // необязательное поле, relation
              description: ''        // необязательное поле
            }];
          }
          
          return tagCopy;
        });
        
        // Обновляем выбранные теги
        setSelectedTags(tagsWithCategories);
        console.log('Restored user tags:', tagsWithCategories);
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
      // Обновляем запись голосования
      const updatedVote = {
        ...vote,
        votes: INITIAL_ACTIVE_VOTE,
      };
      
      await gameTagVotesCollection.update(vote.id, {
        votes: INITIAL_ACTIVE_VOTE,
      });
      
      // Добавляем тег в список тегов игры
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

  // Отладка данных
  useEffect(() => {
    if (selectedTags.length > 0) {
      console.log('Selected tags:', selectedTags);
    }
  }, [selectedTags]);

  // Group tags by categories
  const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
    // Replace 'Uncategorized' with 'Custom' for uncategorized tags
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Custom';
    if (!acc[categoryName]) acc[categoryName] = [];
    acc[categoryName].push(tag);
    return acc;
  }, {});

  // Add the selected tags to their respective categories
  selectedTags.forEach(tag => {
    // Replace 'Uncategorized' with 'Custom' for selected tags too
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Custom';
    if (!groupedTags[categoryName]) groupedTags[categoryName] = [];
    // Check if the tag is already in the group before adding
    if (!groupedTags[categoryName].some(t => t.id === tag.id)) {
      groupedTags[categoryName].push(tag);
    }
  });

  // Add empty arrays for categories that don't have any tags
  allCategories.forEach(category => {
    if (!groupedTags[category]) {
      groupedTags[category] = [];
    }
  });

  // Make sure 'Custom' category exists
  if (!groupedTags['Custom']) {
    groupedTags['Custom'] = [];
  }

  // Sort categories
  const sortedCategories = Object.keys(groupedTags).sort((a, b) => {
    const indexA = CATEGORY_ORDER.indexOf(a);
    const indexB = CATEGORY_ORDER.indexOf(b);
    if (indexA === -1 && indexB === -1) return a.localeCompare(b); // Алфавитная сортировка для кастомных категорий
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });

  const handleTagClick = async (tag: Tag) => {
    if (!user) return;
    if (isUpdating[tag.id]) return;
  
    const userId = user.id;
    const currentVote = tagVotes[tag.id];
    
    // Обработка голосов за предложенные теги
    if (currentVote && currentVote.votes === PROPOSED_TAG_VOTE_VALUE && currentVote.upVoters?.includes(userId)) {
      setIsUpdating(prev => ({
        ...prev,
        [tag.id]: true
      }));
      
      try {
        // Получаем текущий список upVoters
        const upVoters = [...(currentVote.upVoters || [])];
        
        // Удаляем текущего пользователя из списка
        const updatedUpVoters = upVoters.filter(id => id !== userId);
        
        // Обновляем запись, никогда не удаляем
        if (currentVote.id) {
          const updatedVote = await gameTagVotesCollection.update(currentVote.id, {
            upVoters: updatedUpVoters
          });
          
          // Обновляем состояние
          setTagVotes(prev => ({
            ...prev,
            [tag.id]: updatedVote
          }));
        }
        
        // Удаляем тег из selectedTags для текущего пользователя
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
        // Если newUserVoteStatus === 0, то пользователь отменяет свой голос,
        // но мы не удаляем запись, а только удаляем его из списков голосующих
        
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
        // Создание новой записи (это не удаление, так что оставляем как есть)
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
      // For Custom category, open the CustomTagPopover
      setCustomAnchorEl(event.currentTarget);
    } else {
      // For other categories, open the regular AddTagPopover
      setAnchorEl(event.currentTarget);
      setCurrentCategory(category);
      
      // Filter available tags for the category
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
      // Подготавливаем тег с информацией о выбранной категории
      // Используем клонирование для создания нового объекта и обходим проверки типов
      let fullTagInfo = structuredClone(tag) as any;
      if (!fullTagInfo.expand) fullTagInfo.expand = {};
      
      // Добавляем информацию о категории
      const categoryInfo = { 
        id: '', // Мы можем не знать ID, но знаем имя категории
        name: currentCategory 
      };
      fullTagInfo.expand.tag_categories_via_tags = [categoryInfo];
      
      // Сначала проверяем, существует ли уже запись для этого тега в игре
      let existingVote: GameTagVote | null = null;
      
      try {
        // Пытаемся найти существующую запись для этого тега
        existingVote = await gameTagVotesCollection.getFirstListItem(`gameId="${gameId}" && tagId="${tag.id}"`);
      } catch (error) {
        // Если запись не найдена, existingVote останется null
        console.log('No existing vote found for this tag');
      }
      
      if (existingVote) {
        // Если запись существует, добавляем пользователя в upVoters
        const upVoters = [...(existingVote.upVoters || [])];
        
        // Добавляем пользователя в upVoters только если его там еще нет
        if (!upVoters.includes(user.id)) {
          upVoters.push(user.id);
        }
        
        // Обновляем запись
        const updatedVote = await gameTagVotesCollection.update(existingVote.id, {
          upVoters: upVoters,
          // Не меняем votes, оно должно оставаться PROPOSED_TAG_VOTE_VALUE
        });
        
        // Проверяем, достигли ли мы порога для активации тега
        if (upVoters.length >= ACTIVATION_THRESHOLD) {
          await activateProposedTag(updatedVote);
        }
        
        // Обновляем локальное состояние
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: updatedVote
        }));
      } else {
        // Если записи нет, создаем новую
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tag.id,
          votes: PROPOSED_TAG_VOTE_VALUE,
          upVoters: [user.id],
          downVoters: []
        };
        
        // Создаем запись в базе данных
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        // Обновляем состояние
        setTagVotes(prev => ({
          ...prev,
          [tag.id]: createdVote as GameTagVote
        }));
      }
      
      // Добавляем тег в selectedTags для отображения
      setSelectedTags(prev => {
        // Добавляем тег только если его еще нет в списке
        if (!prev.some(t => t.id === tag.id)) {
          console.log('Adding tag to selectedTags with category:', fullTagInfo);
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
      // Check if a tag with this name already exists
      const normalizedTagName = tagName.trim();
      const existingTag = Object.values(allAvailableTags).find(
        tag => tag.name.toLowerCase() === normalizedTagName.toLowerCase()
      );
      
      let tagToUse: Tag;
      
      if (existingTag) {
        // If tag already exists, use the existing tag
        tagToUse = existingTag;
        console.log('Using existing tag:', existingTag);
      } else {
        // Find the Custom category ID
        let customCategoryId: string;
        try {
          const categoryResponse = await tagCategoriesCollection.getFirstListItem('name="Custom"');
          customCategoryId = categoryResponse.id;
        } catch (error) {
          console.error('Error getting Custom category:', error);
          throw new Error('Custom category not found');
        }
        
        // Step 1: Create a new tag in the tags collection
        const newTagData = {
          name: normalizedTagName,
          description: "Custom user tag"
        };
        
        // Create the tag in the database
        const createdTag = await tagsCollection.create(newTagData);
        console.log('Created new tag:', createdTag);
        
        // Step 2: Link the tag to the Custom category
        await pb.collection('tag_categories_tags').create({
          tag_categories: customCategoryId,
          tags: createdTag.id
        });
        
        // Step 3: Get the tag with expanded category info
        const tagWithCategory = await tagsCollection.getOne(createdTag.id, {
          expand: 'tag_categories(tags),tag_categories_via_tags'
        });
        
        tagToUse = tagWithCategory as Tag;
        
        // Update allAvailableTags with the new tag
        setAllAvailableTags(prev => ({
          ...prev,
          [createdTag.id]: tagToUse
        }));
        
        // Update categoryTags structure
        setCategoryTags(prev => {
          const updatedCategoryTags = { ...prev };
          if (!updatedCategoryTags['Custom']) {
            updatedCategoryTags['Custom'] = [tagToUse];
          } else {
            updatedCategoryTags['Custom'] = [...updatedCategoryTags['Custom'], tagToUse];
          }
          return updatedCategoryTags;
        });
      }
      
      // Step 4: Check if the tag is already associated with this game
      let existingVote: GameTagVote | null = null;
      
      try {
        existingVote = await gameTagVotesCollection.getFirstListItem(`gameId="${gameId}" && tagId="${tagToUse.id}"`);
      } catch (error) {
        console.log('No existing vote found for this tag');
      }
      
      if (existingVote) {
        // If vote exists, add user to upVoters if not already there
        const upVoters = [...(existingVote.upVoters || [])];
        if (!upVoters.includes(user.id)) {
          upVoters.push(user.id);
          
          // Update the vote record
          const updatedVote = await gameTagVotesCollection.update(existingVote.id, {
            upVoters: upVoters
          });
          
          // Check if threshold is reached
          if (upVoters.length >= ACTIVATION_THRESHOLD) {
            await activateProposedTag(updatedVote);
          }
          
          // Update local state
          setTagVotes(prev => ({
            ...prev,
            [tagToUse.id]: updatedVote
          }));
        }
      } else {
        // Create new vote record
        const newVote: Partial<GameTagVote> = {
          gameId,
          tagId: tagToUse.id,
          votes: PROPOSED_TAG_VOTE_VALUE,
          upVoters: [user.id],
          downVoters: []
        };
        
        const createdVote = await gameTagVotesCollection.create(newVote);
        
        // Update local state
        setTagVotes(prev => ({
          ...prev,
          [tagToUse.id]: createdVote as GameTagVote
        }));
      }
      
      // Add tag to selectedTags if not already there
      setSelectedTags(prev => {
        if (!prev.some(t => t.id === tagToUse.id)) {
          return [...prev, tagToUse];
        }
        return prev;
      });
      
    } catch (error) {
      console.error('Error creating custom tag:', error);
      // You might want to show an error notification to the user here
    }
    
    handleCloseCustomPopover();
  };

  const shouldShowTag = (tag: Tag) => {
    const vote = tagVotes[tag.id];
    
    // Для неавторизованных пользователей
    if (!user) {
      // Показываем все теги кроме тех, что имеют голоса ниже порога
      if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD && vote.votes !== PROPOSED_TAG_VOTE_VALUE) {
        return false;
      }
      // Скрываем предложенные теги для неавторизованных
      if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
        return false;
      }
      return true;
    }
    
    // Для авторизованных пользователей - исходная логика
    // For proposed tags, always show to the proposer
    if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
      return vote.upVoters?.includes(user.id);
    }
    
    // If tag is in selectedTags, always show it to the current user
    if (selectedTags.some(t => t.id === tag.id)) {
      return true;
    }
    
    // Hide tags below threshold
    if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD) {
      return false;
    }
    
    return true;
  };

  const popoverOpen = Boolean(anchorEl);
  const customPopoverOpen = Boolean(customAnchorEl);

  // Отладка для отслеживания структуры groupedTags
  useEffect(() => {
    console.log('Grouped tags:', groupedTags);
  }, [groupedTags]);

  // Отображаем все категории, даже если у них нет тегов, но только для авторизованных пользователей
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const visibleTags = groupedTags[category].filter(tag => shouldShowTag(tag));
        
        // Показываем пустые категории только авторизованным пользователям
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

      {/* Regular tag selection popover for standard categories */}
      <AddTagPopover 
        open={popoverOpen}
        anchorEl={anchorEl}
        currentCategory={currentCategory}
        availableTags={availableTags}
        onClose={handleClosePopover}
        onTagSelect={handleTagSelect}
        isUpdating={isUpdating}
      />
      
      {/* Custom tag input popover for the Custom category */}
      <CustomTagPopover
        open={customPopoverOpen}
        anchorEl={customAnchorEl}
        onClose={handleCloseCustomPopover}
        onTagCreate={handleCustomTagCreate}
        availableTags={Object.values(allAvailableTags)} 
        isCreating={Object.values(isUpdating).some(v => v)}
        gameId={gameId} // Передаем ID игры
        tagVotes={tagVotes} // Передаем голоса тегов
        userId={user?.id} // Передаем ID пользователя (опционально)
      />
    </Box>
  );
}