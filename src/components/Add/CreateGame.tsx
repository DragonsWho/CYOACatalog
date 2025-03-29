// src/components/Add/CreateGame.tsx
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
import ImageCompressor from './ImageCompressor';
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
  const [customTags, setCustomTags] = useState<Tag[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [initialDataLoading, setInitialDataLoading] = useState<boolean>(true);
  const [splitsNeeded, setSplitsNeeded] = useState<boolean>(false);
  const { user } = useContext(AuthContext);

  const navigate = useNavigate();

  async function refreshAuthors() {
    const authorsData = await authorsCollection.getFullList();
    setAvailableAuthors(authorsData);
  }

  async function refreshTags() {
    const tagsData = await tagsCollection.getFullList();
    setAvailableTags(tagsData);
  }

  async function refreshTagCategories() {
    const categoriesData = await tagCategoriesCollection.getFullList({ expand: 'tags' });
    setTagCategories(categoriesData);
  }

  useEffect(() => {
    Promise.all([refreshAuthors(), refreshTagCategories(), refreshTags()]).then(() => {
      setInitialDataLoading(false);
    });
  }, []);

  function handleCardImageChange(compressedImage: File | null) {
    setCardImage(compressedImage);
  }

  function handleCyoaImagesChange(newImages: File[]) {
    setCyoaImages(newImages);
  }

  function handleTagsChange(newSelectedTags: string[]) {
    setSelectedTags(newSelectedTags);
  }

  function handleCustomTagsChange(newCustomTags: Tag[]) {
    setCustomTags(newCustomTags);
  }

  function handleAvailableTagsChange(newAvailableTags: Tag[]) {
    setAvailableTags(newAvailableTags);
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
  
    // Обработка cardImage: сохраняем оригинал и создаём image_base64 (WebP сжатие)
    if (cardImage) {
      let cardImageBitmap;
      try {
        cardImageBitmap = await createImageBitmap(cardImage);
      } catch (e) {
        console.error('Failed to process cardImage:', e);
        setError('Failed to process card image. Please try again.');
        setLoading(false);
        return;
      }
  
      // Сохраняем оригинальное изображение
      formData.append('image', cardImage);
  
      // Генерируем image_base64 с WebP сжатием (настройки из скриншота)
      const targetWidth = 100; // Из скриншота: ширина 100
      const targetHeight = 133; // Из скриншота: высота 133
      const sourceAspect = cardImageBitmap.width / cardImageBitmap.height;
      let scaleWidth = targetWidth;
      let scaleHeight = targetHeight;
  
      if (sourceAspect > targetWidth / targetHeight) {
        scaleHeight = Math.round(targetWidth / sourceAspect);
      } else {
        scaleWidth = Math.round(targetHeight * sourceAspect);
      }
  
      const webpCanvas = new OffscreenCanvas(scaleWidth, scaleHeight);
      const webpCtx = webpCanvas.getContext('2d', { alpha: false }); // Alpha не преумножается (по скриншоту)
      webpCtx!.imageSmoothingQuality = 'high'; // Используем Lanczos3 через высокое качество сглаживания
      webpCtx!.drawImage(
        cardImageBitmap,
        0, 0, cardImageBitmap.width, cardImageBitmap.height,
        0, 0, scaleWidth, scaleHeight
      );
      const webpImageData = webpCtx!.getImageData(0, 0, scaleWidth, scaleHeight);
  
      try {
        const webpBuffer = await webpencode(webpImageData, {
          quality: 40, // Качество из скриншота
          lossless: 0, // Без потерь выключено
          filter_strength: 100, // Исправлено: filterStrength -> filter_strength
          filter_sharpness: 7, // Исправлено: filterSharpness -> filter_sharpness
          // Убрано effort, так как оно не поддерживается
        });
        const webpBlob = new Blob([webpBuffer], { type: 'image/webp' });
        const base64String = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.readAsDataURL(webpBlob);
        });
        formData.append('image_base64', base64String); // Сохраняем как base64
      } catch (e) {
        console.error('Failed to encode WebP:', e);
        setError('WebP encoding failed. Using original file.');
        formData.append('image', cardImage); // Фallback на оригинал
      }
    }
  
    // Обработка cyoa_pages: оставляем как есть (WebP lossless)
    if (imgOrLink === 'img') {
      for (const [index, imageFile] of cyoaImages.entries()) {
        let image;
        try {
          image = await createImageBitmap(imageFile);
        } catch (e) {
          console.error('Failed to process CYOA image:', e);
          formData.append('cyoa_pages', imageFile);
          continue;
        }
  
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx!.drawImage(image, 0, 0, image.width, image.height);
        const imageData = ctx!.getImageData(0, 0, image.width, image.height);
  
        try {
          const webPBuffer = await webpencode(imageData, { lossless: 1 });
          const webpBlob = new Blob([webPBuffer], { type: 'image/webp' });
          formData.append('cyoa_pages', webpBlob);
        } catch (e) {
          console.error('Failed to encode WebP for cyoa_pages:', e);
          formData.append('cyoa_pages', imageFile);
        }
  
        // Превью для первого изображения остаётся как есть (WebP качество 10)
        if (index === 0) {
          const targetAspect = 2 / 3;
          let cropWidth = image.width;
          let cropHeight = Math.min(image.height, Math.round(image.width / targetAspect));
  
          const cropCanvas = new OffscreenCanvas(cropWidth, cropHeight);
          const cropCtx = cropCanvas.getContext('2d', { alpha: true });
          if (cropCtx) {
            cropCtx.drawImage(
              image,
              0, 0, image.width, cropHeight,
              0, 0, cropWidth, cropHeight
            );
            const cropImageData = cropCtx.getImageData(0, 0, cropWidth, cropHeight);
  
            try {
              const previewBuffer = await webpencode(cropImageData, { quality: 10 });
              const previewBlob = new Blob([previewBuffer], { type: 'image/webp' });
              formData.append('cyoa_pages_preview', previewBlob);
            } catch (e) {
              console.error('Failed to encode WebP preview for cyoa_pages:', e);
            }
          }
        }
      }
    }
  
    for (const tag of selectedTags) formData.append('tags', tag);
    for (const customTag of customTags) formData.append('tags', customTag.id);
    formData.append('img_or_link', imgOrLink);
    if (imgOrLink === 'link') formData.append('iframe_url', iframeUrl);
    if (user) formData.append('uploader', user.id);
  
    try {
      const res = await gamesCollection.create(formData);
      for (const author of authors) await authorsCollection.update(author.id, { 'games+': [res.id] });
      console.log('Created game:', res.id);
      navigate('/');
    } catch (err) {
      setError('Failed to create game. Please try again.');
      console.error('Error creating game:', err);
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
        <ImageCompressor onImageChange={handleCardImageChange} buttonText="Upload Card Image" />
        {cardImage && (
          <Typography sx={{ mt: 1 }}>
            {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
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
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}