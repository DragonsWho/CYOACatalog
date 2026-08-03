// Интерактивный кроп аватара: фиксированный квадратный вьюпорт, картинка
// перетаскивается и зумится (как в Instagram/react-easy-crop, но без зависимости).
// Круглая маска-подсказка показывает, что углы обрежутся под круглый аватар.
// На Apply мапим вьюпорт обратно в координаты исходника и рисуем в webp OUT×OUT.

import React, { useCallback, useRef, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Slider, Stack,
} from '@mui/material';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';

const STAGE = 288;     // сторона вьюпорта на экране, px
const OUT = 256;       // сторона итогового аватара, px
const OUT_Q = 0.85;    // webp quality
const MAX_ZOOM = 4;

interface Props {
  open: boolean;
  src: string | null;   // objectURL выбранного файла
  onCancel: () => void;
  onCropped: (file: File) => void;
}

export default function AvatarCropDialog({ open, src, onCancel, onCropped }: Props) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 }); // top-left картинки отн. вьюпорта
  const [busy, setBusy] = useState(false);

  // baseScale: при zoom=1 меньшая сторона ровно закрывает вьюпорт (cover).
  const baseScale = nat ? STAGE / Math.min(nat.w, nat.h) : 1;
  const scale = baseScale * zoom;

  // Держим картинку так, чтобы она всегда полностью закрывала вьюпорт.
  const clamp = useCallback((o: { x: number; y: number }, z: number) => {
    if (!nat) return o;
    const s = baseScale * z;
    return {
      x: Math.min(0, Math.max(STAGE - nat.w * s, o.x)),
      y: Math.min(0, Math.max(STAGE - nat.h * s, o.y)),
    };
  }, [nat, baseScale]);

  const onImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const im = e.currentTarget;
    const w = im.naturalWidth;
    const h = im.naturalHeight;
    const s = STAGE / Math.min(w, h);
    setNat({ w, h });
    setZoom(1);
    setOffset({ x: (STAGE - w * s) / 2, y: (STAGE - h * s) / 2 }); // центрируем
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset(clamp({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }, zoom));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
  };

  // Зум с якорем в центре вьюпорта (не «прыгает» под пальцем).
  const changeZoom = (z: number) => {
    if (!nat) { setZoom(z); return; }
    const sOld = baseScale * zoom;
    const sNew = baseScale * z;
    const cx = (STAGE / 2 - offset.x) / sOld;
    const cy = (STAGE / 2 - offset.y) / sOld;
    setZoom(z);
    setOffset(clamp({ x: STAGE / 2 - cx * sNew, y: STAGE / 2 - cy * sNew }, z));
  };

  const apply = async () => {
    if (!imgRef.current || !nat) return;
    setBusy(true);
    try {
      const s = baseScale * zoom;
      const srcX = -offset.x / s;
      const srcY = -offset.y / s;
      const srcSize = STAGE / s;
      const canvas = document.createElement('canvas');
      canvas.width = OUT;
      canvas.height = OUT;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(imgRef.current, srcX, srcY, srcSize, srcSize, 0, 0, OUT, OUT);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/webp', OUT_Q));
      if (!blob) throw new Error('crop failed');
      onCropped(new File([blob], 'avatar.webp', { type: 'image/webp' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open && !!src}
      onClose={onCancel}
      maxWidth="xs"
      PaperProps={{ sx: { bgcolor: '#1e1e1e', color: '#fff', border: '1px solid #333' } }}
    >
      <DialogTitle sx={{ fontSize: '1rem' }}>Adjust avatar</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <Box
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            sx={{
              position: 'relative', width: STAGE, height: STAGE, overflow: 'hidden',
              borderRadius: 1, bgcolor: '#000', cursor: 'move',
              touchAction: 'none', userSelect: 'none',
            }}
          >
            {src && (
              <Box
                component="img"
                ref={imgRef}
                src={src}
                onLoad={onImgLoad}
                draggable={false}
                alt=""
                sx={{
                  position: 'absolute',
                  left: offset.x, top: offset.y,
                  width: nat ? nat.w * scale : 'auto',
                  height: nat ? nat.h * scale : 'auto',
                  maxWidth: 'none', pointerEvents: 'none',
                }}
              />
            )}
            {/* Круглая маска: затемняет всё вне будущего круга аватара. */}
            <Box sx={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', pointerEvents: 'none',
            }} />
          </Box>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2, px: 0.5 }}>
          <ZoomOutIcon sx={{ opacity: 0.6, fontSize: 20 }} />
          <Slider
            size="small" min={1} max={MAX_ZOOM} step={0.01} value={zoom}
            onChange={(_, v) => changeZoom(v as number)}
            aria-label="Zoom"
          />
          <ZoomInIcon sx={{ opacity: 0.6, fontSize: 20 }} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} color="inherit" sx={{ color: '#888' }}>Cancel</Button>
        <Button onClick={apply} variant="contained" disabled={busy || !nat}>Apply</Button>
      </DialogActions>
    </Dialog>
  );
}
