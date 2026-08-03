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
import CustomTagSelector from './CustomTagSelector';
import CyoaImageUploader from './CyoaImageUploader';
import CardImageCropper from './CardImageCropper';
import {
  AuthContext,
  Author,
  Tag,
  authorsCollection,
  gamesCollection,
  tagCategoriesCollection,
  tagsCollection,
  TagCategory,
} from '../../pocketbase/pocketbase';
import { encode as webpencode } from '@jsquash/webp';
import DOMPurify from 'dompurify';
import { makeBlurPlaceholder } from '../../utils/blurPlaceholder';

// Интерфейс для типизации ошибки от PocketBase
interface PocketBaseError {
  response?: {
    data?: Record<string, { message?: string } | string | unknown>;
    status?: number;
  };
  message?: string;
  isAbort?: boolean;
}

export default function CreateGame() {
  console.log('[CreateGame] Component rendered');

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
  const [customTags, setCustomTags] = useState<Tag[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [initialDataLoading, setInitialDataLoading] = useState<boolean>(true);
  const [splitsNeeded, setSplitsNeeded] = useState<boolean>(false);
  const { user } = useContext(AuthContext);

  const navigate = useNavigate();

  console.log('[CreateGame] Initial State:', { title, description, cardImage, cyoaImages, imgOrLink, iframeUrl, authors, selectedTags, customTags, user: user?.id });

  async function refreshAuthors() {
    console.log('[CreateGame] Refreshing authors...');
    try {
      const authorsData = await authorsCollection.getFullList();
      setAvailableAuthors(authorsData);
      console.log('[CreateGame] Authors refreshed:', authorsData.length);
    } catch (e) {
      console.error('[CreateGame] Failed to refresh authors', e);
    }
  }

  async function refreshTags() {
    console.log('[CreateGame] Refreshing tags...');
    try {
      const tagsData = await tagsCollection.getFullList();
      setAvailableTags(tagsData);
      console.log('[CreateGame] Tags refreshed:', tagsData.length);
    } catch (e) {
      console.error('[CreateGame] Failed to refresh tags', e);
    }
  }

  async function refreshTagCategories() {
    console.log('[CreateGame] Refreshing tag categories...');
    try {
      const categoriesData = await tagCategoriesCollection.getFullList({ expand: 'tags' });
      setTagCategories(categoriesData);
      console.log('[CreateGame] Tag categories refreshed:', categoriesData.length);
    } catch (e) {
      console.error('[CreateGame] Failed to refresh tag categories', e);
    }
  }

  useEffect(() => {
    console.log('[CreateGame] useEffect: Fetching initial data...');
    setInitialDataLoading(true);
    Promise.all([refreshAuthors(), refreshTagCategories(), refreshTags()])
      .then(() => {
        console.log('[CreateGame] useEffect: Initial data fetched successfully.');
        setInitialDataLoading(false);
      })
      .catch(err => {
        console.error('[CreateGame] useEffect: Error fetching initial data:', err);
        setError('Failed to load initial data.');
        setInitialDataLoading(false);
      });
  }, []);

  function handleCardImageChange(compressedImage: File | null) {
    console.log('[CreateGame] handleCardImageChange:', compressedImage ? { name: compressedImage.name, size: compressedImage.size } : null);
    setCardImage(compressedImage);
  }

  function handleCyoaImagesChange(newImages: File[]) {
    console.log('[CreateGame] handleCyoaImagesChange:', newImages.map(img => ({ name: img.name, size: img.size })));
    setCyoaImages(newImages);
  }

  function handleTagsChange(newSelectedTags: string[]) {
    console.log('[CreateGame] handleTagsChange (selected standard tags):', newSelectedTags);
    setSelectedTags(newSelectedTags);
  }

  function handleCustomTagsChange(newCustomTags: Tag[]) {
    console.log('[CreateGame] handleCustomTagsChange (selected custom tags):', newCustomTags.map(tag => tag.id));
    setCustomTags(newCustomTags);
  }

  function handleAvailableTagsChange(newAvailableTags: Tag[]) {
    setAvailableTags(newAvailableTags);
  }

  function handleNeedsSplitChange(splitNeeded: boolean) {
    console.log('[CreateGame] handleNeedsSplitChange:', splitNeeded);
    setSplitsNeeded(splitNeeded);
  }

  function validateTags(): string[] {
    console.log('[CreateGame] Validating tags...');
    const errors: string[] = [];
    for (const category of tagCategories) {
        const categoryTagIds = category.expand?.tags?.map(t => t.id) || [];
        const categoryTags = selectedTags.filter((tagId) => categoryTagIds.includes(tagId));
        console.log(`[CreateGame] Category '${category.name}': Found ${categoryTags.length} selected tags:`, categoryTags);
        if (categoryTags.length < category.min_tags) {
            const errorMsg = `${category.name} requires at least ${category.min_tags} tag(s)`;
            console.warn('[CreateGame] Tag validation error:', errorMsg);
            errors.push(errorMsg);
        }
    }
    console.log('[CreateGame] Tag validation result (errors):', errors);
    return errors;
}

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    console.log('[CreateGame] handleSubmit triggered.');
    setLoading(true);
    setError(null);

    // --- Валидация ---
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

    if (selectedTags.length === 0 && customTags.length === 0) {
        setError('Validation Error: At least one tag (standard or custom) must be selected.');
        setLoading(false);
        return;
    }

    if (splitsNeeded) {
      setError('Please split images into vertical segments of less than 16,383 pixels.');
      setLoading(false);
      return;
    }

    if (!user || !user.id) {
      setError('Authentication Error: You must be logged in to create a game.');
      setLoading(false);
      return;
    }

    console.log('[CreateGame] All validations passed. Proceeding to build FormData...');

    const formData = new FormData();
    formData.append('title', title);
    const descriptionData = DOMPurify.sanitize(`<p>${description}</p>`);
    formData.append('description', descriptionData);
    formData.append('img_or_link', imgOrLink);
    if (imgOrLink === 'link') {
      formData.append('iframe_url', iframeUrl);
    }
    formData.append('uploader', user.id);

    // --- Добавление авторов ---
    if (authors.length > 0) {
      console.log('[CreateGame] Appending authors to FormData:', authors.map(a => a.id));
      authors.forEach(author => {
        if (author && author.id) {
          formData.append('authors', author.id);
        }
      });
    }

    // Обработка cardImage
    if (cardImage) {
      let cardImageBitmap;
      try {
        cardImageBitmap = await createImageBitmap(cardImage);
      } catch (e) {
        console.error('[CreateGame] Failed to create bitmap for cardImage:', e);
        setError('Failed to process card image. Please try again.');
        setLoading(false);
        return;
      }

      formData.append('image', cardImage);

      // Генерация image_base64 — с клампом по длине: пережатая «шумная» обложка
      // может не влезть в лимит поля PB и завалить создание игры целиком.
      const base64String = await makeBlurPlaceholder(cardImageBitmap);
      if (base64String) formData.append('image_base64', base64String);
    }

    // Обработка cyoa_pages
    if (imgOrLink === 'img') {
      for (const [index, imageFile] of cyoaImages.entries()) {
        try {
          const image = await createImageBitmap(imageFile);
          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('No context');
          ctx.drawImage(image, 0, 0);
          const imageData = ctx.getImageData(0, 0, image.width, image.height);
          const webPBuffer = await webpencode(imageData, { lossless: 1 });
          const webpBlob = new Blob([webPBuffer], { type: 'image/webp' });
          const webpFileName = `${imageFile.name.split('.').slice(0, -1).join('.')}_page${index + 1}.webp`;
          formData.append('cyoa_pages', webpBlob, webpFileName);
        } catch (e) {
          console.warn(`[CreateGame] WebP conversion failed for page ${index}, using original.`, e);
          formData.append('cyoa_pages', imageFile);
        }

        // Preview для первой страницы
        if (index === 0) {
          try {
            const image = await createImageBitmap(imageFile);
            const targetAspect = 2 / 3;
            // FIXED: Using const instead of let
            const cropWidth = image.width;
            const cropHeight = Math.min(image.height, Math.round(image.width / targetAspect));
            
            const cropCanvas = new OffscreenCanvas(cropWidth, cropHeight);
            const cropCtx = cropCanvas.getContext('2d', { alpha: true });
            if (cropCtx) {
                cropCtx.drawImage(image, 0, 0, image.width, cropHeight, 0, 0, cropWidth, cropHeight);
                const cropImageData = cropCtx.getImageData(0, 0, cropWidth, cropHeight);
                const previewBuffer = await webpencode(cropImageData, { quality: 10 });
                const previewBlob = new Blob([previewBuffer], { type: 'image/webp' });
                const previewFileName = `${imageFile.name.split('.').slice(0, -1).join('.')}_preview.webp`;
                formData.append('cyoa_pages_preview', previewBlob, previewFileName);
            }
          } catch (e) {
            console.error('Preview generation failed', e);
          }
        }
      }
    }

    // Добавление тегов
    const allTagIds: string[] = [];
    selectedTags.forEach((tagId) => {
      if (tagId && tagId.trim() !== '') {
        formData.append('tags', tagId);
        allTagIds.push(tagId);
      }
    });
    customTags.forEach((customTag) => {
      if (customTag && customTag.id && customTag.id.trim() !== '') {
        formData.append('tags', customTag.id);
        allTagIds.push(customTag.id);
      }
    });

    if (allTagIds.length === 0) {
         setError('Validation Error: No valid tags could be prepared for submission.');
         setLoading(false);
         return;
    }

    try {
      const res = await gamesCollection.create(formData);
      console.log('[CreateGame] Game created successfully! Response:', res);

      // Обновление авторов (обратная связь)
      if (authors && authors.length > 0) {
          try {
            await Promise.all(
                authors.map(author => {
                    if (author && author.id) {
                        return authorsCollection.update(author.id, { 'games+': [res.id] });
                    }
                    return Promise.resolve();
                })
            );
            console.log('[CreateGame] Authors collection updated successfully.');
          } catch (authorUpdateError) {
              console.error('[CreateGame] Error updating authors collection:', authorUpdateError);
          }
      }

      navigate('/');

    } catch (err: unknown) { // FIXED: using unknown instead of any
      console.error('[CreateGame] Error creating game:', err);
      let displayError = 'Failed to create game. Please try again.';

      // Type Narrowing
      if (typeof err === 'object' && err !== null) {
        const pbError = err as PocketBaseError;
        
        if (pbError.isAbort) {
            displayError = 'Request aborted.';
        } else if (pbError.response) {
            const pbErrorData = pbError.response.data;
            if (pbErrorData && typeof pbErrorData === 'object') {
                const messages = Object.entries(pbErrorData)
                    .map(([field, details]) => {
                        // Safe check for details content
                        let detailMsg = '';
                        if (typeof details === 'object' && details !== null && 'message' in details) {
                             detailMsg = (details as { message: string }).message;
                        } else {
                             detailMsg = JSON.stringify(details);
                        }
                        return `${field}: ${detailMsg}`;
                    })
                    .join('; ');
                displayError = `Failed to create game: ${messages}`;
            } else if (pbError.message) {
                 displayError = `Failed to create game: ${pbError.message}`;
            }
        } else if (pbError.message) {
            displayError = `Failed to create game: ${pbError.message}`;
        }
      }

      setError(displayError);
    } finally {
      setLoading(false);
    }
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
          required={imgOrLink === 'link'}
        />
      )}
      <Box sx={{ mt: 2 }}>
        <AuthorSelector
          value={authors}
          onChange={setAuthors}
          availableAuthors={availableAuthors}
          onAuthorsChange={refreshAuthors}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Select Tags</Typography>
        <TagSelector selectedTags={selectedTags} onTagsChange={handleTagsChange} />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Custom Tags</Typography>
        <CustomTagSelector
          value={customTags}
          onChange={handleCustomTagsChange}
          availableTags={availableTags}
          onTagsChange={handleAvailableTagsChange}
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <CardImageCropper onImageChange={handleCardImageChange} buttonText="Upload Card Image" />
        {cardImage && (
          <Typography sx={{ mt: 1 }}>
            Card Image: {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
          </Typography>
        )}
      </Box>
      {imgOrLink === 'img' && (
        <Box sx={{ mt: 2 }}>
          <CyoaImageUploader onImagesChange={handleCyoaImagesChange} onNeedsSplitChange={handleNeedsSplitChange} />
        </Box>
      )}
      <Button
        type="submit"
        variant="contained"
        color="primary"
        sx={{ mt: 3, ml: 'auto', display: 'block' }}
        disabled={loading}
      >
        {loading ? <CircularProgress size={24} /> : 'Create Game'}
      </Button>
      {error && (
        <Alert severity={error.startsWith('Warning:') ? 'warning' : 'error'} sx={{ mt: 2, whiteSpace: 'pre-wrap' }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}