// src/components/Add/CardImageCropper.tsx
// Quality card-image cropper (replaces the legacy ImageCompressor).
//
// Why this exists: the old cropper drove the crop offset in *screen* pixels but
// applied it as a *canvas*-pixel source coordinate. On a narrow window the canvas
// was CSS-scaled (`maxWidth: 100%`), so the two diverged and the crop read past the
// bottom of the image — producing a mostly-transparent frame that WebP squashed to
// ~1 KB (the "988-byte cropped_image.jpg" bug). It also forced a full-width 3:4 box,
// so any source wider than 3:4 got transparent padding at the bottom.
//
// react-easy-crop handles zoom/pan and screen↔image coordinate mapping for us
// (mouse + touch), and we export with a solid background fill + a non-empty guard,
// so a bad crop fails loudly instead of silently shipping a blank card.

import { useCallback, useState } from 'react';
import Cropper, { Area } from 'react-easy-crop';
import { Button, Typography, Box, CircularProgress, Alert, Slider, Stack } from '@mui/material';
import { useTheme } from '@mui/material/styles';

// Card aspect on the site is 3:4 portrait (width:height).
const ASPECT = 3 / 4;
// Cap exported width so cards stay small; height follows from the aspect.
const MAX_OUTPUT_WIDTH = 600;
// Anything below this after encoding is almost certainly a blank/transparent crop.
const MIN_BLOB_BYTES = 2 * 1024;

interface FileInfo {
  originalSize: number;
  compressedSize?: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

export function CardImageCropper({
  onImageChange,
  buttonText = 'Upload card image',
  quality = 0.82,
}: {
  onImageChange: (file: File | null) => void;
  buttonText?: string;
  quality?: number;
}) {
  const theme = useTheme();
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const onCropComplete = useCallback((_area: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  function reset() {
    setImageSrc(null);
    setPreview(null);
    setFileInfo(null);
    setCroppedAreaPixels(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setError(null);
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file next time.
    event.target.value = '';
    if (!file) return;
    reset();
    setFileInfo({ originalSize: file.size });
    const reader = new FileReader();
    reader.onload = (e) => setImageSrc(e.target?.result as string);
    reader.onerror = () => setError('Failed to read the selected file. Please try again.');
    reader.readAsDataURL(file);
  }

  async function handleCrop() {
    if (!imageSrc || !croppedAreaPixels) return;
    setIsBusy(true);
    setError(null);
    try {
      const image = await loadImage(imageSrc);

      const outWidth = Math.min(Math.round(croppedAreaPixels.width), MAX_OUTPUT_WIDTH);
      const scale = outWidth / croppedAreaPixels.width;
      const outHeight = Math.max(1, Math.round(croppedAreaPixels.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = outWidth;
      canvas.height = outHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');

      // Fill first so any out-of-bounds / transparent area becomes solid instead of
      // alpha (which WebP would compress to a near-empty, "invisible" card).
      ctx.fillStyle = theme.palette.background.paper;
      ctx.fillRect(0, 0, outWidth, outHeight);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(
        image,
        croppedAreaPixels.x,
        croppedAreaPixels.y,
        croppedAreaPixels.width,
        croppedAreaPixels.height,
        0,
        0,
        outWidth,
        outHeight,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', quality),
      );

      if (!blob || blob.size < MIN_BLOB_BYTES) {
        setError(
          'The cropped image came out empty. Please re-position the crop box over the artwork and try again.',
        );
        onImageChange(null);
        return;
      }

      if (preview) URL.revokeObjectURL(preview);
      setPreview(URL.createObjectURL(blob));
      setFileInfo((prev) => ({ originalSize: prev?.originalSize ?? blob.size, compressedSize: blob.size }));
      const file = new File([blob], 'card_image.webp', { type: 'image/webp' });
      onImageChange(file);
    } catch (err) {
      console.error('[CardImageCropper] crop failed:', err);
      setError('Failed to crop the image. Please try a different file.');
      onImageChange(null);
    } finally {
      setIsBusy(false);
    }
  }

  function handleRemove() {
    if (preview) URL.revokeObjectURL(preview);
    reset();
    onImageChange(null);
  }

  return (
    <Box>
      <input
        accept="image/*"
        id="card-image-upload"
        type="file"
        onChange={handleFile}
        style={{ display: 'none' }}
      />
      <label htmlFor="card-image-upload">
        <Button variant="contained" component="span" disabled={isBusy}>
          {buttonText}
        </Button>
      </label>

      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}

      {imageSrc && !preview && (
        <Box sx={{ mt: 2 }}>
          <Box
            sx={{
              position: 'relative',
              width: '100%',
              height: 360,
              bgcolor: 'background.default',
              borderRadius: 1,
              overflow: 'hidden',
            }}
          >
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={ASPECT}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              restrictPosition
              showGrid
            />
          </Box>
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
            <Typography variant="body2" sx={{ minWidth: 48 }}>
              Zoom
            </Typography>
            <Slider
              value={zoom}
              min={1}
              max={3}
              step={0.01}
              onChange={(_e, v) => setZoom(v as number)}
              aria-label="Zoom"
            />
            <Button variant="contained" onClick={handleCrop} disabled={isBusy} sx={{ minWidth: 120 }}>
              {isBusy ? <CircularProgress size={20} /> : 'Crop'}
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Drag to reposition · scroll or pinch to zoom · the box is the 3:4 card frame.
          </Typography>
        </Box>
      )}

      {preview && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="h6">Preview</Typography>
          <img
            src={preview}
            alt="Card preview"
            style={{ maxWidth: '100%', maxHeight: 300, objectFit: 'contain', display: 'block' }}
          />
          {fileInfo && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              Original: {(fileInfo.originalSize / 1024).toFixed(1)} KB
              {fileInfo.compressedSize != null && (
                <> · Cropped: {(fileInfo.compressedSize / 1024).toFixed(1)} KB</>
              )}
            </Typography>
          )}
          <Button onClick={handleRemove} sx={{ mt: 1 }}>
            Remove / re-crop
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default CardImageCropper;
