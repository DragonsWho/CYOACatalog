import { FormEvent, useCallback, useContext, useEffect, useState } from 'react';
import {
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
  CircularProgress,
  TextField,
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

// Интерфейс для ответа Turnstile
interface TurnstileResponse {
  success: boolean;
  error?: string; // Добавлено для обработки ошибок от эндпоинта
}

// Компонент иконки Discord
const DiscordIcon = () => (
  <SvgIcon>
    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z" />
  </SvgIcon>
);

// Стили для текстовых полей
const StyledTextField = styled(TextField)(() => ({
  '& .MuiInputBase-input': {
    backgroundColor: '#1e1e1e',
    color: '#e0e0e0',
  },
}));

// Стили для кнопки Discord
const DiscordButton = styled(Button)(({ theme }) => ({
  backgroundColor: theme.palette.discord.main,
  color: theme.palette.common.white,
  '&:hover': {
    backgroundColor: theme.palette.discord.dark,
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

// Валидация email
const validateEmail = (email: string) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return 'Invalid email format';
  }
  if (email.length > 255) {
    return 'Email must be less than 255 characters';
  }
  return null;
};

// Валидация пароля
const validatePassword = (password: string) => {
  if (password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 72) {
    return 'Password must be less than 72 characters';
  }
  if (!/^[\x20-\x7E]+$/.test(password)) {
    return 'Password contains invalid characters';
  }
  return null;
};

// Основной компонент Login
interface LoginProps {
  open?: boolean;
  onClose?: () => void;
  onLoginSuccess?: () => void;
}

export default function Login({ open = false, onClose = () => {}, onLoginSuccess = () => {} }: LoginProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const { signedIn } = useContext(AuthContext);

  const handleClose = useCallback(() => {
    setIdentifier('');
    setPassword('');
    setError('');
    setIsLoading(false);
    setIsResettingPassword(false);
    onClose();
  }, [onClose]);

  // Динамическая загрузка Turnstile скрипта
  useEffect(() => {
    if (isRegistering) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);

      return () => {
        document.body.removeChild(script);
      };
    }
  }, [isRegistering]);

  async function handlePasswordReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) {
      setError('Please enter your email');
      return;
    }

    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }

    setIsLoading(true);
    setError('');
    try {
      await pb.collection('users').requestPasswordReset(email);
      setError('Password reset instructions have been sent to your email');
      const timer = setTimeout(() => {
        handleClose();
      }, 3000);
      return () => clearTimeout(timer);
    } catch (err) {
      console.error('Password reset error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Password reset failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

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

  async function handleDiscordLogin() {
    setIsLoading(true);
    setError('');
    try {
      await login({ provider: 'discord' });
    } catch (err) {
      console.error('Discord login error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Discord login failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRegister(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (!username || !email || !password) {
      setError('Please fill in all fields');
      return;
    }

    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    const formData = new FormData(e.currentTarget);
    const turnstileToken = formData.get('cf-turnstile-response') as string;

    if (!turnstileToken) {
      setError('Please complete the verification');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      // Проверка токена через эндпоинт PocketBase
      const verifyResponse = await fetch('/api/custom/verify-turnstile', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          token: turnstileToken,
        }),
      });

      if (!verifyResponse.ok) {
        const errorData: TurnstileResponse = await verifyResponse.json(); // Используем TurnstileResponse для типизации
        setError(errorData.error || 'Verification failed. Are you a bot?');
        setIsLoading(false);
        return;
      }

      // Если токен валиден, продолжаем регистрацию
      await pb.collection('users').create({
        username,
        email,
        password,
        passwordConfirm: password,
        emailVisibility: true,
      });

      await pb.collection('users').requestVerification(email);

      setError('Please check your email to verify your account');
      const timer = setTimeout(() => {
        handleClose();
      }, 3000);
      return () => clearTimeout(timer);
    } catch (err) {
      console.error('Registration error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (signedIn) handleClose();
  }, [signedIn, handleClose]);

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>
        {isResettingPassword ? 'Reset Password' : isRegistering ? 'Register' : 'Login'}
      </DialogTitle>
      <DialogContent>
        {isResettingPassword ? (
          <form onSubmit={(e) => handlePasswordReset(e)}>
            <StyledTextField
              label="Email"
              type="email"
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
            />
            <Button
              type="submit"
              color="primary"
              variant="contained"
              fullWidth
              style={{ marginTop: '20px' }}
              disabled={isLoading}
            >
              {isLoading ? <CircularProgress size={24} /> : 'Reset Password'}
            </Button>
          </form>
        ) : isRegistering ? (
          <form onSubmit={(e) => handleRegister(e)}>
            <StyledTextField
              label="Username"
              value={username}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUsername(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
            />
            <StyledTextField
              label="Email"
              type="email"
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
            />
            <StyledTextField
              label="Password"
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
            />
            <div
              className="cf-turnstile"
              data-sitekey="0x4AAAAAAA9kgpL5L0h777U9"  
              style={{ marginTop: '20px', display: 'flex', justifyContent: 'center' }}
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
            <StyledTextField
              label="Email or username"
              value={identifier}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setIdentifier(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
            />
            <StyledTextField
              label="Password"
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              fullWidth
              margin="normal"
              disabled={isLoading}
              required
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
            <Button
              color="secondary"
              fullWidth
              style={{ marginTop: '10px' }}
              onClick={() => setIsResettingPassword(true)}
              disabled={isLoading}
            >
              Forgot password?
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
        {error && (
          <Typography color="error" style={{ marginTop: '10px', textAlign: 'center' }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {isResettingPassword ? (
          <Button
            onClick={() => setIsResettingPassword(false)}
            color="primary"
            disabled={isLoading}
          >
            Back to Login
          </Button>
        ) : (
          <Button
            onClick={() => setIsRegistering(!isRegistering)}
            color="primary"
            disabled={isLoading}
          >
            {isRegistering ? 'Back to Login' : 'Register'}
          </Button>
        )}
        <Button onClick={handleClose} color="primary" disabled={isLoading}>
          Cancel
        </Button>
      </DialogActions>
    </Dialog>
  );
}