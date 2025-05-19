// src/components/Sso/SsoLogoutPage.tsx
import React, { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import { pb } from '../../pocketbase/pocketbase';
import { Container, Typography, Box, CircularProgress } from '@mui/material';

const SsoLogoutPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const returnUrl = queryParams.get('return') || 'https://forum.cyoa.cafe'; // Дефолтный URL

    console.log('SSO Logout Page: Logging out...');

    // 1. Очистить сессию PocketBase
    pb.authStore.clear();
    console.log('SSO Logout Page: PocketBase session cleared.');

    // 2. Очистить cookie Flarum
    Cookies.remove('flarum_token', { domain: '.cyoa.cafe', path: '/' });
    Cookies.remove('flarum_remember', { domain: '.cyoa.cafe', path: '/' }); // На всякий случай
    console.log('SSO Logout Page: Flarum cookies removed.');

    // 3. Перенаправить пользователя обратно на Flarum
    console.log('SSO Logout Page: Redirecting to Flarum:', returnUrl);
    window.location.href = returnUrl;

  }, [location, navigate]); // Зависимости location и navigate (хотя navigate здесь не используется)

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <CircularProgress sx={{ mb: 2 }} />
        <Typography variant="h6">Выход из системы...</Typography>
        <Typography variant="body1">Пожалуйста, подождите, вы будете перенаправлены.</Typography>
      </Box>
    </Container>
  );
};

export default SsoLogoutPage;