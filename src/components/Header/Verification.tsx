import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Container, Paper, Stack, TextField, Typography } from '@mui/material';
import { styled } from '@mui/material/styles';
import { pb } from '../../pocketbase/pocketbase';
import { ClientResponseError } from 'pocketbase';

const StyledTextField = styled(TextField)(() => ({
  '& .MuiInputBase-input': { backgroundColor: '#1e1e1e', color: '#e0e0e0' },
  '& .MuiOutlinedInput-root': { backgroundColor: '#1e1e1e', color: '#e0e0e0' },
}));

export default function VerificationPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token'); // PocketBase отправляет токен в ссылке

  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(!!token); // Если есть токен, сразу грузимся
  const [status, setStatus] = useState<'idle' | 'success_confirm' | 'success_sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      setIsLoading(true);
      pb.collection('users').confirmVerification(token)
        .then(() => {
          setStatus('success_confirm');
        })
        .catch((err: unknown) => {
          setStatus('error');
          setErrorMsg(err instanceof ClientResponseError ? err.message : 'Invalid or expired verification link.');
        })
        .finally(() => setIsLoading(false));
    }
  }, [token]);

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setStatus('idle');
    try {
      await pb.collection('users').requestVerification(email);
      setStatus('success_sent');
    } catch (err: unknown) {
      setStatus('error');
      setErrorMsg(err instanceof ClientResponseError ? err.message : 'Failed to send email.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 6, md: 10 } }}>
      <Paper elevation={6} sx={{ p: { xs: 3, md: 5 }, backgroundImage: 'none', backgroundColor: '#252525' }}>
        <Stack spacing={2} alignItems="center">
          <Typography variant="h4" fontWeight={700} textAlign="center" color="#fff">Email Verification</Typography>
        </Stack>

        <Box sx={{ mt: 3 }}>
          {isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          ) : status === 'success_confirm' ? (
            <Stack spacing={3}>
              <Alert severity="success">Your email has been verified! You can return to the site now.</Alert>
              <Button variant="contained" fullWidth onClick={() => navigate('/')}>Go to Homepage</Button>
            </Stack>
          ) : (
            <Stack spacing={3}>
              {status === 'success_sent' && <Alert severity="info">Verification link sent to {email}.</Alert>}
              {status === 'error' && <Alert severity="error">{errorMsg}</Alert>}
              
              {!token && status !== 'success_sent' && (
                <Box component="form" onSubmit={handleResend}>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                    Didn't receive the link? Enter your email to resend it.
                  </Typography>
                  <StyledTextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth required sx={{ mb: 2 }} />
                  <Button type="submit" variant="contained" color="primary" fullWidth disabled={isLoading}>Resend Link</Button>
                </Box>
              )}
            </Stack>
          )}
        </Box>
      </Paper>
    </Container>
  );
}