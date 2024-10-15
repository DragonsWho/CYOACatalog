// src/components/Add/CreateGame.tsx
// Version 2.2.2
// Updated to fix linting error with AxiosError and improve error handling

import { useState, useEffect, ChangeEvent, FormEvent, useContext } from 'react';
import {
  TextField,
  Button,
  Box,
  Typography,
  CircularProgress,
  Select,
  MenuItem,
  InputLabel,
  FormControl,
  Alert,
  SelectChangeEvent,
} from '@mui/material';
import { useNavigate } from 'react-router-dom';
import AuthorSelector from './AuthorSelector';
import TagSelector from './TagSelector';
import CyoaImageUploader from './CyoaImageUploader';
import ImageCompressor from './ImageCompressor';
import {
  AuthContext,
  Author,
  authorsCollection,
  gamesCollection,
  tagCategoriesCollection,
  TagCategory,
} from '../../pocketbase/pocketbase';

import { encode as webpencode } from '@jsquash/webp';

import DOMPurify from 'dompurify';

export default function CreateGame() {
  const [title, setTitle] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [cardImage, setCardImage] = useState<File | null>(null);
  const [cyoaImages, setCyoaImages] = useState<File[]>([]);
  const [imgOrLink, setImgOrLink] = useState<'img' | 'link'>('img');
  const [iframeUrl, setIframeUrl] = useState<string>('');
  const [authors, setAuthors] = useState<Author[]>([]);
  const [availableAuthors, setAvailableAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [initialDataLoading, setInitialDataLoading] = useState<boolean>(true);
  const [splitsNeeded, setSplitsNeeded] = useState<boolean>(false);
  const { user } = useContext(AuthContext);

  const navigate = useNavigate();

  async function refreshAuthors() {
    const authorsData = await authorsCollection.getFullList();
    setAvailableAuthors(authorsData);
  }

  async function refreshTagCategories() {
    const categoriesData = await tagCategoriesCollection.getFullList({ expand: 'tags' });
    setTagCategories(categoriesData);
  }

  useEffect(() => {
    Promise.all([refreshAuthors(), refreshTagCategories()]).then(() => {
      setInitialDataLoading(false);
    });
  }, []);

  function handleCardImageChange(compressedImage: File | null) {
    setCardImage(compressedImage);
  }

  function handleCyoaImagesChange(newImages: File[]) {
    setCyoaImages(newImages);
  }

  function handleNeedsSplitChange(splitNeeded: boolean) {
    setSplitsNeeded(splitNeeded);
  }

  function validateTags(): string[] {
    const errors: string[] = [];
    for (const category of tagCategories) {
      const categoryTags = selectedTags.filter((tagId) => category.expand?.tags?.some((tag) => tag.id === tagId));
      if (categoryTags.length < category.min_tags)
        errors.push(`${category.name} requires at least ${category.min_tags} tag(s)`);
    }
    return errors;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!title.trim()) {
      setError('Title is required.');
      setLoading(false);
      return;
    }

    if (!description.trim()) {
      setError('Description is required.');
      setLoading(false);
      return;
    }

    if (!cardImage) {
      setError('Please upload a card image.');
      setLoading(false);
      return;
    }

    if (imgOrLink === 'img' && cyoaImages.length === 0) {
      setError('Please upload at least one CYOA page image.');
      setLoading(false);
      return;
    }

    if (imgOrLink === 'link' && !iframeUrl.trim()) {
      setError('Please provide an iframe URL.');
      setLoading(false);
      return;
    }

    const tagErrors = validateTags();
    if (tagErrors.length > 0) {
      setError(`Tag selection errors:\n${tagErrors.join('\n')}`);
      setLoading(false);
      return;
    }

    if (splitsNeeded) {
      setError('Please split images into vertical segments of less than 16,383 pixels.');
      setLoading(false);
      return;
    }

    const formData = new FormData();

    const descriptionData = DOMPurify.sanitize(`<p>${description}</p>`);

    formData.append('title', title);
    formData.append('description', descriptionData);
    formData.append('image', new Blob([cardImage], { type: cardImage.type }));
    for (const tag of selectedTags) formData.append('tags', tag);
    formData.append('img_or_link', imgOrLink);
    if (imgOrLink === 'link') formData.append('iframe_url', iframeUrl);
    if (imgOrLink === 'img') {
      for (const imageFile of cyoaImages) {
        // convert to imageData for encoder

          let image;
          // if it isn't an image return the file unchanged
          try {
            image = await createImageBitmap(imageFile);
          } catch (e) {
            return imageFile;
          }

          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d', { alpha: false });
          ctx!.drawImage(image, 0 ,0, image.width, image.height);
          const imageData = ctx!.getImageData(0, 0, image.width, image.height);

          const webPBuffer = await webpencode(imageData!, {quality: 75, lossless: 1});

          const b = new Blob([webPBuffer]);

          formData.append('cyoa_pages', new Blob([b], { type: 'image/webp' }));
        }
    }
    if (user) formData.append('uploader', user.id);

    const res = await gamesCollection.create(formData);
    for (const author of authors) await authorsCollection.update(author.id, { 'games+': [res.id] });
    console.log('Created game:', res.id);
    navigate('/');
    setLoading(false);
  }

  if (initialDataLoading) {
    return <CircularProgress />;
  }

  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 600, margin: 'auto', mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Add a New Cyoa!
      </Typography>
      <TextField
        fullWidth
        label="Title"
        value={title}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
        margin="normal"
        required
      />
      <TextField
        fullWidth
        label="Description"
        value={description}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
        margin="normal"
        required
        multiline
        rows={4}
      />
      <FormControl fullWidth margin="normal">
        <InputLabel id="img-or-link-label">Image or Link</InputLabel>
        <Select
          labelId="img-or-link-label"
          value={imgOrLink}
          onChange={(e: SelectChangeEvent<'img' | 'link'>) => setImgOrLink(e.target.value as 'img' | 'link')}
          label="Image or Link"
        >
          <MenuItem value="img">Image</MenuItem>
          <MenuItem value="link">Link</MenuItem>
        </Select>
      </FormControl>
      {imgOrLink === 'link' && (
        <TextField
          fullWidth
          label="iframe URL"
          value={iframeUrl}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setIframeUrl(e.target.value)}
          margin="normal"
          required
        />
      )}
      <Box sx={{ mt: 2 }}>
        <AuthorSelector
          value={authors}
          onChange={setAuthors}
          availableAuthors={availableAuthors}
          onAuthorsChange={() => refreshAuthors()}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Select Tags</Typography>
        <TagSelector selectedTags={selectedTags} onTagsChange={setSelectedTags} />
      </Box>

      <Box sx={{ mt: 2 }}>
        <ImageCompressor onImageChange={handleCardImageChange} buttonText="Upload Card Image" />
        {cardImage && (
          <Typography sx={{ mt: 1 }}>
            {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
          </Typography>
        )}
      </Box>
      {imgOrLink === 'img' && (
        <Box sx={{ mt: 2 }}>
          <CyoaImageUploader onImagesChange={handleCyoaImagesChange} onNeedsSplitChange={handleNeedsSplitChange}/>
        </Box>
      )}
      <Button type="submit" variant="contained" color="primary" sx={{ mt: 3 }} disabled={loading}>
        {loading ? <CircularProgress size={24} /> : 'Create Game'}
      </Button>
      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
