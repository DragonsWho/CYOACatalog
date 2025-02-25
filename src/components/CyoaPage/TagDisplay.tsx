import React, { useState, useContext, useEffect } from 'react';
import { Box } from '@mui/material';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, gamesCollection, pb } from '../../pocketbase/pocketbase';
import AddTagPopover from './AddTagPopover';
import TagCategoryComponent from './TagCategory';

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
];

export const PROPOSED_TAG_VOTE_VALUE = -1000;
export const ACTIVATION_THRESHOLD = 5;
export const INITIAL_ACTIVE_VOTE = -30;
export const HIDDEN_TAG_THRESHOLD = -50;
export const LOW_IMPORTANCE_THRESHOLD = -20;

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
  const [currentCategory, setCurrentCategory] = useState<string>('');
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [categoryTags, setCategoryTags] = useState<Record<string, Tag[]>>({});
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [allAvailableTags, setAllAvailableTags] = useState<Record<string, Tag>>({});

  // Загрузка всех доступных тегов и категорий
  useEffect(() => {
    const loadAllData = async () => {
      try {
        // Загружаем категории
        const categoriesResponse = await tagCategoriesCollection.getFullList();
        
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
          }
        });
        
        setCategoryTags(catTags);
        
        // Отладка
        console.log('Categories loaded:', categoriesResponse);
        console.log('Tags with categories:', tagsMap);
        console.log('Category tags:', catTags);
      } catch (error) {
        console.error('Ошибка при загрузке данных:', error);
      }
    };
    
    loadAllData();
  }, []);

  // Загрузка голосов и восстановление выбранных пользователем тегов
  useEffect(() => {
    const loadVotes = async () => {
      if (!user || Object.keys(categoryTags).length === 0 || Object.keys(allAvailableTags).length === 0) return;
      
      try {
        const votes = await gameTagVotesCollection.getFullList({
          filter: `gameId = "${gameId}"`,
        });
        
        const voteMap: Record<string, GameTagVote> = {};
        const userSelectedTagIds: string[] = [];
        
        votes.forEach((vote) => {
          voteMap[vote.tagId] = vote;
          
          // Проверяем, является ли тег предложенным пользователем
          if (vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters?.includes(user.id)) {
            userSelectedTagIds.push(vote.tagId);
          }
          
          if (vote.votes === PROPOSED_TAG_VOTE_VALUE && vote.upVoters && vote.upVoters.length >= ACTIVATION_THRESHOLD) {
            activateProposedTag(vote);
          }
        });
        
        setTagVotes(voteMap);
        
        // Восстанавливаем выбранные пользователем теги
        if (userSelectedTagIds.length > 0) {
          const userTags: Tag[] = [];
          
          // Для каждого ID тега найдем полную информацию с категорией
          userSelectedTagIds.forEach(tagId => {
            // Сначала ищем в allAvailableTags
            const tagInfo = allAvailableTags[tagId];
            
            if (tagInfo) {
              // Если информация о категории отсутствует, попробуем найти её в categoryTags
              if (!tagInfo.expand?.tag_categories_via_tags) {
                // Ищем категорию для этого тега
                let foundInCategory = false;
                
                Object.entries(categoryTags).forEach(([categoryName, tagsInCat]) => {
                  const matchingTag = tagsInCat.find(t => t.id === tagId);
                  if (matchingTag) {
                    // Нашли тег в категории, клонируем его
                    // Используем клонирование объекта, чтобы избежать проблем с типами
                    const tagWithCategory = structuredClone(tagInfo) as any;
                    
                    // Добавляем информацию о категории
                    if (!tagWithCategory.expand) tagWithCategory.expand = {};
                    
                    const categoryInfo = { name: categoryName };
                    tagWithCategory.expand.tag_categories_via_tags = [categoryInfo];
                    
                    userTags.push(tagWithCategory as Tag);
                    foundInCategory = true;
                  }
                });
                
                // Если не нашли в категориях, добавляем без категории
                if (!foundInCategory) {
                  userTags.push(tagInfo);
                }
              } else {
                // У тега уже есть информация о категории
                userTags.push(tagInfo);
              }
            }
          });
          
          console.log('Restored user tags:', userTags);
          setSelectedTags(userTags);
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

  if (!tags || tags.length === 0) {
    return null;
  }

  // Group tags by categories
  const groupedTags = tags.reduce<Record<string, Tag[]>>((acc, tag) => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Uncategorized';
    if (!acc[categoryName]) acc[categoryName] = [];
    acc[categoryName].push(tag);
    return acc;
  }, {});

  // Add the selected tags to their respective categories
  selectedTags.forEach(tag => {
    const categoryName = tag.expand?.tag_categories_via_tags?.[0]?.name ?? 'Uncategorized';
    if (!groupedTags[categoryName]) groupedTags[categoryName] = [];
    // Check if the tag is already in the group before adding
    if (!groupedTags[categoryName].some(t => t.id === tag.id)) {
      groupedTags[categoryName].push(tag);
    }
  });

  // Sort categories
  const sortedCategories = Object.keys(groupedTags).sort((a, b) => {
    const indexA = CATEGORY_ORDER.indexOf(a);
    const indexB = CATEGORY_ORDER.indexOf(b);
    if (indexA === -1 && indexB === -1) return 0;
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
  };

  const handleClosePopover = () => {
    setAnchorEl(null);
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

  const shouldShowTag = (tag: Tag) => {
    const vote = tagVotes[tag.id];
    
    // For proposed tags, always show to the proposer
    if (vote?.votes === PROPOSED_TAG_VOTE_VALUE) {
      return user && vote.upVoters?.includes(user.id);
    }
    
    // If tag is in selectedTags, always show it to the current user
    if (selectedTags.some(t => t.id === tag.id) && user) {
      return true;
    }
    
    // Hide tags below threshold
    if (vote && vote.votes <= HIDDEN_TAG_THRESHOLD) {
      return false;
    }
    
    return true;
  };

  const popoverOpen = Boolean(anchorEl);

  // Отладка для отслеживания структуры groupedTags
  useEffect(() => {
    console.log('Grouped tags:', groupedTags);
  }, [groupedTags]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: SECTION_GAP }}>
      {sortedCategories.map((category) => {
        const visibleTags = groupedTags[category].filter(tag => shouldShowTag(tag));
        
        if (visibleTags.length === 0) return null;
        
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
    </Box>
  );
}