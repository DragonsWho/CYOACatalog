// src/components/Header/Login.tsx
import React, { useState, useEffect, useContext, useRef, useCallback } from 'react';
import {  Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  Button,
  CircularProgress,
  Divider,
  Typography,
  Box,
  Alert,
  IconButton,
  InputAdornment,
  Link,
  alpha,
  useTheme,
  Fade,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import TextField from '@mui/material/TextField';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import { ClientResponseError, AuthProviderInfo } from 'pocketbase';

import { AuthContext, pb } from '../../pocketbase/pocketbase';
import { ForcedAuthMode } from './Header';
import { SocialButton, getSocialProviderConfig } from './social/SocialButton';
import { EMAIL_VERIFICATION_PROMPT_QUERY, EMAIL_VERIFICATION_PROMPT_VALUE } from './EmailVerificationPrompt';

// --- CONSTANTS ---------------------------------------------------------------
const HOME_URL = 'https://cyoa.cafe/';
const EMAIL_VERIFICATION_PROMPT_URL = `${HOME_URL}?${EMAIL_VERIFICATION_PROMPT_QUERY}=${EMAIL_VERIFICATION_PROMPT_VALUE}`;

// --- Styled components -------------------------------------------------------
const StyledDialog = styled(Dialog)(() => ({
  '& .MuiBackdrop-root': {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(5px)',
  },
  '& .MuiDialog-paper': {
    backgroundImage: 'none',
    backgroundColor: '#181818',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.05)',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8)',
    maxWidth: 400,
    width: '100%',
    minHeight: '580px',
    maxHeight: '90vh',
    overflow: 'hidden',
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
  },
}));

const HeaderTab = styled(Button, {
  shouldForwardProp: (prop) => prop !== 'active',
})<{ active?: boolean }>(({ theme, active }) => ({
  flex: 1,
  height: '64px',
  borderRadius: 0,
  textTransform: 'uppercase',
  fontWeight: active ? 700 : 500,
  fontSize: '0.85rem',
  letterSpacing: '1px',
  color: active ? '#fff' : '#666',
  backgroundColor: active ? '#181818' : '#101010',
  borderBottom: active ? 'none' : '1px solid rgba(255,255,255,0.05)',
  borderTop: active
    ? `3px solid ${theme.palette.primary.main}`
    : '3px solid transparent',
  transition: 'background-color 0.2s ease, color 0.2s ease',
  '&:hover': {
    backgroundColor: active ? '#181818' : '#151515',
    color: '#fff',
  },
}));

const TabsContainer = styled(Box)({
  display: 'flex',
  width: '100%',
  flexDirection: 'row',
  flexShrink: 0,
});

const StyledTextField = styled(TextField)(({ theme }) => ({
  '& .MuiOutlinedInput-root': {
    backgroundColor: '#252525',
    borderRadius: 8,
    transition: 'all 0.2s ease-in-out',
    '& fieldset': { borderColor: 'transparent' },
    '&:hover': { backgroundColor: '#2a2a2a' },
    '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.1)' },
    '&.Mui-focused': {
      backgroundColor: '#2a2a2a',
      boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.25)}`,
    },
    '&.Mui-focused fieldset': {
      borderColor: theme.palette.primary.main,
      borderWidth: 1,
    },
  },
  '& .MuiInputBase-input': {
    color: '#fff',
    padding: '15px 16px',
    fontWeight: 500,
  },
  '& .MuiInputLabel-root': {
    color: '#888',
    transform: 'translate(14px, 16px) scale(1)',
  },
  '& .MuiInputLabel-root.Mui-focused, & .MuiInputLabel-root.MuiFormLabel-filled': {
    transform: 'translate(14px, -9px) scale(0.75)',
    color: theme.palette.primary.main,
    backgroundColor: '#181818',
    padding: '0 6px',
    borderRadius: 4,
  },
  '& .MuiIconButton-root': {
    color: '#666',
    '&:hover': { color: '#fff' },
  },
  '& input[type="password"]::-ms-reveal, & input[type="password"]::-ms-clear': {
    display: 'none',
  },
}));

// -----------------------------------------------------------------------------

type AuthMode = 'login' | 'register-email' | 'register-anon';

const MODE_BUTTONS: Array<{ key: AuthMode; label: string }> =[
  { key: 'login', label: 'Log In' },
  { key: 'register-email', label: 'Sign Up' },
  { key: 'register-anon', label: 'Anon' },
];

interface LoginProps {
  open?: boolean;
  onClose?: () => void;
  onLoginSuccess?: () => void;
  forcedMode?: ForcedAuthMode;
}

export default function LoginDialog({
  open = false,
  onClose = () => {},
  onLoginSuccess = () => {},
  forcedMode = null,
}: LoginProps) {
  const theme = useTheme();
  const { signedIn } = useContext(AuthContext);
  const navigate = useNavigate();

  const[mode, setMode] = useState<AuthMode>('login');
  const [isLoading, setIsLoading] = useState(false);
  const [authProviders, setAuthProviders] = useState<AuthProviderInfo[]>([]);

  // Формы ввода
  const [identifier, setIdentifier] = useState(''); // Для логина (Email/Username)
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');

  const [showPassword, setShowPassword] = useState(false);
  const[showConfirmPassword, setShowConfirmPassword] = useState(false);

  // Ошибки
  const[generalError, setGeneralError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; },[]);

  const safeSet = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    if (mountedRef.current) setter(value);
  },[]);

  useEffect(() => { if (forcedMode) setMode(forcedMode); }, [forcedMode]);

  useEffect(() => {
    if (open && !authProviders.length) {
      pb.collection('users').listAuthMethods().then(methods => {
        // По актуальной доке провайдеры лежат тут:
        const providers = methods.oauth2?.providers ||[];
        safeSet(setAuthProviders, providers);
      }).catch(console.error);
    }
  },[open, authProviders.length, safeSet]);

  useEffect(() => { if (signedIn && open) handleClose(); }, [signedIn, open]);

  // Сброс формы при смене вкладки
  useEffect(() => {
    setGeneralError(null);
    setFieldErrors({});
    setPassword('');
    setPasswordConfirm('');
    setShowPassword(false);
    setShowConfirmPassword(false);
  }, [mode]);

  const handleClose = () => {
    setIdentifier('');
    setEmail('');
    setUsername('');
    setPassword('');
    setPasswordConfirm('');
    setGeneralError(null);
    setFieldErrors({});
    onClose();
  };

  const extractPbErrors = (err: unknown) => {
    if (err instanceof ClientResponseError && err.response?.data) {
      const errors: Record<string, string> = {};
      Object.keys(err.response.data).forEach(key => {
        errors[key] = err.response.data[key].message;
      });
      setFieldErrors(errors);
      setGeneralError(err.response?.message || 'An error occurred.');
    } else if (err instanceof Error) {
      setGeneralError(err.message);
    } else {
      setGeneralError('Unexpected error occurred.');
    }
  };

  const handleLoginSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    safeSet(setIsLoading, true);
    setGeneralError(null);
    setFieldErrors({});

    try {
      await pb.collection('users').authWithPassword(identifier, password, { expand: 'blocked_tags' });
      onLoginSuccess();
      handleClose();
    } catch (error: unknown) {
      extractPbErrors(error);
    } finally {
      safeSet(setIsLoading, false);
    }
  };

  const handleRegistrationSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    safeSet(setIsLoading, true);
    setGeneralError(null);
    setFieldErrors({});

    if (password !== passwordConfirm) {
      setFieldErrors({ passwordConfirm: 'Passwords do not match.' });
      safeSet(setIsLoading, false);
      return;
    }

    try {
      const isAnon = mode === 'register-anon';
      const userData = isAnon
        ? { username, password, passwordConfirm, name: username }
        : { email, username, password, passwordConfirm, name: username };

      // 1. Создаем пользователя
      await pb.collection('users').create(userData);

      // 2. Сразу логиним его
      await pb.collection('users').authWithPassword(username, password, { expand: 'blocked_tags' });

      // 3. Если это email-регистрация, отправляем письмо для верификации
      if (!isAnon && email) {
        try {
          await pb.collection('users').requestVerification(email);
          window.location.href = EMAIL_VERIFICATION_PROMPT_URL;
          return;
        } catch (verifErr) {
          console.error("Verification email failed to send:", verifErr);
        }
      }

      onLoginSuccess();
      handleClose();
    } catch (error: unknown) {
      extractPbErrors(error);
    } finally {
      safeSet(setIsLoading, false);
    }
  };

  const handleOAuth2Login = async (provider: AuthProviderInfo) => {
    safeSet(setIsLoading, true);
    setGeneralError(null);
    try {
      await pb.collection('users').authWithOAuth2({ 
        provider: provider.name,
        expand: 'blocked_tags'
      });
      onLoginSuccess();
      handleClose();
    } catch (error: unknown) {
      // Игнорируем ошибку, если пользователь сам закрыл попап OAuth2
      if (error instanceof ClientResponseError && error.isAbort) {
        return;
      }
      setGeneralError('OAuth2 login failed or was cancelled.');
    } finally {
      safeSet(setIsLoading, false);
    }
  };

  const renderContent = () => {
    const formSx = { display: 'flex', flexDirection: 'column', flex: 1, pt: 1 };

    if (mode === 'login') {
      return (
        <Fade in={true} timeout={300}>
          <Box component="form" onSubmit={handleLoginSubmit} sx={formSx}>
            <StyledTextField
              label="Email / Username"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              fullWidth required sx={{ mb: 2 }} disabled={isLoading}
              error={!!fieldErrors.identity}
              helperText={fieldErrors.identity}
            />
            <StyledTextField
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth required sx={{ mb: 2 }} disabled={isLoading}
              error={!!fieldErrors.password}
              helperText={fieldErrors.password}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" disabled={isLoading}>
                      {showPassword ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                )
              }}
            />

            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: -1.5, mb: 0 }}>
              <Link component="button" type="button" onClick={() => navigate('/recovery')} disabled={isLoading} sx={{ color: '#888', fontSize: '0.8rem', textDecoration: 'none', '&:hover': { color: theme.palette.primary.main } }}>
                Forgot password?
              </Link>
            </Box>

            <Button type="submit" variant="contained" color="primary" fullWidth disabled={isLoading}
              sx={{ mt: 2, borderRadius: 2, py: 1.2, fontWeight: 700, textTransform: 'uppercase', fontSize: '0.9rem', boxShadow: 'none' }}>
              {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Log In'}
            </Button>

            {authProviders.length > 0 && (
              <>
                <Divider sx={{ my: 2, borderColor: 'rgba(255,255,255,0.05)' }}>
                  <Typography variant="caption" color="text.disabled">OR</Typography>
                </Divider>
                {authProviders.map((provider) => {
                  const config = getSocialProviderConfig(provider.name);
                  return (
                    <Box key={provider.name} sx={{ width: '100%', mb: 1.5 }}>
                      <SocialButton
                        type="button"
                        label={config.label}
                        icon={config.icon}
                        loading={isLoading}
                        onClick={() => handleOAuth2Login(provider)}
                        fullWidth
                      />
                    </Box>
                  );
                })}
              </>
            )}

            {generalError && (
              <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>{generalError}</Alert>
            )}
          </Box>
        </Fade>
      );
    }

    // Регистрация (Email или Anon)
    return (
      <Fade in={true} timeout={300}>
        <Box component="form" onSubmit={handleRegistrationSubmit} sx={formSx}>
          {mode === 'register-email' && (
            <StyledTextField
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              fullWidth required sx={{ mb: 2 }} disabled={isLoading}
              error={!!fieldErrors.email}
              helperText={fieldErrors.email}
            />
          )}

          <StyledTextField
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            fullWidth required sx={{ mb: 2 }} disabled={isLoading}
            error={!!fieldErrors.username}
            helperText={fieldErrors.username}
          />

          <StyledTextField
            label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            fullWidth required sx={{ mb: 2 }} disabled={isLoading}
            error={!!fieldErrors.password}
            helperText={fieldErrors.password}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowPassword(!showPassword)} edge="end" disabled={isLoading}>
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              )
            }}
          />

          <StyledTextField
            label="Confirm Password"
            type={showConfirmPassword ? 'text' : 'password'}
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            fullWidth required sx={{ mb: 2 }} disabled={isLoading}
            error={!!fieldErrors.passwordConfirm}
            helperText={fieldErrors.passwordConfirm}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton onClick={() => setShowConfirmPassword(!showConfirmPassword)} edge="end" disabled={isLoading}>
                    {showConfirmPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              )
            }}
          />

          {mode === 'register-anon' && (
            <Alert severity="warning" sx={{ mb: 2, height: '54px', display: 'flex', alignItems: 'center', backgroundColor: 'rgba(255, 167, 38, 0.08)', color: '#ffcc80', border: '1px solid rgba(255, 167, 38, 0.2)', overflow: 'hidden' }}>
              Recovery impossible if credentials lost.
            </Alert>
          )}

          <Button type="submit" variant="contained" color="primary" fullWidth disabled={isLoading}
            sx={{ mt: 2, mb: 1, borderRadius: 2, py: 1.2, fontWeight: 700, textTransform: 'uppercase', fontSize: '0.9rem', boxShadow: 'none' }}>
            {isLoading ? <CircularProgress size={24} color="inherit" /> : 'Create Account'}
          </Button>

          {generalError && (
            <Alert severity="error" sx={{ mt: 2, borderRadius: 2 }}>{generalError}</Alert>
          )}
        </Box>
      </Fade>
    );
  };

  return (
    <StyledDialog open={open} onClose={handleClose} scroll="paper">
      <TabsContainer>
        {MODE_BUTTONS.map(({ key, label }) => (
          <HeaderTab key={key} onClick={() => setMode(key)} active={mode === key} disabled={isLoading}>
            {label}
          </HeaderTab>
        ))}
      </TabsContainer>

      <DialogContent sx={{ px: 4, pt: 2.5, pb: 1, display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>
        {renderContent()}

        <Box sx={{ mt: 'auto', pt: 1, display: 'flex', justifyContent: 'center', gap: 2, opacity: 0.3, flexShrink: 0 }}>
          <Link component={RouterLink} to="/privacy-policy" target="_blank" sx={{ fontSize: '0.7rem', color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>Privacy Policy</Link>
          <Link component={RouterLink} to="/terms-of-service" target="_blank" sx={{ fontSize: '0.7rem', color: 'inherit', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>Terms</Link>
        </Box>
      </DialogContent>
    </StyledDialog>
  );
}