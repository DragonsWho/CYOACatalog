import React, { useState, useEffect, useContext } from 'react';
import { Container, Typography, Paper, Box, Button, TextField, Autocomplete, CircularProgress, Chip } from '@mui/material';
import { styled } from '@mui/material/styles';  
import { useNavigate } from 'react-router-dom';
import { AuthContext, Game, gamesCollection, tagsCollection, tagCategoriesCollection, Tag, TagCategory, Author, pb, authorsCollection } from '../../pocketbase/pocketbase';
import ImageCompressor from '../Add/ImageCompressor';
import CyoaImageUploader from '../Add/CyoaImageUploader';
import AuthorSelector from '../Add/AuthorSelector';

// Styled component for consistent panel styling
const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(3),
  margin: theme.spacing(3, 0),
  backgroundColor: '#2e2e2e',
  color: '#e0e0e0',
  borderRadius: 8,
}));

// Tag selector component for managing game tags
const ModeratorTagSelector: React.FC<{
  gameTags: Tag[];
  onTagsChange: (tagIds: string[]) => void;
}> = ({ gameTags, onTagsChange }) => {
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>(gameTags.map(tag => tag.id));
  const [inputValue, setInputValue] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  // Fetch tags and categories on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        const categories = await tagCategoriesCollection.getFullList({ expand: 'tags' });
        const tags = await tagsCollection.getFullList();
        setTagCategories(categories);
        setAvailableTags(tags);
        setIsLoading(false);
      } catch (error) {
        console.error('Error loading tags and categories:', error);
      }
    };
    fetchData();
  }, []);

  // Toggle tag selection based on category limits
  const handleTagToggle = (tagId: string, categoryId: string) => {
    const category = tagCategories.find(cat => cat.id === categoryId);
    if (!category) return;

    const categoryTags = selectedTags.filter(id => category.tags.includes(id));
    if (selectedTags.includes(tagId)) {
      const newTags = selectedTags.filter(id => id !== tagId);
      setSelectedTags(newTags);
      onTagsChange(newTags);
    } else if (categoryTags.length < category.max_tags) {
      const newTags = [...selectedTags, tagId];
      setSelectedTags(newTags);
      onTagsChange(newTags);
    }
  };

  // Create a new custom tag
  const handleCustomTagCreate = async () => {
    const trimmedValue = inputValue.trim();
    if (!trimmedValue) return;

    const existingTag = availableTags.find(tag => tag.name.toLowerCase() === trimmedValue.toLowerCase());
    if (existingTag) {
      if (!selectedTags.includes(existingTag.id)) {
        const newTags = [...selectedTags, existingTag.id];
        setSelectedTags(newTags);
        onTagsChange(newTags);
      }
    } else {
      try {
        const tagData = { name: trimmedValue, description: "Moderator-added tag" };
        const newTag = await tagsCollection.create(tagData);
        const customCategory = tagCategories.find(cat => cat.name === 'Custom');
        if (customCategory) {
          const updatedTags = [...(customCategory.tags || []), newTag.id];
          await tagCategoriesCollection.update(customCategory.id, { tags: updatedTags });
        }
        setAvailableTags(prev => [...prev, newTag]);
        const newTags = [...selectedTags, newTag.id];
        setSelectedTags(newTags);
        onTagsChange(newTags);
      } catch (error) {
        console.error('Error creating tag:', error);
      }
    }
    setInputValue('');
  };

  // Remove a tag from selected tags
  const handleTagDelete = (tagId: string) => {
    const newTags = selectedTags.filter(id => id !== tagId);
    setSelectedTags(newTags);
    onTagsChange(newTags);
  };

  if (isLoading) return <CircularProgress size={24} />;

  // Sort categories in a predefined order
  const sortedCategories = tagCategories
    .filter(cat => cat.name !== 'Custom')
    .sort((a, b) => {
      const order = [
        'Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime', 'Status',
        'Gameplay', 'Genre', 'Setting', 'Tone', 'Narrative Structure', 'Power Level',
        'Visual Style', 'Language', 'Kinks'
      ];
      const indexA = order.indexOf(a.name);
      const indexB = order.indexOf(b.name);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Display selected tags */}
      <Box>
        {selectedTags.map(tagId => {
          const tag = availableTags.find(t => t.id === tagId);
          if (!tag) return null;
          return (
            <Chip
              key={tag.id}
              label={tag.name}
              onDelete={() => handleTagDelete(tag.id)}
              sx={{ m: 0.5 }}
            />
          );
        })}
      </Box>

      {/* Category-based tag selection */}
      {sortedCategories.map(category => (
        <Box key={category.id}>
          <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
            {category.name}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {category.expand?.tags?.map(tag => {
              const isSelected = selectedTags.includes(tag.id);
              const isDisabled = !isSelected && selectedTags.filter(id => category.tags.includes(id)).length >= category.max_tags;
              return (
                <Chip
                  key={tag.id}
                  label={tag.name}
                  onClick={() => handleTagToggle(tag.id, category.id)}
                  variant={isSelected ? 'filled' : 'outlined'}
                  color={isSelected ? 'primary' : 'default'}
                  disabled={isDisabled}
                  sx={{ height: '24px', borderRadius: '4px', m: 0.5 }}
                />
              );
            })}
          </Box>
        </Box>
      ))}

      {/* Custom tag input */}
      <Box mt={2}>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>Custom Tags</Typography>
        <TextField
          fullWidth
          variant="outlined"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCustomTagCreate()}
          placeholder="Add custom tag..."
          sx={{ mt: 1 }}
        />
        <Button
          variant="contained"
          color="primary"
          onClick={handleCustomTagCreate}
          disabled={!inputValue.trim()}
          sx={{ mt: 1 }}
        >
          Add Custom Tag
        </Button>
      </Box>
    </Box>
  );
};

// Main moderator panel component
export default function ModeratorPanel() {
  const { signedIn, isModerator } = useContext(AuthContext);
  const navigate = useNavigate();
  const [games, setGames] = useState<Game[]>([]);
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  const [editedGame, setEditedGame] = useState<Partial<Game>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [cardImage, setCardImage] = useState<File | null>(null);
  const [cyoaImages, setCyoaImages] = useState<File[]>([]);
  const [needsSplit, setNeedsSplit] = useState(false);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [availableAuthors, setAvailableAuthors] = useState<Author[]>([]);

  // Redirect non-moderators to homepage
  useEffect(() => {
    if (!signedIn || !isModerator) {
      navigate('/');
    }
  }, [signedIn, isModerator, navigate]);

  // Load games and authors on mount
  useEffect(() => {
    if (signedIn && isModerator) {
      setIsLoading(true);
      Promise.all([
        gamesCollection.getFullList({ sort: '-created', expand: 'tags,authors_via_games' }),
        authorsCollection.getFullList(),
      ])
        .then(([gamesRes, authorsRes]) => {
          setGames(gamesRes);
          setAvailableAuthors(authorsRes);
          setIsLoading(false);
        })
        .catch((err) => {
          console.error('Error loading data:', err);
          setIsLoading(false);
        });
    }
  }, [signedIn, isModerator]);

  // Handle game selection
  const handleSelectGame = (game: Game | null) => {
    if (game) {
      setSelectedGame(game);
      setEditedGame({
        title: game.title,
        description: game.description,
        image: game.image,
        iframe_url: game.iframe_url,
        tags: game.tags,
        img_or_link: game.img_or_link,
        cyoa_pages: game.cyoa_pages,
      });
      setCardImage(null);
      setCyoaImages([]);
      setAuthors(game.expand?.authors_via_games || []);
    } else {
      setSelectedGame(null);
      setEditedGame({});
      setCardImage(null);
      setCyoaImages([]);
      setAuthors([]);
    }
  };

  // Handle text field changes
  const handleInputChange = (field: keyof Game) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setEditedGame((prev) => ({ ...prev, [field]: event.target.value }));
  };

  // Handle tag updates
  const handleTagsChange = (tagIds: string[]) => {
    setEditedGame((prev) => ({ ...prev, tags: tagIds }));
  };

  // Handle card image updates
  const handleCardImageChange = (file: File | null) => {
    setCardImage(file);
  };

  // Handle CYOA image updates
  const handleCyoaImagesChange = (files: File[]) => {
    setCyoaImages(files);
  };

  // Handle split requirement changes
  const handleNeedsSplitChange = (splitNeeded: boolean) => {
    setNeedsSplit(splitNeeded);
  };

  // Handle author updates
  const handleAuthorsChange = (newAuthors: Author[]) => {
    setAuthors(newAuthors);
  };

  // Refresh available authors list
  const refreshAuthors = async () => {
    const authorsData = await authorsCollection.getFullList();
    setAvailableAuthors(authorsData);
  };

  // Save changes to the selected game
  const handleSave = async () => {
    if (!selectedGame || !editedGame) return;

    try {
      const formData = new FormData();

      // Append text fields
      if (editedGame.title) formData.append('title', editedGame.title);
      if (editedGame.description) formData.append('description', editedGame.description);
      if (editedGame.iframe_url) formData.append('iframe_url', editedGame.iframe_url);
      if (editedGame.tags) editedGame.tags.forEach((tag) => formData.append('tags', tag));

      // Append new card image
      if (cardImage) {
        formData.append('image', cardImage);
      }

      // Append new CYOA images
      if (cyoaImages.length > 0 && editedGame.img_or_link === 'img') {
        formData.append('cyoa_pages-', '');
        cyoaImages.forEach((image) => formData.append('cyoa_pages', image));
      }

      // Update game data
      const updatedGame = await gamesCollection.update(selectedGame.id, formData);

      // Update authors
      const currentAuthors = selectedGame.expand?.authors_via_games || [];
      const authorsToRemove = currentAuthors.filter((author) => !authors.some((a) => a.id === author.id));
      const authorsToAdd = authors.filter((author) => !currentAuthors.some((a) => a.id === author.id));

      for (const author of authorsToRemove) {
        await authorsCollection.update(author.id, { 'games-': selectedGame.id });
      }
      for (const author of authorsToAdd) {
        await authorsCollection.update(author.id, { 'games+': selectedGame.id });
      }

      // Update local state
      setGames((prev) =>
        prev.map((g) => (g.id === selectedGame.id ? { ...g, ...updatedGame, expand: { ...g.expand, authors_via_games: authors } } : g))
      );
      setSelectedGame((prev) => prev && { ...prev, ...updatedGame, expand: { ...prev.expand, authors_via_games: authors } });
      alert('Game successfully updated!');
    } catch (err) {
      console.error('Error saving changes:', err);
      alert('Failed to save changes.');
    }
  };

  if (!signedIn || !isModerator) return null;

  return (
    <Container maxWidth="md">
      <Typography
        variant="h4"
        component="h1"
        gutterBottom
        sx={{ mt: 4, color: '#e0e0e0', textAlign: 'center', fontSize: { xs: '2rem', sm: '2.5rem' } }}
      >
        Moderator Panel
      </Typography>

      <StyledPaper elevation={3}>
        <Typography variant="h6" gutterBottom>
          Select a game to edit
        </Typography>
        <Autocomplete
          options={games}
          getOptionLabel={(option) => option.title || 'Untitled'}
          renderInput={(params) => (
            <TextField
              {...params}
              variant="outlined"
              label="Search for a game"
              placeholder="Enter title..."
              InputProps={{
                ...params.InputProps,
                endAdornment: (
                  <>
                    {isLoading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ),
                style: { color: '#e0e0e0' },
              }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{
                '& .MuiOutlinedInput-root': {
                  '& fieldset': { borderColor: '#e0e0e0' },
                  '&:hover fieldset': { borderColor: '#e0e0e0' },
                  '&.Mui-focused fieldset': { borderColor: '#e0e0e0' },
                },
              }}
            />
          )}
          onChange={(_, newValue) => handleSelectGame(newValue)}
          value={selectedGame}
          loading={isLoading}
          sx={{ width: '100%', mb: 2 }}
        />
      </StyledPaper>

      {selectedGame && (
        <StyledPaper elevation={3}>
          <Typography variant="h6" gutterBottom>
            Editing: {selectedGame.title}
          </Typography>
          <Box component="form" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Title"
              value={editedGame.title || ''}
              onChange={handleInputChange('title')}
              fullWidth
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />
            <TextField
              label="Description"
              value={editedGame.description || ''}
              onChange={handleInputChange('description')}
              fullWidth
              multiline
              rows={4}
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />
            <TextField
              label="Iframe URL (if applicable)"
              value={editedGame.iframe_url || ''}
              onChange={handleInputChange('iframe_url')}
              fullWidth
              InputProps={{ style: { color: '#e0e0e0' } }}
              InputLabelProps={{ style: { color: '#e0e0e0' } }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: '#e0e0e0' } } }}
            />

            {/* Authors section */}
            <Box>
              <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                Authors
              </Typography>
              <AuthorSelector
                value={authors}
                onChange={handleAuthorsChange}
                availableAuthors={availableAuthors}
                onAuthorsChange={refreshAuthors}
              />
            </Box>

            {/* Game card section */}
            <Box>
              <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                Game Card
              </Typography>
              {selectedGame.image && !cardImage && (
                <img
                  src={pb.files.getUrl(selectedGame, selectedGame.image)}
                  alt="Current card"
                  style={{ maxWidth: '200px', marginBottom: '10px' }}
                />
              )}
              <ImageCompressor onImageChange={handleCardImageChange} buttonText="Replace Card" />
              {cardImage && (
                <Typography sx={{ mt: 1, color: '#e0e0e0' }}>
                  New card: {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
                </Typography>
              )}
            </Box>

            {/* CYOA pages section */}
            {selectedGame.img_or_link === 'img' && (
              <Box>
                <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                  CYOA Pages
                </Typography>
                {selectedGame.cyoa_pages?.length > 0 && cyoaImages.length === 0 && (
                  <Box sx={{ mb: 2 }}>
                    {selectedGame.cyoa_pages.map((page, index) => (
                      <img
                        key={index}
                        src={pb.files.getUrl(selectedGame, page)}
                        alt={`CYOA page ${index + 1}`}
                        style={{ maxWidth: '200px', marginRight: '10px', marginBottom: '10px' }}
                      />
                    ))}
                  </Box>
                )}
                <CyoaImageUploader
                  onImagesChange={handleCyoaImagesChange}
                  onNeedsSplitChange={handleNeedsSplitChange}
                />
                {cyoaImages.length > 0 && (
                  <Typography sx={{ mt: 1, color: '#e0e0e0' }}>
                    New pages uploaded: {cyoaImages.length}
                  </Typography>
                )}
              </Box>
            )}

            {/* Tags section */}
            <Box>
              <Typography variant="subtitle1" gutterBottom sx={{ color: '#e0e0e0' }}>
                Tags
              </Typography>
              <ModeratorTagSelector gameTags={selectedGame.expand?.tags || []} onTagsChange={handleTagsChange} />
            </Box>

            <Button
              variant="contained"
              color="primary"
              onClick={handleSave}
              disabled={needsSplit}
            >
              Save Changes
            </Button>
          </Box>
        </StyledPaper>
      )}
    </Container>
  );
}