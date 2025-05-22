// src/components/Sso/SsoSignupPage.tsx
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress } from '@mui/material';
import Login from '../Header/Login'; // We use the same Login component, it can switch to registration mode
import { syncFlarumSession } from '../../utils/sso-utils';
import { pb } from '../../pocketbase/pocketbase';

const SsoSignupPage: React.FC = () => {
  const location = useLocation();
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const queryParams = new URLSearchParams(location.search);
  const returnUrl = queryParams.get('return') || 'https://forum.cyoa.cafe';

  // This function will be called after successful *registration* and subsequent login (if your Login component does this)
  // or simply after successful registration if the Login component does not log in automatically.
  // It's important that pb.authStore.isValid becomes true.
  const handleSignupSuccess = async () => {
    setIsProcessing(true);
    setMessage('Synchronizing session with the forum...');
    console.log('SSO Signup Page: PocketBase signup/login successful. Syncing Flarum session...');
    const syncResult = await syncFlarumSession();

    if (syncResult.success) {
      setMessage('Session with the forum synchronized! Redirecting...');
      console.log('SSO Signup Page: Flarum session synced. Redirecting to:', returnUrl);
    } else {
      setMessage(`Forum synchronization error: ${syncResult.error}. You are registered/logged in on the site. Redirecting...`);
      console.warn('SSO Signup Page: Flarum session sync failed. Error:', syncResult.error, 'Redirecting anyway.');
    }

    setTimeout(() => {
      window.location.href = returnUrl;
    }, 2000);
  };

  // If the user is already logged in PocketBase
  useEffect(() => {
    if (pb.authStore.isValid) {
      console.log('SSO Signup Page: User already logged in PocketBase. Triggering sync.');
      handleSignupSuccess(); // Maybe the user landed here while already logged in
    }
  }, []);


  if (isProcessing || pb.authStore.isValid) {
    return (
      <Container maxWidth="sm">
        <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="h6">{message || 'Processing registration...'}</Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5" sx={{ mb: 2 }}>
          Sign up to access the forum
        </Typography>
        {/*
          Pass isRegistering={true} if your Login component can accept such a prop
          to display the registration form by default.
          If not, the user will have to click "Register" in your Login component themselves.
          onLoginSuccess here will mean successful registration (and, possibly, automatic login).
        */}
        <Login
          open={true}
          // We need a way to tell the Login component to open the registration tab.
          // If your Login component is a dialog that manages the isRegistering state itself,
          // then this prop might not be needed, the user will choose themselves.
          // For example, let's assume that your Login component, upon `onLoginSuccess`
          // is called also after successful registration (when the user becomes pb.authStore.isValid).
          onClose={() => {
            console.log('SSO Signup Page: Signup cancelled/closed. Redirecting to Flarum.');
            window.location.href = returnUrl;
          }}
          onLoginSuccess={handleSignupSuccess} // We use the same handler, as login is expected after registration
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          After signing up, you will be automatically redirected back to the forum.
        </Typography>
      </Box>
    </Container>
  );
};

export default SsoSignupPage;