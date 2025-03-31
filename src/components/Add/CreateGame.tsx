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
  console.log('[CreateGame] Component rendered'); // Лог: Компонент отрендерился

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

  console.log('[CreateGame] Initial State:', { title, description, cardImage, cyoaImages, imgOrLink, iframeUrl, authors, selectedTags, customTags, user: user?.id }); // Лог: Начальное состояние

  async function refreshAuthors() {
    console.log('[CreateGame] Refreshing authors...');
    const authorsData = await authorsCollection.getFullList();
    setAvailableAuthors(authorsData);
    console.log('[CreateGame] Authors refreshed:', authorsData.length);
  }

  async function refreshTags() {
    console.log('[CreateGame] Refreshing tags...');
    const tagsData = await tagsCollection.getFullList();
    setAvailableTags(tagsData);
    console.log('[CreateGame] Tags refreshed:', tagsData.length);
  }

  async function refreshTagCategories() {
    console.log('[CreateGame] Refreshing tag categories...');
    const categoriesData = await tagCategoriesCollection.getFullList({ expand: 'tags' });
    setTagCategories(categoriesData);
    console.log('[CreateGame] Tag categories refreshed:', categoriesData.length);
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
    // Этот лог может быть слишком частым, если не используется активно
    // console.log('[CreateGame] handleAvailableTagsChange:', newAvailableTags.length);
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
        // Логируем ID тегов в категории для отладки
        const categoryTagIds = category.expand?.tags?.map(t => t.id) || [];
        // console.log(`[CreateGame] Validating category '${category.name}' (min: ${category.min_tags}). Category tags IDs:`, categoryTagIds);
        // console.log(`[CreateGame] Selected tag IDs for validation:`, selectedTags);

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

    // --- Логирование входных данных перед валидацией ---
    console.log('[CreateGame] Data before validation:', { title, description, cardImage: cardImage?.name, cyoaImagesCount: cyoaImages.length, imgOrLink, iframeUrl, authors: authors.map(a => a.id), selectedTags, customTags: customTags.map(t => t.id), splitsNeeded, userId: user?.id });

    // --- Валидация ---
    if (!title.trim()) {
      console.error('[CreateGame] Validation failed: Title is required.');
      setError('Title is required.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: Title OK.');

    if (!description.trim()) {
      console.error('[CreateGame] Validation failed: Description is required.');
      setError('Description is required.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: Description OK.');

    if (!cardImage) {
      console.error('[CreateGame] Validation failed: Card image is required.');
      setError('Please upload a card image.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: Card image OK.');

    if (imgOrLink === 'img' && cyoaImages.length === 0) {
      console.error('[CreateGame] Validation failed: CYOA page image(s) required when type is "img".');
      setError('Please upload at least one CYOA page image.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: CYOA images OK (for img type).');

    if (imgOrLink === 'link' && !iframeUrl.trim()) {
      console.error('[CreateGame] Validation failed: iframe URL required when type is "link".');
      setError('Please provide an iframe URL.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: iframe URL OK (for link type).');

    const tagErrors = validateTags();
    if (tagErrors.length > 0) {
      console.error('[CreateGame] Validation failed: Tag requirements not met.');
      setError(`Tag selection errors:\n${tagErrors.join('\n')}`);
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: Tag requirements OK.');

     // --- ДОБАВЛЕНА ПРОВЕРКА: Минимум один тег всего ---
    if (selectedTags.length === 0 && customTags.length === 0) {
        console.error('[CreateGame] Validation failed: At least one tag (standard or custom) must be selected.');
        setError('Validation Error: At least one tag (standard or custom) must be selected.');
        setLoading(false);
        return;
    }
    console.log('[CreateGame] Validation: At least one tag selected OK.');
    // --- КОНЕЦ ПРОВЕРКИ ---


    if (splitsNeeded) {
      console.error('[CreateGame] Validation failed: Images need splitting.');
      setError('Please split images into vertical segments of less than 16,383 pixels.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: Image splitting OK.');

    // --- Проверка наличия пользователя ---
    if (!user || !user.id) { // Добавлена проверка на user.id
      console.error('[CreateGame] Validation failed: User not logged in or user ID is missing.');
      setError('Authentication Error: You must be logged in to create a game.');
      setLoading(false);
      return;
    }
    console.log('[CreateGame] Validation: User logged in OK (ID:', user.id, ')');
    // --- Конец проверки пользователя ---

    console.log('[CreateGame] All validations passed. Proceeding to build FormData...');

    const formData = new FormData();

    // --- Добавление полей в FormData с логами ---
    console.log('[CreateGame] Appending title:', title);
    formData.append('title', title);

    const descriptionData = DOMPurify.sanitize(`<p>${description}</p>`);
    console.log('[CreateGame] Appending sanitized description:', descriptionData);
    formData.append('description', descriptionData);

    console.log('[CreateGame] Appending img_or_link:', imgOrLink);
    formData.append('img_or_link', imgOrLink);

    if (imgOrLink === 'link') {
      console.log('[CreateGame] Appending iframe_url:', iframeUrl);
      formData.append('iframe_url', iframeUrl);
    }

    console.log('[CreateGame] Appending uploader:', user.id);
    formData.append('uploader', user.id);

    // Обработка cardImage (image и image_base64)
    if (cardImage) {
      console.log('[CreateGame] Processing cardImage:', { name: cardImage.name, size: cardImage.size, type: cardImage.type });
      let cardImageBitmap;
      try {
        console.log('[CreateGame] Creating bitmap for cardImage...');
        cardImageBitmap = await createImageBitmap(cardImage);
        console.log('[CreateGame] Bitmap created for cardImage:', { width: cardImageBitmap.width, height: cardImageBitmap.height });
      } catch (e) {
        console.error('[CreateGame] Failed to create bitmap for cardImage:', e);
        setError('Failed to process card image. Please try again.');
        setLoading(false);
        return;
      }

      console.log('[CreateGame] Appending original cardImage to formData key "image"');
      formData.append('image', cardImage);

      // Генерация image_base64 (WebP)
      console.log('[CreateGame] Generating image_base64 (WebP preview) for cardImage...');
      const targetWidth = 100;
      const targetHeight = 133;
      const sourceAspect = cardImageBitmap.width / cardImageBitmap.height;
      let scaleWidth = targetWidth;
      let scaleHeight = targetHeight;

      if (sourceAspect > targetWidth / targetHeight) {
        scaleHeight = Math.round(targetWidth / sourceAspect);
      } else {
        scaleWidth = Math.round(targetHeight * sourceAspect);
      }
      console.log('[CreateGame] WebP preview calculated dimensions:', { scaleWidth, scaleHeight });

      const webpCanvas = new OffscreenCanvas(scaleWidth, scaleHeight);
      const webpCtx = webpCanvas.getContext('2d', { alpha: false });
      if (!webpCtx) {
          console.error('[CreateGame] Failed to get 2D context for WebP preview canvas.');
          setError('Failed to process card image preview (canvas context).');
          setLoading(false);
          return;
      }
      webpCtx.imageSmoothingQuality = 'high';
      console.log('[CreateGame] Drawing image onto WebP preview canvas...');
      webpCtx.drawImage(
        cardImageBitmap,
        0, 0, cardImageBitmap.width, cardImageBitmap.height,
        0, 0, scaleWidth, scaleHeight
      );
      const webpImageData = webpCtx.getImageData(0, 0, scaleWidth, scaleHeight);
      console.log('[CreateGame] Got image data from WebP preview canvas.');

      try {
        console.log('[CreateGame] Encoding WebP preview with quality 40...');
        const webpBuffer = await webpencode(webpImageData, {
          quality: 40,
          lossless: 0,
          filter_strength: 100,
          filter_sharpness: 7,
        });
        const webpBlob = new Blob([webpBuffer], { type: 'image/webp' });
        console.log('[CreateGame] WebP preview encoded. Blob size:', webpBlob.size);
        console.log('[CreateGame] Converting WebP preview blob to base64...');
        const base64String = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = (err) => {
              console.error('[CreateGame] FileReader error for WebP preview:', err);
              reject(err);
          };
          reader.readAsDataURL(webpBlob);
        });
        console.log('[CreateGame] WebP preview base64 generated. Length:', base64String.length);
        console.log('[CreateGame] Appending base64 string to formData key "image_base64"');
        formData.append('image_base64', base64String);
      } catch (e) {
        console.error('[CreateGame] Failed to encode WebP preview or convert to base64:', e);
        // Не прерываем, просто предупреждаем
        console.warn('[CreateGame] Proceeding without image_base64 due to error.');
        setError('Warning: Failed to create card image preview (WebP encoding/base64). Proceeding without it.');
      }
    }

    // Обработка cyoa_pages и cyoa_pages_preview
    if (imgOrLink === 'img') {
      console.log(`[CreateGame] Processing ${cyoaImages.length} CYOA images...`);
      for (const [index, imageFile] of cyoaImages.entries()) {
        console.log(`[CreateGame] Processing CYOA image ${index + 1}:`, { name: imageFile.name, size: imageFile.size, type: imageFile.type });

        // Обработка основного файла cyoa_pages (WebP lossless)
        try {
          console.log(`[CreateGame] CYOA ${index + 1}: Creating bitmap...`);
          const image = await createImageBitmap(imageFile);
          console.log(`[CreateGame] CYOA ${index + 1}: Bitmap created`, { width: image.width, height: image.height });
          const canvas = new OffscreenCanvas(image.width, image.height);
          const ctx = canvas.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('Could not get 2D context for CYOA lossless');
          console.log(`[CreateGame] CYOA ${index + 1}: Drawing to canvas...`);
          ctx.drawImage(image, 0, 0);
          const imageData = ctx.getImageData(0, 0, image.width, image.height);
          console.log(`[CreateGame] CYOA ${index + 1}: Encoding lossless WebP...`);
          const webPBuffer = await webpencode(imageData, { lossless: 1 });
          const webpBlob = new Blob([webPBuffer], { type: 'image/webp' });
          const webpFileName = `${imageFile.name.split('.').slice(0, -1).join('.')}_page${index + 1}.webp`;
          console.log(`[CreateGame] CYOA ${index + 1}: Lossless WebP encoded. Blob size: ${webpBlob.size}. Appending to formData key "cyoa_pages" as ${webpFileName}`);
          formData.append('cyoa_pages', webpBlob, webpFileName);
        } catch (e) {
          console.error(`[CreateGame] Failed to process CYOA image ${index + 1} (${imageFile.name}) as lossless WebP. Appending original. Error:`, e);
          console.log(`[CreateGame] Appending original CYOA image ${index + 1} to formData key "cyoa_pages"`);
          formData.append('cyoa_pages', imageFile); // Fallback на оригинал
        }

        // Обработка превью cyoa_pages_preview (только для первого изображения, WebP quality 10)
        if (index === 0) {
          console.log(`[CreateGame] CYOA ${index + 1}: Generating preview (quality 10 WebP)...`);
          try {
            const image = await createImageBitmap(imageFile); // Повторное создание, если нужно
            const targetAspect = 2 / 3;
            let cropWidth = image.width;
            let cropHeight = Math.min(image.height, Math.round(image.width / targetAspect));
            console.log(`[CreateGame] CYOA ${index + 1} Preview: Calculated crop dimensions:`, { cropWidth, cropHeight });
            const cropCanvas = new OffscreenCanvas(cropWidth, cropHeight);
            const cropCtx = cropCanvas.getContext('2d', { alpha: true });
            if (!cropCtx) throw new Error('Could not get 2D context for CYOA preview');
            console.log(`[CreateGame] CYOA ${index + 1} Preview: Drawing to canvas...`);
            cropCtx.drawImage(image, 0, 0, image.width, cropHeight, 0, 0, cropWidth, cropHeight);
            const cropImageData = cropCtx.getImageData(0, 0, cropWidth, cropHeight);
            console.log(`[CreateGame] CYOA ${index + 1} Preview: Encoding quality 10 WebP...`);
            const previewBuffer = await webpencode(cropImageData, { quality: 10 });
            const previewBlob = new Blob([previewBuffer], { type: 'image/webp' });
            const previewFileName = `${imageFile.name.split('.').slice(0, -1).join('.')}_preview.webp`;
            console.log(`[CreateGame] CYOA ${index + 1} Preview: Encoded. Blob size: ${previewBlob.size}. Appending to formData key "cyoa_pages_preview" as ${previewFileName}`);
            formData.append('cyoa_pages_preview', previewBlob, previewFileName);
          } catch (e) {
            console.error(`[CreateGame] Failed to create CYOA preview for image ${index + 1} (${imageFile.name}). Skipping preview. Error:`, e);
          }
        }
      }
    }

    // Добавление тегов
    const allTagIds: string[] = [];
    console.log('[CreateGame] Appending selected standard tags:', selectedTags);
    selectedTags.forEach((tagId, idx) => {
      if (tagId && typeof tagId === 'string' && tagId.trim() !== '') {
        console.log(`[CreateGame] Appending tag[${idx}] (standard):`, tagId);
        formData.append('tags', tagId);
        allTagIds.push(tagId);
      } else {
        console.warn(`[CreateGame] Invalid or empty selected standard tag ID skipped at index ${idx}:`, tagId);
      }
    });
    console.log('[CreateGame] Appending selected custom tags:', customTags.map(t => t.id));
    customTags.forEach((customTag, idx) => {
      if (customTag && customTag.id && typeof customTag.id === 'string' && customTag.id.trim() !== '') {
        console.log(`[CreateGame] Appending tag[${selectedTags.length + idx}] (custom):`, customTag.id);
        formData.append('tags', customTag.id);
        allTagIds.push(customTag.id);
      } else {
        console.warn(`[CreateGame] Invalid or empty custom tag skipped at index ${idx}:`, customTag);
      }
    });
    console.log('[CreateGame] Final list of tag IDs appended:', allTagIds);
    // Дополнительная проверка на случай, если все теги отфильтровались
    if (allTagIds.length === 0) {
         console.error('[CreateGame] Critical Error: No valid tags were appended to FormData, although validation passed earlier. Aborting.');
         setError('Validation Error: No valid tags could be prepared for submission.');
         setLoading(false);
         return;
    }

    // --- ЛОГИРОВАНИЕ ВСЕГО FormData перед отправкой ---
    console.log('[CreateGame] --- Final FormData Content ---');
    // Используем Array.from для итерации, если formData.entries() не сработает напрямую в цикле for...of в старых средах
    try {
        Array.from(formData.entries()).forEach(([key, value]) => {
          if (key === 'image_base64' && typeof value === 'string') {
            console.log(`  ${key}: [base64 data starting with ${value.substring(0, 30)}..., length: ${value.length}]`);
          } else if (value instanceof File) {
            console.log(`  ${key}: File { name: '${value.name}', size: ${value.size}, type: '${value.type}' }`);
          } else if (key === 'tags') {
            // Логируем ID тегов по одному для ясности, так как append добавляет несколько с одним ключом
            console.log(`  ${key}: ${value}`);
          } else {
            console.log(`  ${key}: ${value}`);
          }
        });
    } catch (logError) {
        console.error("[CreateGame] Error while trying to log FormData contents:", logError);
    }
    console.log('[CreateGame] -----------------------------');
    console.log('[CreateGame] Sending request to gamesCollection.create...');

    // --- Отправка запроса ---
    try {
      const res = await gamesCollection.create(formData);
      console.log('[CreateGame] Game created successfully! Response:', res); // Лог успеха

      // Обновление авторов
      if (authors && Array.isArray(authors) && authors.length > 0) {
          console.log('[CreateGame] Updating authors:', authors.map(a => a?.id || 'invalid author object'));
          try {
            await Promise.all(
                authors.map(author => {
                    if (author && author.id) {
                        console.log(`[CreateGame] Updating author ${author.id} to add game ${res.id}`);
                        return authorsCollection.update(author.id, { 'games+': [res.id] });
                    } else {
                        console.warn('[CreateGame] Skipping update for invalid author object:', author);
                        return Promise.resolve();
                    }
                })
            );
            console.log('[CreateGame] Authors updated successfully.');
          } catch (authorUpdateError) {
              console.error('[CreateGame] Error updating authors:', authorUpdateError);
              // Не прерываем навигацию из-за ошибки обновления автора, но сообщаем
              setError('Game created, but failed to update associated authors.');
              // Можно добавить более специфичное сообщение, если нужно
          }
      } else {
          console.log('[CreateGame] No authors selected to update.');
      }

      console.log('[CreateGame] Navigating to /');
      navigate('/');

    } catch (err: any) { // Используем any для простоты доступа к свойствам ошибки
      console.error('[CreateGame] Error creating game:', err); // Логируем весь объект ошибки

      // --- Детализация ошибки ---
      let displayError = 'Failed to create game. Please try again.'; // Сообщение по умолчанию

      if (err && err.isAbort) {
        console.error('[CreateGame] Request was aborted.');
        displayError = 'Game creation request was aborted. Please try again.';
      } else if (err && err.response) {
        // Ошибка от PocketBase
        const status = err.response?.status || err.status || 'unknown status';
        console.error(`[CreateGame] PocketBase server responded with status ${status}. Response:`, err.response); // Логируем весь ответ
        const pbErrorData = err.response?.data; // Данные ошибки (часто объект с полями)
        console.error('[CreateGame] PocketBase error data:', pbErrorData);

        let detailedMessage = `Server error (status ${status}).`;
        if (pbErrorData && typeof pbErrorData === 'object' && Object.keys(pbErrorData).length > 0) {
            // Формируем сообщение из полей ошибки
            detailedMessage = Object.entries(pbErrorData)
                .map(([field, details]: [string, any]) => {
                    const message = details?.message || JSON.stringify(details);
                    if (field === 'data' && typeof details === 'object' && details !== null) {
                        return `Field 'data': { ${Object.entries(details).map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
                    }
                    return `Field '${field}': ${message}`;
                })
                .join('; ');
            displayError = `Failed to create game: ${detailedMessage}. Please check your input and try again.`;
        } else if (typeof pbErrorData === 'string' && pbErrorData) {
            // Если ошибка - просто строка
            detailedMessage = pbErrorData;
            displayError = `Failed to create game: ${detailedMessage}`;
        } else if (err.message) {
            // Если нет деталей от PB, но есть сообщение в самом объекте ошибки JS
             displayError = `Failed to create game: ${err.message}`;
        } else {
            displayError = `Failed to create game. ${detailedMessage} See console for details.`;
        }
      } else {
           // Нестандартная ошибка (например, сетевая)
           displayError = `Failed to create game. Unexpected error: ${err.message || 'Unknown error'}. Check your connection and console.`;
           console.error('[CreateGame] Unexpected error details:', err);
      }
      setError(displayError); // Устанавливаем сообщение об ошибке для пользователя
      // --- Конец детализации ---

    } finally {
      console.log('[CreateGame] handleSubmit finished. Setting loading to false.');
      setLoading(false);
    }
  }

  // --- Рендер компонента ---
  if (initialDataLoading) {
    console.log('[CreateGame] Rendering: Initial data loading indicator.');
    return <CircularProgress />;
  }

  console.log('[CreateGame] Rendering: Main form.');
  return (
    <Box component="form" onSubmit={handleSubmit} sx={{ maxWidth: 600, margin: 'auto', mt: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Add a New Cyoa!
      </Typography>
      {/* Поля ввода и селекторы */}
      <TextField
        fullWidth
        label="Title"
        value={title}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          // console.log('[CreateGame] Title changed:', e.target.value); // Слишком много логов
          setTitle(e.target.value);
        }}
        margin="normal"
        required
      />
      <TextField
        fullWidth
        label="Description"
        value={description}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          // console.log('[CreateGame] Description changed:', e.target.value); // Слишком много логов
          setDescription(e.target.value);
        }}
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
          onChange={(e: SelectChangeEvent<'img' | 'link'>) => {
            const newValue = e.target.value as 'img' | 'link';
            console.log('[CreateGame] imgOrLink changed:', newValue);
            setImgOrLink(newValue);
          }}
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
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            // console.log('[CreateGame] iframeUrl changed:', e.target.value); // Слишком много логов
            setIframeUrl(e.target.value);
          }}
          margin="normal"
          required={imgOrLink === 'link'} // Убедимся, что required динамический
        />
      )}
      <Box sx={{ mt: 2 }}>
        <AuthorSelector
          value={authors}
          onChange={(newAuthors) => {
             console.log('[CreateGame] Authors changed:', newAuthors.map(a=>a.id));
             setAuthors(newAuthors);
          }}
          availableAuthors={availableAuthors}
          onAuthorsChange={refreshAuthors} // Переименовал для ясности, что это триггер рефреша
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Select Tags</Typography>
        {/* TagSelector сам по себе не логирует, используем handleTagsChange */}
        <TagSelector selectedTags={selectedTags} onTagsChange={handleTagsChange} />
      </Box>

      <Box sx={{ mt: 2 }}>
        <Typography variant="h6">Custom Tags</Typography>
         {/* CustomTagSelector сам по себе не логирует, используем handleCustomTagsChange */}
        <CustomTagSelector
          value={customTags}
          onChange={handleCustomTagsChange}
          availableTags={availableTags}
          onTagsChange={handleAvailableTagsChange} // Переименовал для ясности
        />
      </Box>

      <Box sx={{ mt: 2 }}>
        {/* ImageCompressor вызывает handleCardImageChange */}
        <ImageCompressor onImageChange={handleCardImageChange} buttonText="Upload Card Image" />
        {cardImage && (
          <Typography sx={{ mt: 1 }}>
            Card Image: {cardImage.name} (Size: {(cardImage.size / 1024).toFixed(2)} KB)
          </Typography>
        )}
      </Box>
      {imgOrLink === 'img' && (
        <Box sx={{ mt: 2 }}>
           {/* CyoaImageUploader вызывает handleCyoaImagesChange и handleNeedsSplitChange */}
          <CyoaImageUploader onImagesChange={handleCyoaImagesChange} onNeedsSplitChange={handleNeedsSplitChange} />
        </Box>
      )}
      {/* Кнопка и сообщение об ошибке */}
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