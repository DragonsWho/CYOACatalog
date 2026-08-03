// Выбор/загрузка аватара. Аватар — file-поле users.avatar (то же, что заполняет
// Discord-OAuth). Выбранную картинку кадрируем вручную в AvatarCropDialog
// (перетаскивание + зум), на выходе — квадрат webp 256px (десятки КБ). После
// апдейта — authRefresh, чтобы шапка/чат/комменты подхватили аватар без релоада.

import React, { useContext, useRef, useState } from 'react';
import { Alert, Avatar, Box, Button, CircularProgress, Typography } from '@mui/material';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import { pb, AuthContext } from '../../pocketbase/pocketbase';
import { avatarUrl } from '../CyoaPage/Comments/commentsApi';
import AvatarCropDialog from './AvatarCropDialog';

export default function AvatarSettings() {
  const { user } = useContext(AuthContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null); // objectURL для диалога
  const [preview, setPreview] = useState<string | null>(null); // objectURL готового кропа
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!user) return null;

  const shownSrc = preview || avatarUrl(user);
  const initial = (user.name || user.username || '?').charAt(0).toUpperCase();

  const clearPreview = () => {
    setPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    setFile(null);
  };
  const closeCrop = () => {
    setCropSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // позволяем выбрать тот же файл повторно
    if (!f) return;
    setMsg(null);
    setCropSrc((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
  };

  const onCropped = (cropped: File) => {
    closeCrop();
    setFile(cropped);
    setPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(cropped); });
  };

  const save = async () => {
    if (!file) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append('avatar', file);
      await pb.collection('users').update(user.id, fd);
      await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
      clearPreview();
      setMsg({ type: 'success', text: 'Avatar updated.' });
    } catch (err) {
      setMsg({ type: 'error', text: (err as Error).message || 'Upload failed.' });
    } finally {
      setBusy(false);
    }
  };

  const removeAvatar = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await pb.collection('users').update(user.id, { avatar: null });
      await pb.collection('users').authRefresh({ expand: 'blocked_tags' });
      clearPreview();
      setMsg({ type: 'success', text: 'Avatar removed.' });
    } catch (err) {
      setMsg({ type: 'error', text: (err as Error).message || 'Failed to remove.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      {msg && <Alert severity={msg.type} sx={{ mb: 2, borderRadius: 1 }}>{msg.text}</Alert>}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, flexWrap: 'wrap' }}>
        <Avatar
          src={shownSrc}
          sx={{ width: 80, height: 80, fontSize: '2rem', fontWeight: 600, bgcolor: '#3a3a3a' }}
        >
          {initial}
        </Avatar>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <input ref={inputRef} accept="image/*" type="file" onChange={onPick} style={{ display: 'none' }} />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<PhotoCameraOutlinedIcon />}
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {file ? 'Choose another' : 'Choose image'}
            </Button>
            {file && (
              <Button variant="contained" color="primary" size="small" disabled={busy} onClick={save}>
                {busy ? <CircularProgress size={16} /> : 'Save'}
              </Button>
            )}
            {file ? (
              <Button size="small" color="inherit" disabled={busy} onClick={clearPreview}>
                Cancel
              </Button>
            ) : (
              avatarUrl(user) && (
                <Button size="small" color="inherit" disabled={busy} onClick={removeAvatar} sx={{ opacity: 0.7 }}>
                  Remove
                </Button>
              )
            )}
          </Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', opacity: 0.7 }}>
            Drag to reposition, zoom to fit. Auto-compressed; corners trimmed to a circle.
          </Typography>
        </Box>
      </Box>

      <AvatarCropDialog open={!!cropSrc} src={cropSrc} onCancel={closeCrop} onCropped={onCropped} />
    </Box>
  );
}
