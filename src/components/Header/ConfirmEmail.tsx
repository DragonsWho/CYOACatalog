// Page from the "confirm your address" email. Separate from /verification (standard confirmation of
// an already linked email): here a new email is linked to an account without a password (Discord
// login). Why not the standard PB API — see account_email.go. No login required: the email is often
// opened on a phone where nobody is logged in; reading it in that mailbox and clicking the link
// proves control of the address.

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Container, Paper, Stack, Typography } from '@mui/material';
import { pb } from '../../pocketbase/pocketbase';
import { ClientResponseError } from 'pocketbase';

export default function ConfirmEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>(token ? 'loading' : 'error');
  const [email, setEmail] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(
    token ? null : 'This link is missing its token — open the one from the letter as is.',
  );
  // In dev React mounts effects twice; the second run hits "token already used" and shows an error
  // over success.
  const doneRef = useRef(false);

  useEffect(() => {
    if (!token || doneRef.current) return;
    doneRef.current = true;
    pb.send('/api/custom/account/email/confirm', { method: 'POST', body: { token } })
      .then(async (res: { email?: string }) => {
        setEmail(res?.email || '');
        setStatus('ok');
        // This tab's token (if logged in here) remembers the old address — refresh the record, else
        // the profile shows the previous one for a while.
        if (pb.authStore.isValid) {
          try { await pb.collection('users').authRefresh(); } catch { }
        }
      })
      .catch((err: unknown) => {
        setStatus('error');
        setErrorMsg(
          err instanceof ClientResponseError
            ? err.message
            : 'This link is invalid or has expired.',
        );
      });
  }, [token]);

  return (
    <Container maxWidth="sm" sx={{ py: { xs: 6, md: 10 } }}>
      <Paper elevation={6} sx={{ p: { xs: 3, md: 5 }, backgroundImage: 'none', backgroundColor: '#252525' }}>
        <Stack spacing={2} alignItems="center">
          <Typography variant="h4" fontWeight={700} textAlign="center" color="#fff">Email Confirmation</Typography>
        </Stack>

        <Box sx={{ mt: 3 }}>
          {status === 'loading' && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>
          )}

          {status === 'ok' && (
            <Stack spacing={3}>
              <Alert severity="success">
                {email ? `${email} is now linked to your account.` : 'Your email is now linked to your account.'}
              </Alert>
              <Typography variant="body2" color="text.secondary">
                You can now sign in with this address, and use “forgot password” to set a password
                and get back in if you ever lose access to your other login.
              </Typography>
              <Button variant="contained" fullWidth onClick={() => navigate('/profile')}>Go to Profile</Button>
            </Stack>
          )}

          {status === 'error' && (
            <Stack spacing={3}>
              <Alert severity="error">{errorMsg}</Alert>
              <Typography variant="body2" color="text.secondary">
                Confirmation links expire. Open your profile and send a new one.
              </Typography>
              <Button variant="outlined" fullWidth onClick={() => navigate('/profile')}>Go to Profile</Button>
            </Stack>
          )}
        </Box>
      </Paper>
    </Container>
  );
}
