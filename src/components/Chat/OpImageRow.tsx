// OP image strip: up to five, ordered, each with a NUMBER used by the `[img1]`…`[img5]` text marker
// (number must be visible or the marker means nothing). Each image can move left/right (order =
// numbers), insert its marker at the cursor, or be removed. No drag-and-drop on purpose: on phones
// it needs long-press, fights strip scrolling and needs buttons as fallback anyway. Unmarked images
// show at the end of the post (splitOpText) — stated in words here since otherwise it's learned
// only by experiment.

import { useEffect, useState } from 'react';
import { Box, Button, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import SubdirectoryArrowLeftIcon from '@mui/icons-material/SubdirectoryArrowLeft';
import { OP_IMAGES_MAX, type OpImageSlot } from './communityApi';

type Props = {
  slots: OpImageSlot[];
  onSlots: (next: OpImageSlot[]) => void;
  // Preview URLs per slot computed by the parent (useOpSlotUrls): the post preview needs the same
  // URLs; a second set of blob URLs would waste tab memory.
  urls: string[];
  onInsert?: (n: number) => void;
  hasToken?: (n: number) => boolean;
  disabled?: boolean;
};

// Blob URLs must be revoked manually, or a dialog where a dozen images were tried keeps them all in
// memory.
export function useOpSlotUrls(
  slots: OpImageSlot[],
  urlOf?: (name: string) => string | undefined,
): string[] {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    const made: string[] = [];
    const next = slots.map((s) => {
      if ('file' in s) {
        const u = URL.createObjectURL(s.file);
        made.push(u);
        return u;
      }
      return urlOf?.(s.name) ?? '';
    });
    setUrls(next);
    return () => { for (const u of made) URL.revokeObjectURL(u); };
    // urlOf is a plain parent function that changes every render — not in deps, or blob URLs get
    // revoked constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);
  return urls;
}

const THUMB = 76;

export default function OpImageRow({ slots, onSlots, urls, onInsert, hasToken, disabled }: Props) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const full = slots.length >= OP_IMAGES_MAX;

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= slots.length) return;
    const next = slots.slice();
    [next[i], next[j]] = [next[j], next[i]];
    onSlots(next);
  };

  const drop = (i: number) => onSlots(slots.filter((_, k) => k !== i));

  const add = (files: File[]) => {
    if (!files.length) return;
    onSlots([...slots, ...files.map((f) => ({ file: f }))].slice(0, OP_IMAGES_MAX));
  };

  return (
    <Stack spacing={0.5}>
      <input
        ref={setInput}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ''; }}
      />

      {slots.length > 0 && (
        <Box sx={{
          display: 'flex',
          gap: 0.75,
          // Horizontal scroll, not wrap: five tiles don't fit on a phone and a height-jumping form
          // is worse.
          overflowX: 'auto',
          pb: 0.5,
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}>
          {slots.map((s, i) => (
            <Box
              key={('file' in s ? s.file.name : s.name) + i}
              sx={{ position: 'relative', flexShrink: 0, width: THUMB }}
            >
              <Box
                component="img"
                src={urls[i] || ''}
                alt=""
                sx={{
                  display: 'block',
                  width: THUMB,
                  height: THUMB,
                  objectFit: 'cover',
                  borderRadius: 1,
                  border: 1,
                  borderColor: hasToken?.(i + 1) ? 'primary.main' : 'divider',
                  bgcolor: 'rgba(255,255,255,0.04)',
                }}
              />
              {/*
                Number = marker name. Border turns blue when the marker is placed: shows which
                images are positioned and which go to the end.
              */}
              <Box sx={{
                position: 'absolute', top: 2, left: 2,
                px: 0.5, borderRadius: 0.5, fontSize: 11, fontWeight: 700,
                bgcolor: 'rgba(0,0,0,0.6)', color: '#fff',
              }}>
                {i + 1}
              </Box>
              <Tooltip title="Remove">
                <IconButton
                  size="small"
                  disabled={disabled}
                  onClick={() => drop(i)}
                  aria-label={`Remove image ${i + 1}`}
                  sx={{
                    position: 'absolute', top: -6, right: -6, p: 0.25,
                    bgcolor: 'rgba(0,0,0,0.65)', color: '#fff',
                    '&:hover': { bgcolor: 'rgba(0,0,0,0.85)' },
                  }}
                >
                  <CloseIcon sx={{ fontSize: 13 }} />
                </IconButton>
              </Tooltip>
              <Stack direction="row" justifyContent="center" alignItems="center" sx={{ mt: -0.25 }}>
                <IconButton size="small" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label="Move left" sx={{ p: 0.25 }}>
                  <ChevronLeftIcon sx={{ fontSize: 15 }} />
                </IconButton>
                {onInsert && (
                  <Tooltip title={`Put [img${i + 1}] where the cursor is`}>
                    <IconButton size="small" disabled={disabled} onClick={() => onInsert(i + 1)} aria-label={`Insert image ${i + 1}`} sx={{ p: 0.25 }}>
                      <SubdirectoryArrowLeftIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                )}
                <IconButton size="small" disabled={disabled || i === slots.length - 1} onClick={() => move(i, 1)} aria-label="Move right" sx={{ p: 0.25 }}>
                  <ChevronRightIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Stack>
            </Box>
          ))}
        </Box>
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexWrap: 'wrap' }}>
        <Button
          size="small"
          startIcon={<ImageOutlinedIcon />}
          disabled={disabled || full}
          onClick={() => input?.click()}
        >
          {slots.length ? 'Add image' : 'Add images'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          {full
            ? `${OP_IMAGES_MAX} images — that's the limit`
            : `up to ${OP_IMAGES_MAX}, 8 MB each${slots.length ? ' · unplaced ones go at the end' : ''}`}
        </Typography>
      </Stack>
    </Stack>
  );
}
