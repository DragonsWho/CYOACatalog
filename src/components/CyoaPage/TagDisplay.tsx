//src/components/CyoaPage/TagDisplay.tsx

import React, { useState, useContext, useEffect } from 'react';
import { Box, Chip, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Tag, GameTagVote, AuthContext, gameTagVotesCollection, tagCategoriesCollection, tagCategoriesCollectionPublic, tagsCollection } from '../../pocketbase/pocketbase';
import AddTagPopover from './AddTagPopover';
import TagCategoryComponent from './TagCategory';
import CustomTagPopover from './CustomTagPopover';
import { castTagVote, TagVoteResult } from './tagVoteApi';
import { getTagColor, GOLD_ACCENT } from '../../utils/tagColors';
import { requestSearchTag } from '../../utils/searchTagBus';

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

// Two scales share game_tag_votes.votes (see the Go /tag-vote endpoint):
//  • Proposed tag — a suggestion not yet on the game, encoded in a reserved low
//    band: votes = PROPOSED_BASE + miniScore, so votes <= PROPOSED_BAND_MAX
//    means "proposed". miniScore is a small -5..+5 ballot (author starts at +1);
//    +PROMOTE_AT promotes it to an accepted tag at 0, -PROMOTE_AT drops it.
//  • Accepted tag — already on the game. votes = up - down directly.
// Tag-vote scoring + progress-bar geometry now lives in ./tagBar (pure, testable).
// Local uses need a real import; the re-export below keeps existing
// `from './TagDisplay'` consumers working (re-exports alone aren't local bindings).
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

// Categories where a "gold" defining tag is meaningful. Categories left out
// (Rating, Interactivity, Playtime, Status, Extra, Language) never glow even
// when a tag there is correct and highly upvoted — e.g. a gold "Full" Status
// tag would draw attention to nothing useful.
export const GOLD_ELIGIBLE = new Set<string>([
  'POV', 'Player Sexual Role', 'Gameplay', 'Genre', 'Setting', 'Tone',
  'Narrative Structure', 'Power Level', 'Visual Style', 'Kinks', 'Custom',
]);

export const SECTION_GAP = 0.5;

export default function TagDisplay({
  tags,
  gameId,
  editing = false,
}: {
  tags: Tag[];
  gameId: string;
  editing?: boolean;
}) {
  const { user } = useContext(AuthContext);
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  // A resting (non-edit) tag chip is a filter shortcut: tapping it opens the header
  // search overlay with that tag selected (see searchTagBus). Live everywhere since
  // the unified header shipped; only the compact mobile view renders these chips.
  const tagTapToSearch = true;
  // On a phone the resting view collapses to one wrapping row of compact,
  // category-coloured chips (like the catalog cards). Edit mode and desktop are
  // unchanged — the full per-category voting layout below still renders for them.
  const compact = !editing && isMobile;
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
          // --- ЕДИНЫЙ ЗАПРОС ---
          const combinedResponse = await tagCategoriesCollectionPublic.getFullList({
            fields: 'id,name,expand.tags.id,expand.tags.name',
            expand: 'tags'
          });
      
          // --- Обработка для получения всех трех состояний ---
          const categoryNames: string[] = [];
          const catTags: Record<string, Tag[]> = {};
          const tagsMap: Record<string, Tag> = {}; // Для allAvailableTags
      
          combinedResponse.forEach((category) => {
            // 1. Получаем имена категорий (для allCategories)
            categoryNames.push(category.name);
      
            const currentCategoryProcessedTags: Tag[] = [];
            if (category.expand?.tags) {
              // 2. Обрабатываем теги для categoryTags и allAvailableTags
              category.expand.tags.forEach(tagFromExpand => {
                // Создаем объект тега, который пойдет в оба состояния
                // Важно: Воссоздаем структуру expand, которую ожидает остальной код!
                const processedTag: Tag = {
                  id: tagFromExpand.id,
                  name: tagFromExpand.name, 
                  // Добавляем expand с информацией о ЕГО категории
                  expand: {
                    tag_categories_via_tags: [
                      {
                        // Можно добавить category.id если где-то нужно, но имя точно нужно
                        name: category.name
                      }
                    ]
                  }
                  // Важно: Не копируем системные поля типа created/updated из tagFromExpand
                } as any; // Используем 'as any' или создаем полноценный тип
      
                currentCategoryProcessedTags.push(processedTag); // Добавляем в список тегов этой категории
      
                // Добавляем тег в общую карту allAvailableTags
                // Если тег мог бы теоретически быть в нескольких категориях,
                // здесь он будет перезаписан последней встреченной. Обычно у тега одна основная категория.
                if (!tagsMap[processedTag.id]) {
                   tagsMap[processedTag.id] = processedTag;
                }
              });
            }
            // Сохраняем обработанные теги для данной категории (для categoryTags)
            catTags[category.name] = currentCategoryProcessedTags;
          });
      
          // Устанавливаем все состояния
          setAllCategories(categoryNames);
          setAllAvailableTags(tagsMap);
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
        // Оптимизированный запрос
        const votes = await gameTagVotesCollection.getFullList<GameTagVote>({ // Добавляем Generic тип для лучшей типизации
          filter: `gameId = "${gameId}"`,
          // Запрашиваем только нужные поля
          fields: 'id,tagId,gameId,votes,upVoters,downVoters'
        });

        const voteMap: Record<string, GameTagVote> = {};
        const userSelectedTagIds: string[] = [];

        votes.forEach((vote) => {
          // Теперь vote содержит только запрошенные поля, но этого достаточно
          voteMap[vote.tagId] = vote;

          if (user && isProposedVotes(vote.votes) && vote.upVoters?.includes(user.id)) {
            userSelectedTagIds.push(vote.tagId);
          }
          // Активация порога теперь на сервере (POST /api/custom/tag-vote),
          // поэтому здесь её больше нет — клиент не пишет games.tags.
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

  // Записать авторитетный результат голосования (с сервера) в локальный стейт:
  // обновить/добавить голос, либо убрать его, если предложение отброшено.
  const applyVoteResult = (tagId: string, result: TagVoteResult) => {
    setTagVotes(prev => {
      const next = { ...prev };
      if (result.vote) next[tagId] = result.vote;
      else delete next[tagId];
      return next;
    });
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

  // Чужие предложенные теги (proposed) не лежат в games.tags — подмешиваем их
  // из голосов, чтобы в режиме редактирования они показывались в своих рядах.
  Object.values(tagVotes).forEach(vote => {
    if (!isProposedVotes(vote.votes)) return;
    const proposedTag = allAvailableTags[vote.tagId];
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

  // Gold = every accepted tag at GOLD_THRESHOLD+ in an eligible category.
  // No per-game cap — eligibility is gated purely by category. Display accent.
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

    // One click cycles your vote: none → up → down → clear. The server resolves
    // everything else — promote a proposal that crossed +5, drop one that fell to
    // -5 (or lost all support), or remove an accepted tag downvoted to -20.
    let userVoteStatus = 0;
    if (currentVote) {
      if (currentVote.upVoters?.includes(userId)) userVoteStatus = 1;
      else if (currentVote.downVoters?.includes(userId)) userVoteStatus = -1;
    }
    const action = userVoteStatus === 0 ? 'upvote' : userVoteStatus === 1 ? 'downvote' : 'clear';

    // Nothing to clear when there's no vote yet.
    if (!currentVote && action === 'clear') return;

    setIsUpdating(prev => ({ ...prev, [tag.id]: true }));
    try {
      const result = await castTagVote(gameId, tag.id, action);
      applyVoteResult(tag.id, result);
      if (result.deleted) {
        setSelectedTags(prev => prev.filter(t => t.id !== tag.id));
      }
    } catch (error) {
      console.error('Ошибка при голосовании:', error);
    } finally {
      setTimeout(() => {
        setIsUpdating(prev => ({ ...prev, [tag.id]: false }));
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
      // Все предложенные теги теперь рендерятся прямо в рядах (в режиме редактирования)
      // со шкалой n/5 — поэтому в попапе «добавить» их больше не показываем (никакого
      // дублирования и плоских чипов без числа). Попап = только ещё не предложенные теги.
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
      
      // Сервер сам найдёт/создаст голос, добавит ТОЛЬКО текущего юзера в upVoters
      // и активирует тег (допишет в games.tags) при достижении порога.
      const result = await castTagVote(gameId, tag.id, 'upvote');
      applyVoteResult(tag.id, result);

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
      
      // Голос за (только что созданный) тег — через сервер: поддержка от текущего
      // юзера + активация при пороге. Создание самого тега осталось выше.
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
    // Faded = accepted tag downvoted into the delete ballot (score <= -5). It's
    // hidden from the public/resting view and only shown (gray) in edit mode,
    // where people can finish the removal vote or rescue it back above -5.
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

  // Compact mobile resting view: a single wrapping row of category-coloured chips,
  // ordered by CATEGORY_ORDER, using the same visibility filter as the full view.
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
                backdropFilter: 'blur(2px)',
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
      {/* display:flow-root — контейнер содержит плавающую инструкцию; строки категорий
          (каждая — flex) обтекают её: компактные верхние рядом, широкие нижние снизу. */}
      <Box sx={{ display: 'flow-root' }}>
        {editing && (
          <Box
            sx={{
              // Desktop: floats right of the (always short, 1-2 tag) category rows.
              // Mobile: full-width block above every tag.
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

          // В покое прячем пустые категории; в режиме показываем все (есть куда добавлять).
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
      />
    </Box>
  );
}