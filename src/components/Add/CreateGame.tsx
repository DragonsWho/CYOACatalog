// src/components/Add/CreateGame.tsx
// Version 2.2.0
// Updated to handle sequential image uploads

// TODO: support https://github.com/DragonsWho/CYOACatalog/commit/0f3ff59251386c9e51edba097514b7b0a9c0675b

import { useState, useEffect, ChangeEvent, FormEvent } from 'react';
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
import { pb } from '../../services/api';
import { useNavigate } from 'react-router-dom';
import AuthorSelector from './AuthorSelector';
import TagSelector from './TagSelector';
import CyoaImageUploader from './CyoaImageUploader';
import ImageCompressor from './ImageCompressor';

interface Author {
  id: number | string;
  name: string;
}

interface TagCategory {
  id: string;
  name: string;
  min_tags: number;
  tags: { id: string }[];
}

function CreateGame(): JSX.Element {
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
  const [tagsLoaded, setTagsLoaded] = useState<boolean>(false);
  void tagsLoaded;
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [initialDataLoading, setInitialDataLoading] = useState<boolean>(true);

  const navigate = useNavigate();

  useEffect(() => {
    const fetchInitialData = async () => {
      try {
        const [authorsData, categoriesData] = await Promise.all([
          pb.collection('authors').getFullList<{ id: string; name: string }>(),
          pb.collection('tag_categories').getFullList<TagCategory>({ expand: 'tags' }),
        ]);
        setAvailableAuthors(
          authorsData.map((author: { id: string; name: string }) => ({ id: author.id, name: author.name })),
        );
        setTagCategories(categoriesData);
      } catch (error) {
        console.error('Error fetching initial data:', error);
        setError('Failed to load necessary data. Please refresh the page and try again.');
      } finally {
        setInitialDataLoading(false);
      }
    };

    fetchInitialData();
  }, []);

  const handleCardImageChange = (compressedImage: File | null) => {
    setCardImage(compressedImage);
  };

  const handleCyoaImagesChange = (newImages: File[]) => {
    setCyoaImages(newImages);
  };

  const validateTags = (): string[] => {
    const errors: string[] = [];
    tagCategories.forEach((category) => {
      const categoryTags = selectedTags.filter((tagId) => category.tags.some((tag) => tag.id === tagId));
      if (categoryTags.length < category.min_tags)
        errors.push(`${category.name} requires at least ${category.min_tags} tag(s)`);
    });
    return errors;
  };

  const processImage = async (file: File): Promise<File> => {
    if (file.size <= 10 * 1024 * 1024) {
      return file;
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0);

        const process = (quality: number) => {
          canvas.toBlob(
            (blob) => {
              if (blob) {
                if (blob.size <= 10 * 1024 * 1024 || quality <= 0.7) {
                  const processedFile = new File([blob], file.name, {
                    type: file.type,
                    lastModified: Date.now(),
                  });
                  resolve(processedFile);
                } else {
                  process(quality - 0.05);
                }
              } else {
                reject(new Error('Canvas to Blob conversion failed'));
              }
            },
            file.type,
            quality,
          );
        };

        process(1);
      };
      img.onerror = (error) => reject(error);
      img.src = URL.createObjectURL(file);
    });
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Form validation
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

    try {
      console.log('Submitting game data');
      const cyoaImagesProcessed = await Promise.all(cyoaImages.map(processImage));
      // TODO: sort by name
      const record = await pb.collection('games').create({
        title,
        description: description,
        image: cardImage,
        tags: selectedTags,
        img_or_link: imgOrLink,
        iframe_url: imgOrLink === 'link' ? iframeUrl : undefined,
        cyoa_pages: cyoaImagesProcessed,
        authors: authors.map((author) => author.id),
        selected_tags: selectedTags,
        upvotes: [],
      });

      console.log('Created game:', record.id);
      navigate('/');
    } catch (error: unknown) {
      console.error('Error creating game:', error);
      setError('Failed to create game. Please try again.');
    } finally {
      setLoading(false);
    }
  };

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
          onAuthorsChange={() => {}}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Select Tags</Typography>
        <TagSelector selectedTags={selectedTags} onTagsChange={setSelectedTags} onLoad={() => setTagsLoaded(true)} />
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
          <CyoaImageUploader onImagesChange={handleCyoaImagesChange} getImages={() => cyoaImages} />
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

export default CreateGame;
