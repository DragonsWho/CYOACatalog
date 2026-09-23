// Section ③ of the add page: build a catalog card by hand. Rework of Add/CreateGame.tsx — same
// pipeline (webp re-encode, base64 placeholder, preview crop, tag-category validation) as numbered
// steps for phones.

import { useState, useEffect, useRef, ChangeEvent, FormEvent, useContext } from 'react';
import {
  TextField, Button, Box, Typography, CircularProgress, Alert, Paper, Stack,
  ToggleButton, ToggleButtonGroup, Link, Checkbox, FormControlLabel,
} from '@mui/material';
import { useNavigate, Link as RouterLink } from 'react-router-dom';
import AuthorSelector from '../Add/AuthorSelector';
import TagSelector from '../Add/TagSelector';
import CustomTagSelector from '../Add/CustomTagSelector';
import CyoaImageUploader from '../Add/CyoaImageUploader';
import CardImageCropper from '../Add/CardImageCropper';
import {
  AuthContext, Author, Tag, TagCategory,
  authorsCollection, gamesCollection, gamesCollectionPublic, tagCategoriesCollection, tagsCollection,
  pbPublic, gameCanonicalKey,
} from '../../pocketbase/pocketbase';
import { encode as webpencode } from '@jsquash/webp';
import DOMPurify from 'dompurify';
import { makeBlurPlaceholder } from '../../utils/blurPlaceholder';

const Step = ({ n, title, hint, children }: {
  n: number; title: string; hint?: string; children: React.ReactNode;
}) => (
  <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
    <Stack direction="row" spacing={1.5} alignItems="baseline" sx={{ mb: hint ? 0.5 : 1.5 }}>
      <Box sx={{
        width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
        bgcolor: 'primary.main', color: 'primary.contrastText',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '0.85rem', fontWeight: 700, alignSelf: 'center',
      }}>
        {n}
      </Box>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{title}</Typography>
    </Stack>
    {hint && (
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{hint}</Typography>
    )}
    {children}
  </Paper>
);

// Per-page preview: whole page downscaled to a small, intentionally blurry webp shown while the
// lossless page streams in.
const PAGE_PREVIEW_W = 480;
const PAGE_PREVIEW_Q = 35;

type ProcessedPage = { pageBlob: Blob; previewBlob: Blob | null };

// Expensive work (lossless encode + preview) once per file at upload time, so submit is instant.
// Pages stay LOSSLESS — CYOA pages carry text and must never be lossy.
async function processPageFile(file: File): Promise<ProcessedPage> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D context');
    ctx.drawImage(bitmap, 0, 0);
    const full = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const pageBuf = await webpencode(full, { lossless: 1 });
    const pageBlob = new Blob([pageBuf], { type: 'image/webp' });

    let previewBlob: Blob | null = null;
    try {
      const pw = Math.min(PAGE_PREVIEW_W, bitmap.width);
      const ph = Math.max(1, Math.round((pw * bitmap.height) / bitmap.width));
      const pcanvas = new OffscreenCanvas(pw, ph);
      const pctx = pcanvas.getContext('2d', { alpha: false });
      if (pctx) {
        pctx.imageSmoothingQuality = 'high';
        pctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, pw, ph);
        const pdata = pctx.getImageData(0, 0, pw, ph);
        const prevBuf = await webpencode(pdata, { quality: PAGE_PREVIEW_Q, lossless: 0 });
        previewBlob = new Blob([prevBuf], { type: 'image/webp' });
      }
    } catch (e) {
      console.warn('[ManualCreate] preview encode failed', e);
    }
    return { pageBlob, previewBlob };
  } finally {
    bitmap.close();
  }
}

export default function ManualCreate() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [cardImage, setCardImage] = useState<File | null>(null);
  const [cyoaImages, setCyoaImages] = useState<File[]>([]);
  const [imgOrLink, setImgOrLink] = useState<'img' | 'link'>('img');
  const [iframeUrl, setIframeUrl] = useState('');
  const [authors, setAuthors] = useState<Author[]>([]);
  const [availableAuthors, setAvailableAuthors] = useState<Author[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Advisory duplicate check (same title usually = re-adding). Non-blocking; backend auto-suffixes
  // the slug.
  const [dupGame, setDupGame] = useState<{ id: string; slug?: string; title: string } | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<Tag[]>([]);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [tagCategories, setTagCategories] = useState<TagCategory[]>([]);
  const [initialDataLoading, setInitialDataLoading] = useState(true);
  const [splitsNeeded, setSplitsNeeded] = useState(false);
  // "New game" sets games.original_release (a flag, not a tag): front page pins fresh releases for
  // a few days (parity with SuggestLink).
  const [original, setOriginal] = useState(false);
  const { user, signedIn } = useContext(AuthContext);

  const processedRef = useRef<Map<File, Promise<ProcessedPage>>>(new Map());
  const doneRef = useRef<Set<File>>(new Set());
  const [, bumpReady] = useState(0);

  useEffect(() => {
    if (imgOrLink !== 'img') return;
    const map = processedRef.current;
    for (const f of Array.from(map.keys())) {
      if (!cyoaImages.includes(f)) {
        map.delete(f);
        doneRef.current.delete(f);
      }
    }
    cyoaImages.forEach((f) => {
      if (!map.has(f)) {
        const p = processPageFile(f);
        map.set(f, p);
        p.catch(() => undefined).finally(() => {
          doneRef.current.add(f);
          bumpReady((n) => n + 1);
        });
      }
    });
  }, [cyoaImages, imgOrLink]);

  const pagesReady = cyoaImages.filter((f) => doneRef.current.has(f)).length;

  useEffect(() => {
    const t = title.trim();
    if (t.length < 2) { setDupGame(null); return; }
    const timer = setTimeout(async () => {
      try {
        const hit = await gamesCollectionPublic.getList(1, 1, {
          filter: pbPublic.filter('title = {:t}', { t }),
          fields: 'id,slug,title',
          skipTotal: true,
        });
        setDupGame(hit.items[0] ?? null);
      } catch {
        setDupGame(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [title]);

  const navigate = useNavigate();

  async function refreshAuthors() {
    try {
      setAvailableAuthors(await authorsCollection.getFullList());
    } catch (e) {
      console.error('[ManualCreate] Failed to refresh authors', e);
    }
  }

  async function refreshTags() {
    try {
      setAvailableTags(await tagsCollection.getFullList());
    } catch (e) {
      console.error('[ManualCreate] Failed to refresh tags', e);
    }
  }

  async function refreshTagCategories() {
    try {
      setTagCategories(await tagCategoriesCollection.getFullList({ expand: 'tags' }));
    } catch (e) {
      console.error('[ManualCreate] Failed to refresh tag categories', e);
    }
  }

  useEffect(() => {
    if (!signedIn) { setInitialDataLoading(false); return; }
    setInitialDataLoading(true);
    Promise.all([refreshAuthors(), refreshTagCategories(), refreshTags()])
      .then(() => setInitialDataLoading(false))
      .catch((err) => {
        console.error('[ManualCreate] Error fetching initial data:', err);
        setError('Failed to load initial data.');
        setInitialDataLoading(false);
      });
  }, [signedIn]);

  function validateTags(): string[] {
    const errors: string[] = [];
    for (const category of tagCategories) {
      const categoryTagIds = category.expand?.tags?.map(t => t.id) || [];
      const categoryTags = selectedTags.filter((tagId) => categoryTagIds.includes(tagId));
      if (categoryTags.length < category.min_tags) {
        errors.push(`${category.name} requires at least ${category.min_tags} tag(s)`);
      }
    }
    return errors;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!title.trim()) { setError('Title is required.'); setLoading(false); return; }
    if (!description.trim()) { setError('Description is required.'); setLoading(false); return; }
    if (!cardImage) { setError('Please upload a card image (step 3).'); setLoading(false); return; }
    if (imgOrLink === 'img' && cyoaImages.length === 0) {
      setError('Please upload at least one CYOA page image (step 2).'); setLoading(false); return;
    }
    if (imgOrLink === 'link' && !iframeUrl.trim()) {
      setError('Please provide the link to the playable game (step 2).'); setLoading(false); return;
    }
    const tagErrors = validateTags();
    if (tagErrors.length > 0) {
      setError(`Tag selection:\n${tagErrors.join('\n')}`); setLoading(false); return;
    }
    if (selectedTags.length === 0 && customTags.length === 0) {
      setError('Please pick at least one tag (step 4).'); setLoading(false); return;
    }
    if (splitsNeeded) {
      setError('Please split the flagged images into vertical segments under 16,383 px first.');
      setLoading(false); return;
    }
    if (!user || !user.id) {
      setError('You must be logged in to add a game.'); setLoading(false); return;
    }

    const formData = new FormData();
    formData.append('title', title);
    const descriptionData = DOMPurify.sanitize(`<p>${description}</p>`);
    formData.append('description', descriptionData);
    formData.append('img_or_link', imgOrLink);
    if (imgOrLink === 'link') {
      formData.append('iframe_url', iframeUrl);
    }
    formData.append('uploader', user.id);

    if (authors.length > 0) {
      authors.forEach(author => {
        if (author && author.id) formData.append('authors', author.id);
      });
    }

    if (cardImage) {
      let cardImageBitmap;
      try {
        cardImageBitmap = await createImageBitmap(cardImage);
      } catch (e) {
        console.error('[ManualCreate] Failed to create bitmap for cardImage:', e);
        setError('Failed to process the card image. Please try another file.');
        setLoading(false);
        return;
      }

      formData.append('image', cardImage);

      // Size-clamped: a busy cover can exceed the PB field cap and fail the whole create; null →
      // skip the field.
      const base64String = await makeBlurPlaceholder(cardImageBitmap);
      if (base64String) formData.append('image_base64', base64String);
    }

    if (imgOrLink === 'img') {
      for (const [index, imageFile] of cyoaImages.entries()) {
        const stem = imageFile.name.split('.').slice(0, -1).join('.') || `page${index + 1}`;
        let processed: ProcessedPage | null = null;
        try {
          const cached = processedRef.current.get(imageFile);
          processed = cached ? await cached : await processPageFile(imageFile);
        } catch (e) {
          console.warn(`[ManualCreate] page ${index} processing failed, using original.`, e);
        }
        if (processed) {
          formData.append('cyoa_pages', processed.pageBlob, `${stem}_page${index + 1}.webp`);
          if (processed.previewBlob) {
            formData.append(
              'cyoa_pages_preview',
              processed.previewBlob,
              `${stem}_page${index + 1}_preview.webp`,
            );
          }
        } else {
          formData.append('cyoa_pages', imageFile);
        }
      }
    }

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
      setError('No valid tags could be prepared for submission.');
      setLoading(false);
      return;
    }

    // ManualCreate writes the catalog record itself, so it sets original_release directly
    // (SuggestLink goes via the pipeline queue → publication_queue.go). Front page pins flagged
    // games for PINNED_ORIGINAL_DAYS (isFreshOriginal / SearchPage).
    formData.append('original_release', original ? 'true' : 'false');

    try {
      const res = await gamesCollection.create(formData);

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
        } catch (authorUpdateError) {
          console.error('[ManualCreate] Error updating authors collection:', authorUpdateError);
        }
      }

      // The create hook mints the slug server-side; res carries it.
      navigate(`/game/${gameCanonicalKey(res)}`);
    } catch (err: unknown) {
      console.error('[ManualCreate] Error creating game:', err);
      let displayError = 'Failed to create the game. Please try again.';
      if (typeof err === 'object' && err !== null) {
        const pbError = err as {
          response?: { data?: Record<string, unknown> };
          message?: string;
          isAbort?: boolean;
        };
        if (!pbError.isAbort) {
          if (pbError.response?.data) {
            const messages = Object.entries(pbError.response.data)
              .map(([field, details]) => {
                let detailMsg = '';
                if (typeof details === 'object' && details !== null && 'message' in details) {
                  detailMsg = (details as { message: string }).message;
                } else {
                  detailMsg = JSON.stringify(details);
                }
                return `${field}: ${detailMsg}`;
              })
              .join('; ');
            displayError = `Failed to create the game: ${messages}`;
          } else if (pbError.message) {
            displayError = `Failed to create the game: ${pbError.message}`;
          }
        }
      }
      setError(displayError);
    } finally {
      setLoading(false);
    }
  }

  if (!signedIn) {
    return (
      <Alert severity="info">
        <Link component={RouterLink} to="/login">Log in</Link> to add a game to the catalog.
      </Alert>
    );
  }

  if (initialDataLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box component="form" onSubmit={handleSubmit}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Build the catalog card yourself – works for image-based CYOAs and for
        games already playable somewhere (including your own{' '}
        <Link component={RouterLink} to="/hosting">cyoa.cafe hosting</Link>).
      </Typography>

      <Stack spacing={2}>
        <Step n={1} title="The basics">
          <Stack spacing={2}>
            <TextField
              fullWidth
              label="Title"
              value={title}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setTitle(e.target.value)}
              required
            />
            {dupGame && (
              <Alert severity="warning" sx={{ mt: -1 }}>
                A game called “{dupGame.title}” already exists —{' '}
                <RouterLink to={`/game/${gameCanonicalKey(dupGame)}`} target="_blank" rel="noopener noreferrer">
                  open it
                </RouterLink>{' '}
                to make sure this isn’t a duplicate. You can still add it.
              </Alert>
            )}
            <TextField
              fullWidth
              label="Description"
              placeholder="What is this CYOA about? A couple of sentences is plenty."
              value={description}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setDescription(e.target.value)}
              required
              multiline
              rows={3}
            />
          </Stack>
        </Step>

        <Step
          n={2}
          title="How do people play it?"
          hint="Image pages: upload the CYOA as pictures, readable right on the game page. Playable link: the game runs on another site (or your cyoa.cafe hosting) and opens in a frame."
        >
          <ToggleButtonGroup
            value={imgOrLink}
            exclusive
            onChange={(_, v) => { if (v) setImgOrLink(v); }}
            size="small"
            sx={{ mb: 2 }}
          >
            <ToggleButton value="img">Image pages</ToggleButton>
            <ToggleButton value="link">Playable link</ToggleButton>
          </ToggleButtonGroup>

          {imgOrLink === 'link' ? (
            <TextField
              fullWidth
              label="Link to the playable game"
              placeholder="https://yourname.cyoa.cafe/your-game/"
              value={iframeUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setIframeUrl(e.target.value)}
              required
              type="url"
              inputProps={{ inputMode: 'url' }}
            />
          ) : (
            <>
              <CyoaImageUploader
                onImagesChange={setCyoaImages}
                onNeedsSplitChange={setSplitsNeeded}
              />
              {cyoaImages.length > 0 && (
                <Typography
                  variant="caption"
                  sx={{ display: 'block', mt: 1, color: pagesReady < cyoaImages.length ? 'text.secondary' : 'success.main' }}
                >
                  {pagesReady < cyoaImages.length
                    ? `Optimizing pages in the background… ${pagesReady}/${cyoaImages.length}`
                    : `All ${cyoaImages.length} page(s) ready — submit will be instant ✓`}
                </Typography>
              )}
            </>
          )}
        </Step>

        <Step
          n={3}
          title="Card image"
          hint="The cover players see in the catalog. Vertical ~3:4 crops look best."
        >
          <CardImageCropper onImageChange={setCardImage} buttonText="Upload card image" />
          {cardImage && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {cardImage.name} · {(cardImage.size / 1024).toFixed(0)} KB
            </Typography>
          )}
        </Step>

        <Step
          n={4}
          title="Author & tags"
          hint="Credit the author (even if it's you!) and tag the game so people can find it."
        >
          <Stack spacing={2}>
            <AuthorSelector
              value={authors}
              onChange={setAuthors}
              availableAuthors={availableAuthors}
              onAuthorsChange={refreshAuthors}
            />
            <Box>
              <TagSelector selectedTags={selectedTags} onTagsChange={setSelectedTags} />
            </Box>
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Missing a tag? Add your own:
              </Typography>
              <CustomTagSelector
                value={customTags}
                onChange={setCustomTags}
                availableTags={availableTags}
                onTagsChange={setAvailableTags}
              />
            </Box>
          </Stack>
        </Step>

        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 } }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={original}
                onChange={(e) => setOriginal(e.target.checked)}
              />
            }
            label={
              <Box>
                <Typography variant="body2">
                  This is a new game, not a repost
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Tick this only if you're the author releasing it here. New
                  releases get pinned to the top of the front page for 5 days,
                  so repost floods don't bury them.
                </Typography>
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0 }}
          />
        </Paper>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mt: 2, whiteSpace: 'pre-wrap' }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Button
        type="submit"
        variant="contained"
        color="primary"
        size="large"
        fullWidth
        sx={{ mt: 2 }}
        disabled={loading}
      >
        {loading ? <CircularProgress size={26} /> : 'Add game to catalog'}
      </Button>
    </Box>
  );
}
