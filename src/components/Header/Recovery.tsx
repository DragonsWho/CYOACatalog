import React, { useState,} from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, Button, Typography, Box, Alert, Fade } from '@mui/material';
import { styled, alpha } from '@mui/material/styles';
import TextField from '@mui/material/TextField';
import { Turnstile } from '@marsidev/react-turnstile';
import { pb } from '../../pocketbase/pocketbase';
import { ClientResponseError } from 'pocketbase';

const TURNSTILE_SITE_KEY = '0x4AAAAAAA9kgpL5L0h777U9';

const StyledDialog = styled(Dialog)(() => ({
  '& .MuiBackdrop-root': { backgroundColor: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(5px)' },
  '& .MuiDialog-paper': {
    backgroundImage: 'none', backgroundColor: '#181818', borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.05)', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
    maxWidth: 400, width: '100%', minHeight: '350px', padding: 0, display: 'flex', flexDirection: 'column',
  },
}));

const HeaderTitle = styled(Box)(({ theme }) => ({
  height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'center',
  backgroundColor: '#101010', borderBottom: '1px solid rgba(255,255,255,0.05)',
  borderTop: `3px solid ${theme.palette.primary.main}`, color: '#fff', fontWeight: 700,
  fontSize: '0.95rem', letterSpacing: '1px', textTransform: 'uppercase',
}));

const StyledTextField = styled(TextField)(({ theme }) => ({
  '& .MuiOutlinedInput-root': {
    backgroundColor: '#252525', borderRadius: 8, transition: 'all 0.2s ease-in-out',
    '& fieldset': { borderColor: 'transparent' },
    '&:hover': { backgroundColor: '#2a2a2a' },
    '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.1)' },
    '&.Mui-focused': { backgroundColor: '#2a2a2a', boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.25)}` },
    '&.Mui-focused fieldset': { borderColor: theme.palette.primary.main, borderWidth: 1 },
  },
  '& .MuiInputBase-input': { color: '#fff', padding: '15px 16px', fontWeight: 500 },
  '& .MuiInputLabel-root': { color: '#888', transform: 'translate(14px, 16px) scale(1)' },
  '& .MuiInputLabel-root.Mui-focused, & .MuiInputLabel-root.MuiFormLabel-filled': {
    transform: 'translate(14px, -9px) scale(0.75)', color: theme.palette.primary.main, backgroundColor: '#181818', padding: '0 6px', borderRadius: 4,
  },
}));

interface RecoveryProps { open?: boolean; onClose?: () => void; }

export default function Recovery({ open = false, onClose = () => {} }: RecoveryProps) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const handleClose = () => {
    setEmail('');
    setIsSuccess(false);
    setErrorMsg(null);
    onClose();
  };

  const verifyBot = async () => {
    if (!turnstileToken) throw new Error("Please complete the security check.");
    const formData = new FormData();
    formData.append('token', turnstileToken);
    const res = await fetch('/api/custom/verify-turnstile', { method: 'POST', body: formData });
    if (!res.ok) throw new Error("Security check failed.");
    const json = await res.json();
    if (!json.success) throw new Error("Verification failed.");
    return true;
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsLoading(true);
    setErrorMsg(null);

    try {
      await verifyBot();
      await pb.collection('users').requestPasswordReset(email);
      setIsSuccess(true);
    } catch (err: unknown) {
      if (err instanceof ClientResponseError) {
        setErrorMsg(err.response?.message || 'Failed to request password reset.');
      } else {
        setErrorMsg((err as Error).message);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <StyledDialog open={open} onClose={handleClose} scroll="paper">
      <HeaderTitle>Reset Password</HeaderTitle>
      <DialogContent sx={{ px: 4, pt: 4, pb: 3, display: 'flex', flexDirection: 'column' }}>
        {isSuccess ? (
          <Fade in={true}>
            <Box sx={{ textAlign: 'center', py: 2 }}>
              <Alert severity="success" sx={{ mb: 3, borderRadius: 2 }}>Recovery email sent! Check your inbox.</Alert>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                Follow the link in the email to reset your password.
              </Typography>
              <Button onClick={() => { handleClose(); navigate('/login'); }} variant="outlined" color="primary" fullWidth sx={{ borderRadius: 2, fontWeight: 700 }}>
                Back to Login
              </Button>
            </Box>
          </Fade>
        ) : (
          <Fade in={true} timeout={300}>
            <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography variant="body2" sx={{ color: '#888', mb: 3, textAlign: 'center' }}>
                Enter the email address associated with your account to receive a reset link.
              </Typography>

              <StyledTextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth required disabled={isLoading} sx={{ mb: 2 }} />

              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: '80px', py: 1 }}>
                <Turnstile siteKey={TURNSTILE_SITE_KEY} onSuccess={setTurnstileToken} onError={() => setErrorMsg("Could not load challenge")} onExpire={() => setTurnstileToken(null)} options={{ theme: 'dark' }} />
              </Box>

              <Button type="submit" variant="contained" color="primary" fullWidth disabled={isLoading || !turnstileToken} sx={{ mt: 1, borderRadius: 2, py: 1.2, fontWeight: 700, textTransform: 'uppercase' }}>
                Send Recovery Link
              </Button>

              {errorMsg && <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>{errorMsg}</Alert>}
            </Box>
          </Fade>
        )}
      </DialogContent>
    </StyledDialog>
  );
}