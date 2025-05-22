// src/components/Sso/SsoLoginPage.tsx
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress } from '@mui/material';
import Login from '../Header/Login'; // Import your existing Login component
import { syncFlarumSession } from '../../utils/sso-utils'; // Path to your SSO utilities
import { pb } from '../../pocketbase/pocketbase';

const SsoLoginPage: React.FC = () => {
  const location = useLocation();
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Extract return_url from URL parameters
  const queryParams = new URLSearchParams(location.search);
  const returnUrl = queryParams.get('return') || 'https://forum.cyoa.cafe'; // Default URL if not provided

  const handleLoginSuccess = async () => {
    setIsProcessing(true);
    setMessage('Synchronizing session with the forum...');
    console.log('SSO Login Page: PocketBase login successful. Syncing Flarum session...');
    const syncResult = await syncFlarumSession();

    if (syncResult.success) {
      setMessage('Session with the forum synchronized! Redirecting...');
      console.log('SSO Login Page: Flarum session synced. Redirecting to:', returnUrl);
    } else {
      setMessage(`Forum synchronization error: ${syncResult.error}. You are logged in on the site. Redirecting...`);
      console.warn('SSO Login Page: Flarum session sync failed. Error:', syncResult.error, 'Redirecting anyway.');
    }

    // Small delay before redirect so the user sees the message
    setTimeout(() => {
      window.location.href = returnUrl;
    }, 2000);
  };

  // If the user is already logged in PocketBase when visiting this page,
  // immediately try to synchronize and redirect.
  useEffect(() => {
    if (pb.authStore.isValid) {
      console.log('SSO Login Page: User already logged in PocketBase. Triggering sync.');
      handleLoginSuccess();
    }
  }, []); // Empty dependency array, so it runs once on mount

  if (isProcessing || pb.authStore.isValid) { // Show indicator/message if processing or already logged in
    return (
      <Container maxWidth="sm">
        <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="h6">{message || 'Processing login...'}</Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5" sx={{ mb: 2 }}>
          Login to access the forum
        </Typography>
        {/*
          We use your existing Login component.
          It needs `open={true}` and an `onLoginSuccess` handler to be passed.
          `onClose` is probably not needed here in the same way as in a modal window,
          as this is a separate page. You can either adapt the Login component,
          or make its onClose redirect to returnUrl without logging in.
          For now, we assume onLoginSuccess is the main trigger.
        */}
        <Login
          open={true} // So it's visible (if it's a Dialog)
          onClose={() => { // When the Login dialog is cancelled/closed (if it works that way)
            console.log('SSO Login Page: Login cancelled/closed. Redirecting to Flarum.');
            window.location.href = returnUrl;
          }}
          onLoginSuccess={handleLoginSuccess}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          After logging in, you will be automatically redirected back to the forum.
        </Typography>
      </Box>
    </Container>
  );
};

export default SsoLoginPage;