// src/components/Header/Login.jsx

import { useCallback, useContext, useEffect, useState } from 'react';
import {
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import { AuthContext, pb } from '../../pocketbase/pocketbase';

const LoginButton = styled(Button)(() => ({
  backgroundColor: '#635DFF',
  color: 'white',
  '&:hover': {
    backgroundColor: '#4752C4',
  },
  width: '70%',
  margin: '0 auto',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  padding: '10px',
  borderRadius: '3px',
  fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  fontWeight: 500,
  fontSize: '14px',
  lineHeight: '20px',
  textTransform: 'none',
}));

export default function Login({ open = false, onClose = () => {}, onLoginSuccess = () => {} }) {
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { signedIn } = useContext(AuthContext);

  const handleClose = useCallback(() => {
    setError('');
    setIsLoading(false);
    onClose();
  }, [onClose]);

  async function handleAuth0Login() {
    setIsLoading(true);
    setError('');
    try {
      const authMethods = await pb.collection('users').listAuthMethods();
      console.log('Available auth providers:', authMethods.authProviders);
  
      const auth0Provider = authMethods.authProviders.find(
        provider => provider.displayName === 'auth0'
      );
  
      if (!auth0Provider) {
        throw new Error('Auth0 provider not found');
      }
  
      // Определите нужный redirect_uri. Если ваше приложение работает на localhost:8091,
      // то редирект должен вести на URL, указанный в Allowed Callback URLs, например:
      const redirectUri = 'http://127.0.0.1:8090/api/oauth2-redirect';
  
      // Создаем URL на основе auth0Provider.authUrl
      const authUrl = new URL(auth0Provider.authUrl, window.location.origin);
  
      // Всегда принудительно устанавливаем redirect_uri в нужное значение
      authUrl.searchParams.set('redirect_uri', redirectUri);
  
      console.log('Final auth URL:', authUrl.toString());
      window.location.href = authUrl.toString();
  
    } catch (error) {
      console.error('Full error object:', error);
      const errorMessage = error.response?.data?.message || error.message || 'Login failed';
      setError(`${errorMessage} (${error.status || 'unknown status'})`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (signedIn) handleClose();
  }, [signedIn, handleClose]);

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>Login</DialogTitle>
      <DialogContent>
        <LoginButton onClick={handleAuth0Login} disabled={isLoading}>
          {isLoading ? <CircularProgress size={24} /> : 'Continue with Auth0'}
        </LoginButton>
        {error && (
          <Typography color="error" style={{ marginTop: '10px', textAlign: 'center' }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="primary" disabled={isLoading}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}