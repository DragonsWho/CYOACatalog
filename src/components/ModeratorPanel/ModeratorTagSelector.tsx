// src/components/ModeratorPanel/ModeratorTagSelector.tsx
//
// Category-aware tag editor used by both the catalog editor (ModeratorPanel)
// and the pipeline review queue (PipelineReviewPanel). Self-loads tag
// categories + tags. `gameTags` is the current selection (only .id/.name are
// read, so any {id,name} shape works — full Tag objects or the trimmed objects
// the review endpoint returns). Emits the selected tag ids on every change.

import React, { useState, useEffect } from 'react';
import { Box, Typography, Chip, TextField, Button, CircularProgress } from '@mui/material';
import { tagsCollection, tagCategoriesCollection, Tag, TagCategory } from '../../pocketbase/pocketbase';

const ModeratorTagSelector: React.FC<{
  gameTags: Array<{ id: string; name: string }>; // current selection (id+name is enough)
  onTagsChange: (tagIds: string[]) => void;
}> = ({ gameTags, onTagsChange }) => {
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
        setIsLoading(true);
      try {
        const categories = await tagCategoriesCollection.getFullList({ expand: 'tags' });
        const tags = await tagsCollection.getFullList();
        setTagCategories(categories);
        setAvailableTags(tags);
        setIsLoading(false);
      } catch (error) {
        console.error('Error loading tags and categories:', error);
        setIsLoading(false);
      }
    };
    fetchData();
  }, []);

   // Синхронизация selectedTags при изменении gameTags
   useEffect(() => {
       let initialTagIds: string[] = [];
       // Проверяем, что gameTags - это массив объектов Tag
       if (gameTags && Array.isArray(gameTags) && gameTags.every(tag => typeof tag === 'object' && tag.id)) {
            initialTagIds = gameTags.map(tag => tag.id);
       } else {
           // Обработка случая, если gameTags пришел не в том формате (например, массив ID или что-то еще)
           console.warn("ModeratorTagSelector received gameTags in unexpected format. Using fallback.", gameTags);
           // Пытаемся использовать gameTags как массив ID, если это возможно, иначе пустой массив
           initialTagIds = Array.isArray(gameTags) ? gameTags.filter(item => typeof item === 'string') : [];
       }
       // <<<=== ИСПРАВЛЕНО: Устанавливаем отфильтрованный массив ID ===>>>
       // Убедимся, что ID существуют в availableTags, только если availableTags уже загружены
       if (availableTags.length > 0) {
           setSelectedTags(initialTagIds.filter(id => availableTags.some(at => at.id === id)));
       } else {
           setSelectedTags(initialTagIds); // Устанавливаем как есть, если availableTags еще не загружены
       }

   }, [gameTags, availableTags]); // Добавили availableTags в зависимости

  const handleTagToggle = (tagId: string, categoryId: string) => {
    const category = tagCategories.find(cat => cat.id === categoryId);
    if (!category) return;
    const categoryTagIds = (category.expand?.tags ?? []).map(t => t.id);
    const selectedInCategory = selectedTags.filter(id => categoryTagIds.includes(id));

    if (selectedTags.includes(tagId)) {
      const newTags = selectedTags.filter(id => id !== tagId);
      setSelectedTags(newTags);
      onTagsChange(newTags);
    } else if (selectedInCategory.length < category.max_tags) {
      const newTags = [...selectedTags, tagId];
      setSelectedTags(newTags);
      onTagsChange(newTags);
    }
  };

  const handleCustomTagCreate = async () => {
    const trimmedValue = inputValue.trim();
    if (!trimmedValue) return;
    const existingTag = availableTags.find(tag => tag.name.toLowerCase() === trimmedValue.toLowerCase());
    let tagToAddId: string | null = null;

    if (existingTag) { tagToAddId = existingTag.id; }
    else {
      try {
        const tagData = { name: trimmedValue, description: "Moderator-added custom tag" };
        const newTag = await tagsCollection.create(tagData);
        tagToAddId = newTag.id;
        setAvailableTags(prev => [...prev, newTag]);
        const customCategory = tagCategories.find(cat => cat.name === 'Custom');
        if (customCategory) {
          const currentCustomTagsIds = customCategory.expand?.tags?.map(t=>t.id) ?? [];
          if (!currentCustomTagsIds.includes(newTag.id)) {
              const updatedTagIds = [...currentCustomTagsIds, newTag.id];
              await tagCategoriesCollection.update(customCategory.id, { tags: updatedTagIds });
              customCategory.expand = customCategory.expand || {}; customCategory.expand.tags = customCategory.expand.tags || []; customCategory.expand.tags.push(newTag);
          }
        }
      } catch (error) { console.error('Error creating tag:', error); alert('Failed to create custom tag.'); return; }
    }
    if (tagToAddId && !selectedTags.includes(tagToAddId)) {
      const newTags = [...selectedTags, tagToAddId];
      setSelectedTags(newTags);
      onTagsChange(newTags);
    }
    setInputValue('');
  };

  const handleTagDelete = (tagId: string) => {
    const newTags = selectedTags.filter(id => id !== tagId);
    setSelectedTags(newTags);
    onTagsChange(newTags);
  };

  if (isLoading) return <CircularProgress size={24} />;

  const sortedCategories = tagCategories.filter(cat => cat.name !== 'Custom').sort((a, b) => {
      const order = ['Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime', 'Status', 'Gameplay', 'Genre', 'Setting', 'Tone', 'Narrative Structure', 'Power Level', 'Visual Style', 'Language', 'Kinks'];
      const indexA = order.indexOf(a.name); const indexB = order.indexOf(b.name);
      if (indexA === -1 && indexB === -1) return a.name.localeCompare(b.name); if (indexA === -1) return 1; if (indexB === -1) return -1; return indexA - indexB;
    });
  const customCategory = tagCategories.find(cat => cat.name === 'Custom');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1, border: '1px dashed #555', p:1, borderRadius: 1, minHeight: '30px' }}>
        {selectedTags.length === 0 && <Typography variant="caption" sx={{color:'#888'}}>No tags selected</Typography>}
        {selectedTags.map(tagId => { const tag = availableTags.find(t => t.id === tagId); if (!tag) return null; return ( <Chip key={tag.id} label={tag.name} onDelete={() => handleTagDelete(tag.id)} size="small" /> ); })}
      </Box>
      {sortedCategories.map(category => (
        <Box key={category.id} sx={{ mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 0.5 }}> {category.name} ({selectedTags.filter(id => (category.expand?.tags ?? []).some(t => t.id === id)).length}/{category.max_tags}) </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {(category.expand?.tags ?? []).map(tag => {
               const isSelected = selectedTags.includes(tag.id); const categoryTagIds = (category.expand?.tags ?? []).map(t => t.id); const selectedInCategoryCount = selectedTags.filter(id => categoryTagIds.includes(id)).length; const isDisabled = !isSelected && selectedInCategoryCount >= category.max_tags;
              return ( <Chip key={tag.id} label={tag.name} onClick={() => handleTagToggle(tag.id, category.id)} variant={isSelected ? 'filled' : 'outlined'} color={isSelected ? 'primary' : 'default'} disabled={isDisabled} size="small" sx={{ cursor: isDisabled ? 'not-allowed' : 'pointer', opacity: isDisabled ? 0.6 : 1 }} /> );
            })}
          </Box>
        </Box>
      ))}
     {customCategory && ( <Box mt={1}> <Typography variant="subtitle2" sx={{ fontWeight: 500, mb: 0.5 }}>Custom Tags</Typography> <Box sx={{ display: 'flex', gap: 1 }}> <TextField fullWidth variant="outlined" size="small" value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleCustomTagCreate()} placeholder="Add custom tag..." InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }} /> <Button variant="contained" size="small" onClick={handleCustomTagCreate} disabled={!inputValue.trim()}> Add </Button> </Box> </Box> )}
    </Box>
  );
};

export default ModeratorTagSelector;
