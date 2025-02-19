import { FormEvent, useCallback, useContext, useEffect, useState } from 'react';
import {
  TextField,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  CircularProgress,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import SvgIcon from '@mui/material/SvgIcon';
import { AuthContext, login, pb } from '../../pocketbase/pocketbase';

// Интерфейс для обработки ошибок
interface ErrorResponse {
  response?: {
    data?: {
      message?: string;
    };
  };
  message?: string;
  status?: number;
}

// Компонент иконки Discord
const DiscordIcon = () => (
  <SvgIcon>
    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z" />
  </SvgIcon>
);

// Стили для кнопки Discord
const DiscordButton = styled(Button)(() => ({
  backgroundColor: '#5865F2',
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

// Стили для кнопки Auth0 (временно закомментировано)
/* const Auth0Button = styled(Button)(() => ({
  backgroundColor: '#635DFF',
  color: 'white',
  '&:hover': {
    backgroundColor: '#4752C4',
  },
  width: '70%',
  margin: '10px auto',
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
})); */

// Основной компонент Login
export default function Login({ open = false, onClose = () => {}, onLoginSuccess = () => {} }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const { signedIn } = useContext(AuthContext);

  // Обработчик закрытия модального окна
  const handleClose = useCallback(() => {
    setIdentifier('');
    setPassword('');
    setError('');
    setIsLoading(false);
    onClose();
  }, [onClose]);

  // Обработчик входа
  async function handleLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!identifier || !password) {
      setError('Please fill in all fields');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await login({ usernameOrEmail: identifier, password });
      onLoginSuccess();
      handleClose();
    } catch (err) {
      console.error('Login error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  // Обработчик входа через Discord
  async function handleDiscordLogin() {
    setIsLoading(true);
    setError('');
    await login({ provider: 'discord' });
  }

  // Обработчик входа через Auth0 (временно закомментировано)
  /* async function handleAuth0Login() {
    setIsLoading(true);
    setError('');
    try {
      const authMethods = await pb.collection('users').listAuthMethods();
      const auth0Provider = authMethods.authProviders.find(
        provider => provider.displayName === 'auth0'
      );

      if (!auth0Provider) {
        throw new Error('Auth0 provider not found');
      }

      const redirectUri = 'https://cyoa.cafe/api/oauth2-redirect';
      const authUrl = new URL(auth0Provider.authUrl, window.location.origin);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      window.location.href = authUrl.toString();

    } catch (err) {
      console.error('Full error object:', err);
      const error = err as ErrorResponse;
      const errorMessage = error.response?.data?.message || error.message || 'Login failed';
      setError(`${errorMessage} (${error.status || 'unknown status'})`);
    } finally {
      setIsLoading(false);
    }
  } */

  // Обработчик регистрации
  async function handleRegister(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username || !password) {
      setError('Please fill in all fields');
      return;
    }
    setIsLoading(true);
    setError('');
    try {
      await pb.collection('users').create({
        username,
        password,
        passwordConfirm: password
      });
      onLoginSuccess();
      handleClose();
    } catch (err) {
      console.error('Registration error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  // Эффект для автоматического закрытия при успешной авторизации
  useEffect(() => {
    if (signedIn) handleClose();
  }, [signedIn, handleClose]);

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>{isRegistering ? 'Register' : 'Login'}</DialogTitle>
      <DialogContent>
        {isRegistering ? (
          <form onSubmit={(e) => handleRegister(e)}>
            <TextField
              label="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
              slotProps={{
                input: {
                  style: {
                    backgroundColor: '#1e1e1e',
                    color: '#e0e0e0',
                  },
                },
              }}
            />
            <TextField
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
              slotProps={{
                input: {
                  style: {
                    backgroundColor: '#1e1e1e',
                    color: '#e0e0e0',
                  },
                },
              }}
            />
            <Button
              type="submit"
              color="primary"
              variant="contained"
              fullWidth
              style={{ marginTop: '20px' }}
              disabled={isLoading}
            >
              {isLoading ? <CircularProgress size={24} /> : 'Register'}
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => handleLogin(e)}>
          <TextField
            label="Email or username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            fullWidth
            margin="normal"
            disabled={isLoading}
            required
            slotProps={{
              input: {
                style: {
                  backgroundColor: '#1e1e1e',
                  color: '#e0e0e0',
                },
              },
            }}
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth
            margin="normal"
            disabled={isLoading}
            required
            slotProps={{
              input: {
                style: {
                  backgroundColor: '#1e1e1e',
                  color: '#e0e0e0',
                },
              },
            }}
          />
          <Button
            type="submit"
            color="primary"
            variant="contained"
            fullWidth
            style={{ marginTop: '20px' }}
            disabled={isLoading}
          >
            {isLoading ? <CircularProgress size={24} /> : 'Login'}
          </Button>
          </form>
        )}
        <Divider style={{ margin: '20px 0' }}>
          <Typography variant="body2" color="textSecondary">
            OR
          </Typography>
        </Divider>
        <DiscordButton onClick={handleDiscordLogin} disabled={isLoading} startIcon={<DiscordIcon />}>
          {isLoading ? <CircularProgress size={24} /> : 'Sign in with Discord'}
        </DiscordButton>
        {/* Кнопка Auth0 временно скрыта
        <Auth0Button onClick={handleAuth0Login} disabled={isLoading}>
          {isLoading ? <CircularProgress size={24} /> : 'Continue with Auth0'}
        </Auth0Button> */}
        {error && (
          <Typography color="error" style={{ marginTop: '10px', textAlign: 'center' }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button 
          onClick={() => setIsRegistering(!isRegistering)} 
          color="primary" 
          disabled={isLoading}
        >
          {isRegistering ? 'Back to Login' : 'Register'}
        </Button>
        <Button onClick={handleClose} color="primary" disabled={isLoading}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}
