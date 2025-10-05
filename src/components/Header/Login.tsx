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
import { AuthContext, login, pb } from '../../pocketbase/pocketbase'; // Путь к вашему pb
import { syncFlarumSession } from '../../utils/sso-utils'; // <<< НАШ НОВЫЙ ИМПОРТ

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
  error?: string;
}

// Компонент иконки Discord
const DiscordIcon = () => (
  <SvgIcon>
    <path d="M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.01.06.02.09.01 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02zM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12z" />
  </SvgIcon>
);

const OryIcon = () => (
    <SvgIcon viewBox="0 0 24 24">
        <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z" />
    </SvgIcon>
);

const OryButton = styled(Button)(({ theme }) => ({
    backgroundColor: '#000000',
    color: theme.palette.common.white,
    border: '1px solid #555',
    '&:hover': {
      backgroundColor: '#222222',
    },
    width: '70%',
    margin: '10px auto 0 auto', // Добавил отступ сверху
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    padding: '10px',
    borderRadius: '3px',
    fontWeight: 500,
    fontSize: '14px',
    lineHeight: '20px',
    textTransform: 'none',
  }));

const StyledTextField = styled(TextField)(() => ({
  '& .MuiInputBase-input': {
    backgroundColor: '#1e1e1e',
    color: '#e0e0e0',
  },
}));

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

const validateEmail = (email: string) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return 'Invalid email format';
  if (email.length > 255) return 'Email must be less than 255 characters';
  return null;
};

const validatePassword = (password: string) => {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 72) return 'Password must be less than 72 characters';
  if (!/^[\x20-\x7E]+$/.test(password)) return 'Password contains invalid characters';
  return null;
};

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
    setUsername(''); // Очищаем и username/email при закрытии
    setEmail('');
    setError('');
    setIsLoading(false);
    setIsRegistering(false); // Сбрасываем режим регистрации
    setIsResettingPassword(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (isRegistering) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
      return () => { document.body.removeChild(script); };
    }
  }, [isRegistering]);

  async function handlePasswordReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) { setError('Please enter your email'); return; }
    const emailError = validateEmail(email);
    if (emailError) { setError(emailError); return; }

    setIsLoading(true);
    setError('');
    try {
      await pb.collection('users').requestPasswordReset(email);
      setError('Password reset instructions have been sent to your email');
      const timer = setTimeout(() => { handleClose(); }, 3000);
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
    if (!identifier || !password) { setError('Please fill in all fields'); return; }
    setIsLoading(true);
    setError('');
    try {
      await login({ usernameOrEmail: identifier, password });
      
      // --- НАЧАЛО: SSO Интеграция ---
      if (pb.authStore.isValid) {
        console.log('Login.tsx: PocketBase login successful. Attempting Flarum session sync...');
        const syncResult = await syncFlarumSession();
        if (!syncResult.success) {
          console.warn("Login.tsx: Flarum session sync failed after login:", syncResult.error);
          // Можно показать некритичное сообщение об ошибке, например:
          // setError(`Logged in, but Flarum sync failed: ${syncResult.error}. Please try logging into the forum manually.`);
        } else {
          console.log('Login.tsx: Flarum session sync successful after login.');
        }
      }
      // --- КОНЕЦ: SSO Интеграция ---

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
      // `login` с провайдером обычно инициирует редирект.
      // Код после `await login` может не выполниться сразу, если был редирект.
      // PocketBase SDK обработает коллбэк от Discord при возвращении пользователя.
      await login({ provider: 'discord' });

      // Этот блок выполнится, если login не сделал редирект или после возврата,
      // и pb.authStore.isValid уже true.
      // Более надежно было бы вызывать syncFlarumSession в useEffect, который слушает pb.authStore.isValid,
      // но только если изменение состояния было результатом логина, а не просто обновления токена.
      // Пока оставляем так, как основной механизм - useEffect[signedIn] в App.tsx для закрытия диалога.
      // Мы можем перенести логику синхронизации в AuthContext или в useEffect в App.tsx
      // который срабатывает при изменении pb.authStore.isValid с false на true.
      // Для простоты, сейчас делаем так:
      if (pb.authStore.isValid) { 
        console.log('Login.tsx: Discord login process resulted in valid session. Attempting Flarum session sync...');
        const syncResult = await syncFlarumSession();
        if (!syncResult.success) {
          console.warn("Login.tsx: Flarum session sync failed after Discord login:", syncResult.error);
        } else {
          console.log('Login.tsx: Flarum session sync successful after Discord login.');
        }
      }
      // onLoginSuccess(); // Обычно вызывается через AuthContext и useEffect[signedIn]
      // handleClose();    // Также
    } catch (err) {
      console.error('Discord login error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Discord login failed');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOryLogin() {
    setIsLoading(true);
    setError('');
    try {
      // Шаг 1: Получаем список всех доступных провайдеров
      const providers = await pb.collection('users').listAuthMethods();

      // Шаг 2: Находим наш провайдер с именем 'ory'
      const oryProvider = providers.authProviders.find(p => p.name === 'ory');

      if (!oryProvider) {
        throw new Error("Ory auth provider not found. Please check PocketBase admin settings.");
      }

      // Шаг 3: Сохраняем 'codeVerifier' в локальное хранилище.
      // PocketBase SDK сделает это сам при вызове authWithOAuth2, но так как мы
      // делаем редирект вручную, нам нужно сделать это самим.
      localStorage.setItem('provider', JSON.stringify({
        ...oryProvider,
        // Мы добавляем наш redirect_uri. PocketBase SDK будет его использовать на следующем шаге.
        redirectUrl: 'https://cyoa.cafe/api/oauth2-redirect',
      }));

      // Шаг 4: Формируем правильный URL для редиректа, добавляя недостающий параметр.
      const redirectUrl = encodeURIComponent('https://cyoa.cafe/api/oauth2-redirect');
      const authUrlWithRedirect = `${oryProvider.authUrl}${redirectUrl}`;

      // Шаг 5: Перенаправляем пользователя на этот URL.
      window.location.href = authUrlWithRedirect;

    } catch (err) {
      console.error('Ory login error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Ory/SSO login failed');
      // Очищаем хранилище в случае ошибки
      localStorage.removeItem('provider');
    } finally {
      // Мы не выключаем isLoading, так как страница все равно будет перезагружена
      // setIsLoading(false);
    }
  }


  async function handleRegister(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username || !email || !password) { setError('Please fill in all fields'); return; }
    const emailError = validateEmail(email); if (emailError) { setError(emailError); return; }
    const passwordError = validatePassword(password); if (passwordError) { setError(passwordError); return; }
    const formData = new FormData(e.currentTarget);
    const turnstileToken = formData.get('cf-turnstile-response') as string;
    if (!turnstileToken) { setError('Please complete the verification'); return; }

    setIsLoading(true);
    setError('');
    try {
      const verifyResponse = await fetch('/api/custom/verify-turnstile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: turnstileToken }),
      });
      if (!verifyResponse.ok) {
        const errorData: TurnstileResponse = await verifyResponse.json();
        setError(errorData.error || 'Verification failed. Are you a bot?');
        setIsLoading(false); return;
      }

      await pb.collection('users').create({
        username, email, password, passwordConfirm: password, emailVisibility: true,
      });
      await pb.collection('users').requestVerification(email);

      setError('Please check your email to verify your account. You can now log in.');
      // Не закрываем диалог и не логиним автоматически.
      // Пользователь должен будет сам залогиниться, и тогда сработает syncFlarumSession из handleLogin.
      const timer = setTimeout(() => {
        setIsRegistering(false); // Переключаем на форму логина
        setError(''); // Очищаем сообщение о верификации
      }, 5000);
      return () => clearTimeout(timer);
    } catch (err) {
      console.error('Registration error:', err);
      const error = err as ErrorResponse;
      setError(error.response?.data?.message || error.message || 'Registration failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }

  // Этот useEffect закроет диалог, если пользователь успешно залогинился
  // (например, через OAuth, когда он возвращается на сайт и pb.authStore обновляется)
  useEffect(() => {
    if (signedIn) {
        // Если пользователь залогинился (например, через OAuth) И ЕЩЕ НЕ БЫЛО ПОПЫТКИ СИНХРОНИЗАЦИИ
        // (нужен флаг, чтобы избежать повторных вызовов), то можно вызвать syncFlarumSession здесь.
        // Однако, если `handleDiscordLogin` успешно вызывает syncFlarumSession, то здесь это может быть излишне.
        // Для простоты, пока основной вызов sync для OAuth остается в handleDiscordLogin.
        // Если pb.authStore.isValid становится true из-за другого механизма (например, обновление токена),
        // нам не нужна синхронизация. Только при первичном логине.
        handleClose();
    }
  }, [signedIn, handleClose]);

  return (
    <Dialog open={open} onClose={handleClose} PaperProps={{sx: {backgroundImage: 'none' }}}> {/* Добавил PaperProps для консистентности с другими Dialog */}
      <DialogTitle sx={{ textAlign: 'center' }}>
        {isResettingPassword ? 'Reset Password' : isRegistering ? 'Register' : 'Login'}
      </DialogTitle>
      <DialogContent>
        {isResettingPassword ? (
          <form onSubmit={handlePasswordReset}>
            <StyledTextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <Button type="submit" color="primary" variant="contained" fullWidth style={{ marginTop: '20px' }} disabled={isLoading}>
              {isLoading ? <CircularProgress size={24} /> : 'Reset Password'}
            </Button>
          </form>
        ) : isRegistering ? (
          <form onSubmit={handleRegister}>
            <StyledTextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <StyledTextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <StyledTextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <div className="cf-turnstile" data-sitekey={import.meta.env.VITE_TURNSTILE_SITE_KEY || "0x4AAAAAAA9kgpL5L0h777U9"} style={{ marginTop: '20px', display: 'flex', justifyContent: 'center' }} />
            <Button type="submit" color="primary" variant="contained" fullWidth style={{ marginTop: '20px' }} disabled={isLoading}>
              {isLoading ? <CircularProgress size={24} /> : 'Register'}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleLogin}>
            <StyledTextField label="Email or username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <StyledTextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} fullWidth margin="normal" disabled={isLoading} required />
            <Button type="submit" color="primary" variant="contained" fullWidth style={{ marginTop: '20px' }} disabled={isLoading}>
              {isLoading ? <CircularProgress size={24} /> : 'Login'}
            </Button>
            <Button color="secondary" fullWidth style={{ marginTop: '10px' }} onClick={() => { setIsResettingPassword(true); setEmail(identifier.includes('@') ? identifier : ''); /* Предзаполняем email если он в identifier */ }} disabled={isLoading}>
              Forgot password?
            </Button>
          </form>
        )}
        {!isResettingPassword && ( // Не показываем "OR" и кнопку Discord при сбросе пароля
          <>
            <Divider style={{ margin: '20px 0' }}>
              <Typography variant="body2" color="textSecondary">OR</Typography>
            </Divider>
            <DiscordButton onClick={handleDiscordLogin} disabled={isLoading} startIcon={<DiscordIcon />}>
              {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Sign in with Discord'}
            </DiscordButton>
            <OryButton onClick={handleOryLogin} disabled={isLoading} startIcon={<OryIcon />}>
                {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Sign in with SSO'}
            </OryButton>
          </>
        )}
        {error && (
          <Typography color="error" style={{ marginTop: '20px', textAlign: 'center' }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {isResettingPassword ? (
          <Button onClick={() => { setIsResettingPassword(false); setError(''); }} color="primary" disabled={isLoading}>Back to Login</Button>
        ) : (
          <Button onClick={() => { setIsRegistering(!isRegistering); setError(''); setUsername(''); setEmail(''); setPassword(''); /* Очищаем поля при переключении */ }} color="primary" disabled={isLoading}>
            {isRegistering ? 'Back to Login' : 'Register'}
          </Button>
        )}
        <Button onClick={handleClose} color="primary" disabled={isLoading}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}