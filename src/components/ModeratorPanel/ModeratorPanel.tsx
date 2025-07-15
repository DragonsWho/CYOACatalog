// src/components/ModeratorPanel/ModeratorPanel.tsx

import React, { useState, useEffect, useContext } from 'react';
import { Container, Typography, Paper, Box, Button, TextField, Autocomplete, CircularProgress, Chip } from '@mui/material';
import { styled } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import {
    AuthContext, Game, gamesCollection, tagsCollection, tagCategoriesCollection, Tag, TagCategory, Author, pb, authorsCollection
} from '../../pocketbase/pocketbase';
import ImageCompressor from '../Add/ImageCompressor';
import CyoaImageUploader from '../Add/CyoaImageUploader';
import AuthorSelector from '../Add/AuthorSelector';
import GameRelationshipEditor from './GameRelationshipEditor';

// Styled component for consistent panel styling
const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

// ModeratorTagSelector component (ИСПРАВЛЕН useEffect)
const ModeratorTagSelector: React.FC<{
  gameTags: Tag[]; // Принимает массив полных объектов Tag
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


// Main moderator panel component (ИСПРАВЛЕНА authorsUpdated)
export default function ModeratorPanel() {
  const { signedIn, isModerator } = useContext(AuthContext);
  const navigate = useNavigate();
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [editedGame, setEditedGame] = useState<Partial<Game>>({});
  const [isLoadingGames, setIsLoadingGames] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [cardImage, setCardImage] = useState<File | null>(null);
  const [cyoaImages, setCyoaImages] = useState<File[]>([]);
  const [needsSplit, setNeedsSplit] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [availableAuthors, setAvailableAuthors] = useState<Author[]>([]);
  const [allAvailableTags, setAllAvailableTags] = useState<Tag[]>([]);

  useEffect(() => { if (!signedIn || !isModerator) { navigate('/'); } }, [signedIn, isModerator, navigate]);

  useEffect(() => {
    if (signedIn && isModerator) {
      setIsLoadingGames(true);
      Promise.all([ gamesCollection.getFullList({ sort: '-created', expand: 'tags,authors' }), authorsCollection.getFullList({ sort: '+name' }), tagsCollection.getFullList(), ])
        .then(([gamesRes, authorsRes, tagsRes]) => { setGames(gamesRes); setAvailableAuthors(authorsRes); setAllAvailableTags(tagsRes); setIsLoadingGames(false); })
        .catch((err) => { console.error('Error loading data:', err); setIsLoadingGames(false); });
    }
  }, [signedIn, isModerator]);

  const handleSelectGame = (game: Game | null) => {
    if (game) {
      setSelectedGame(game);
      setEditedGame({ title: game.title, description: game.description, image: game.image, iframe_url: game.iframe_url, tags: game.expand?.tags?.map(t => t.id) || [], img_or_link: game.img_or_link, cyoa_pages: game.cyoa_pages, });
      setCardImage(null); setCyoaImages([]); setNeedsSplit(false); setAuthors(game.expand?.authors || []);
    } else { setSelectedGame(null); setEditedGame({}); setCardImage(null); setCyoaImages([]); setNeedsSplit(false); setAuthors([]); }
  };

  const handleInputChange = (field: keyof Pick<Game, 'title' | 'description' | 'iframe_url'>) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setEditedGame((prev) => ({ ...prev, [field]: event.target.value })); };
  const handleTagsChange = (tagIds: string[]) => { setEditedGame((prev) => ({ ...prev, tags: tagIds })); };
  const handleCardImageChange = (file: File | null) => { setCardImage(file); };
  const handleCyoaImagesChange = (files: File[]) => { setCyoaImages(files); };
  const handleNeedsSplitChange = (splitNeeded: boolean) => { setNeedsSplit(splitNeeded); };
  const handleAuthorsChange = (newAuthors: Author[]) => { setAuthors(newAuthors); };
  const refreshAuthors = async () => { try { const d = await authorsCollection.getFullList({ sort: '+name' }); setAvailableAuthors(d); } catch (e) { console.error("Failed to refresh authors:", e); } };

  const handleSave = async () => {
    if (!selectedGame || !editedGame) return;
    if (needsSplit) { alert("Cannot save while image splitting is required."); return; }
    setIsSaving(true);

    try {
      const formData = new FormData(); let hasDataChanges = false;
       (['title', 'description', 'iframe_url'] as const).forEach(key => { if (editedGame[key] !== undefined && editedGame[key] !== selectedGame[key]) { formData.append(key, editedGame[key] as string); hasDataChanges = true; } });
       const originalTagIds = selectedGame.expand?.tags?.map(t => t.id).sort() || []; const editedTagIds = editedGame.tags?.sort() || [];
       if (JSON.stringify(originalTagIds) !== JSON.stringify(editedTagIds)) { formData.append('tags', ''); editedTagIds.forEach(tagId => formData.append('tags', tagId)); hasDataChanges = true; }
       if (cardImage) { formData.append('image', cardImage); hasDataChanges = true; }
       if (cyoaImages.length > 0 && editedGame.img_or_link === 'img') { formData.append('cyoa_pages-', ''); cyoaImages.forEach((image) => formData.append('cyoa_pages', image)); hasDataChanges = true; }

      let updatedGameResponse: Game | null = null;
      if (hasDataChanges) { updatedGameResponse = await gamesCollection.update(selectedGame.id, formData); }

      const originalAuthorIds = selectedGame.expand?.authors?.map(a => a.id).sort() || [];
      const selectedAuthorIds = authors.map(a => a.id).sort();
      if (JSON.stringify(originalAuthorIds) !== JSON.stringify(selectedAuthorIds)) { 
          await gamesCollection.update(selectedGame.id, { authors: selectedAuthorIds });
      }

      let finalGameDataForState: Game = updatedGameResponse ? { ...updatedGameResponse } : { ...selectedGame };
       finalGameDataForState.expand = { ...finalGameDataForState.expand, authors: authors };
       const finalTagIds = editedGame.tags || [];
       const finalTagsObjects = finalTagIds.map(id => allAvailableTags.find(tag => tag.id === id)).filter((tag): tag is Tag => tag !== undefined);
       finalGameDataForState.expand = { ...finalGameDataForState.expand, tags: finalTagsObjects };

      setGames((prev) => prev.map((g) => (g.id === selectedGame.id ? finalGameDataForState : g)));
      setSelectedGame(finalGameDataForState);
      setCardImage(null); setCyoaImages([]);
      alert('Game successfully updated!');
    } catch (err: any) {
      console.error('Error saving changes:', err); const pbError = err?.data?.data; let alertMessage = 'Failed to save changes.';
      if (pbError) { const fieldErrors = Object.entries(pbError).map(([field, errorData]) => `${field}: ${(errorData as any).message}`).join('\n'); alertMessage += `\nDetails:\n${fieldErrors}`; } else if (err.message) { alertMessage += `\n${err.message}`; } alert(alertMessage);
    } finally { setIsSaving(false); }
  };

  if (!signedIn || !isModerator) return null;

  return (
    <Container maxWidth="lg">
      <Typography variant="h4" component="h1" gutterBottom sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }} > Moderator Panel </Typography>
      <StyledPaper elevation={3}> <Typography variant="h6" gutterBottom> Select a game to edit </Typography> <Autocomplete options={games} getOptionLabel={(option) => `${option.title || 'Untitled'} (ID: ${option.id})`} renderInput={(params) => ( <TextField {...params} variant="outlined" label="Search for a game (Newest First)" placeholder="Enter title..." InputProps={{ ...params.InputProps, endAdornment: ( <> {isLoadingGames ? <CircularProgress color="inherit" size={20} /> : null} {params.InputProps.endAdornment} </> ), }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' }, '&:hover fieldset': { borderColor: '#ccc' }, '&.Mui-focused fieldset': { borderColor: 'primary.main' }, }, '& .MuiInputLabel-root': { color: '#aaa' }, '& .MuiAutocomplete-input': { color: '#e0e0e0' }, '& .MuiAutocomplete-popupIndicator': { color: '#aaa'}, '& .MuiAutocomplete-clearIndicator': { color: '#aaa'} }} /> )} onChange={(_, newValue) => handleSelectGame(newValue)} value={selectedGame} isOptionEqualToValue={(option, value) => option.id === value.id} loading={isLoadingGames} sx={{ width: '100%', mb: 2 }} slotProps={{ paper: { sx: { bgcolor: '#333', color: '#e0e0e0' } } }} /> </StyledPaper>
      {selectedGame && ( <StyledPaper elevation={3}> <Typography variant="h6" gutterBottom sx={{ borderBottom: '1px solid #555', pb: 1, mb: 2}}> Editing: {selectedGame.title} (ID: {selectedGame.id}) </Typography> <Box component="form" sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}> <TextField label="Title" value={editedGame.title || ''} onChange={handleInputChange('title')} fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <TextField label="Description" value={editedGame.description || ''} onChange={handleInputChange('description')} fullWidth multiline rows={4} InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <TextField label="Iframe URL (if applicable)" value={editedGame.iframe_url || ''} onChange={handleInputChange('iframe_url')} fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Authors</Typography> <AuthorSelector value={authors} onChange={handleAuthorsChange} availableAuthors={availableAuthors} onAuthorsChange={refreshAuthors} /> </Box> <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Game Card Image</Typography> {selectedGame.image && !cardImage && ( <Box component="a" href={pb.files.getUrl(selectedGame, selectedGame.image)} target="_blank" rel="noopener noreferrer"> <img src={pb.files.getUrl(selectedGame, selectedGame.image, { thumb: '100x100' })} alt="Current card" style={{ maxWidth: '100px', display:'block', marginBottom: '10px', border: '1px solid #555' }} /> </Box> )} <ImageCompressor onImageChange={handleCardImageChange} buttonText="Replace Card Image" /> {cardImage && <Typography sx={{ mt: 1, color: '#bbb', fontSize:'0.9rem' }}>New card selected: {cardImage.name}</Typography>} </Box> {selectedGame.img_or_link === 'img' && ( <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>CYOA Pages</Typography> {selectedGame.cyoa_pages?.length > 0 && cyoaImages.length === 0 && ( <Box sx={{ mb: 2, display:'flex', flexWrap:'wrap', gap: 1 }}> {selectedGame.cyoa_pages.map((page, index) => ( <Box component="a" href={pb.files.getUrl(selectedGame, page)} target="_blank" rel="noopener noreferrer" key={index}> <img src={pb.files.getUrl(selectedGame, page, { thumb: '100x100' })} alt={`Page ${index + 1}`} style={{ height: '70px', width:'auto', display:'block', border: '1px solid #555' }} /> </Box> ))} </Box> )} <CyoaImageUploader onImagesChange={handleCyoaImagesChange} onNeedsSplitChange={handleNeedsSplitChange}/> {cyoaImages.length > 0 && <Typography sx={{ mt: 1, color: '#bbb', fontSize:'0.9rem' }}>{cyoaImages.length} new page(s) selected.</Typography>} {needsSplit && <Typography color="error" sx={{ mt:1 }}>Cannot save: One or more images require splitting.</Typography>} </Box> )} <GameRelationshipEditor selectedGame={selectedGame} allGames={games} /> <Box sx={{ borderTop: '1px solid #555', pt: 2, mt:1 }}> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Tags</Typography> <ModeratorTagSelector gameTags={selectedGame.expand?.tags || []} onTagsChange={handleTagsChange} /> </Box> <Button variant="contained" color="primary" onClick={handleSave} disabled={needsSplit || isSaving} startIcon={isSaving ? <CircularProgress size={20} color="inherit" /> : null} sx={{ mt: 3, py: 1.5 }} > Save All Changes </Button> </Box> </StyledPaper> )}
    </Container>
  );
}