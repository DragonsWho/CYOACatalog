// src/components/ModeratorPanel/ModeratorPanel.tsx

import React, { useState, useEffect, useContext } from 'react';
import { Container, Typography, Paper, Box, Button, TextField, Autocomplete, CircularProgress } from '@mui/material';
import { styled } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';
import {
    AuthContext, Game, gamesCollection, tagsCollection, Tag, Author, pb, authorsCollection
} from '../../pocketbase/pocketbase';
import CardImageCropper from '../Add/CardImageCropper';
import CyoaImageUploader from '../Add/CyoaImageUploader';
import AuthorSelector from '../Add/AuthorSelector';
import GameRelationshipEditor from './GameRelationshipEditor';
import ModeratorTagSelector from './ModeratorTagSelector';
import { normalizeGameAliases } from '../../utils/aliases';

// Styled component for consistent panel styling
const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

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
      setEditedGame({ title: game.title, description: game.description, image: game.image, iframe_url: game.iframe_url, aliases: game.aliases || '', tags: game.expand?.tags?.map(t => t.id) || [], img_or_link: game.img_or_link, cyoa_pages: game.cyoa_pages, });
      setCardImage(null); setCyoaImages([]); setNeedsSplit(false); setAuthors(game.expand?.authors || []);
    } else { setSelectedGame(null); setEditedGame({}); setCardImage(null); setCyoaImages([]); setNeedsSplit(false); setAuthors([]); }
  };

  const handleInputChange = (field: keyof Pick<Game, 'title' | 'description' | 'iframe_url' | 'aliases'>) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setEditedGame((prev) => ({ ...prev, [field]: event.target.value })); };
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
       // Альт-названия: нормализуем ПЕРЕД сравнением (по строкам, дедуп, выкидываем
       // совпадение с основным title) — иначе лишний перевод строки уедет как «правка».
       // Та же нормализация в game_edits.go и в pipeline.py aliases, см. utils/aliases.ts.
       if (editedGame.aliases !== undefined) { const nextAliases = normalizeGameAliases(editedGame.aliases, editedGame.title ?? selectedGame.title); if (nextAliases !== (selectedGame.aliases || '')) { formData.append('aliases', nextAliases); hasDataChanges = true; } }
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
      {selectedGame && ( <StyledPaper elevation={3}> <Typography variant="h6" gutterBottom sx={{ borderBottom: '1px solid #555', pb: 1, mb: 2}}> Editing: {selectedGame.title} (ID: {selectedGame.id}) </Typography> <Box component="form" sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}> <TextField label="Title" value={editedGame.title || ''} onChange={handleInputChange('title')} fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <TextField label="Alternative titles (one per line)" value={editedGame.aliases || ''} onChange={handleInputChange('aliases')} fullWidth multiline rows={2} inputProps={{ maxLength: 2000 }} helperText="Other names this CYOA is known by: re-releases, translated names, thread nicknames. Searched together with the title; shown greyed out above the tags." InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} FormHelperTextProps={{ style: { color: '#888' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <TextField label="Description" value={editedGame.description || ''} onChange={handleInputChange('description')} fullWidth multiline rows={4} InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <TextField label="Iframe URL (if applicable)" value={editedGame.iframe_url || ''} onChange={handleInputChange('iframe_url')} fullWidth InputLabelProps={{ style: { color: '#aaa' } }} InputProps={{ style: { color: '#e0e0e0' } }} sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#aaa' } } }}/> <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Authors</Typography> <AuthorSelector value={authors} onChange={handleAuthorsChange} availableAuthors={availableAuthors} onAuthorsChange={refreshAuthors} /> </Box> <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Game Card Image</Typography> {selectedGame.image && !cardImage && ( <Box component="a" href={pb.files.getUrl(selectedGame, selectedGame.image)} target="_blank" rel="noopener noreferrer"> <img src={pb.files.getUrl(selectedGame, selectedGame.image, { thumb: '100x100' })} alt="Current card" style={{ maxWidth: '100px', display:'block', marginBottom: '10px', border: '1px solid #555' }} /> </Box> )} <CardImageCropper onImageChange={handleCardImageChange} buttonText="Replace Card Image" /> {cardImage && <Typography sx={{ mt: 1, color: '#bbb', fontSize:'0.9rem' }}>New card selected: {cardImage.name}</Typography>} </Box> {selectedGame.img_or_link === 'img' && ( <Box> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>CYOA Pages</Typography> {selectedGame.cyoa_pages?.length > 0 && cyoaImages.length === 0 && ( <Box sx={{ mb: 2, display:'flex', flexWrap:'wrap', gap: 1 }}> {selectedGame.cyoa_pages.map((page, index) => ( <Box component="a" href={pb.files.getUrl(selectedGame, page)} target="_blank" rel="noopener noreferrer" key={index}> <img src={pb.files.getUrl(selectedGame, page, { thumb: '100x100' })} alt={`Page ${index + 1}`} style={{ height: '70px', width:'auto', display:'block', border: '1px solid #555' }} /> </Box> ))} </Box> )} <CyoaImageUploader onImagesChange={handleCyoaImagesChange} onNeedsSplitChange={handleNeedsSplitChange}/> {cyoaImages.length > 0 && <Typography sx={{ mt: 1, color: '#bbb', fontSize:'0.9rem' }}>{cyoaImages.length} new page(s) selected.</Typography>} {needsSplit && <Typography color="error" sx={{ mt:1 }}>Cannot save: One or more images require splitting.</Typography>} </Box> )} <GameRelationshipEditor selectedGame={selectedGame} allGames={games} /> <Box sx={{ borderTop: '1px solid #555', pt: 2, mt:1 }}> <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>Tags</Typography> <ModeratorTagSelector gameTags={selectedGame.expand?.tags || []} onTagsChange={handleTagsChange} /> </Box> <Button variant="contained" color="primary" onClick={handleSave} disabled={needsSplit || isSaving} startIcon={isSaving ? <CircularProgress size={20} color="inherit" /> : null} sx={{ mt: 3, py: 1.5 }} > Save All Changes </Button> </Box> </StyledPaper> )}
    </Container>
  );
}