// src/components/Sso/SsoSignupPage.tsx
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress } from '@mui/material';
import Login from '../Header/Login'; // Используем тот же Login компонент, он умеет переключаться в режим регистрации
import { syncFlarumSession } from '../../utils/sso-utils';
import { pb } from '../../pocketbase/pocketbase';

const SsoSignupPage: React.FC = () => {
  const location = useLocation(); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const queryParams = new URLSearchParams(location.search);
  const returnUrl = queryParams.get('return') || 'https://forum.cyoa.cafe';

  // Эта функция будет вызвана после успешной *регистрации* и последующего логина (если ваш компонент Login так делает)
  // или просто после успешной регистрации, если Login компонент не логинит автоматически.
  // Важно, чтобы pb.authStore.isValid стал true.
  const handleSignupSuccess = async () => {
    setIsProcessing(true);
    setMessage('Синхронизация сессии с форумом...');
    console.log('SSO Signup Page: PocketBase signup/login successful. Syncing Flarum session...');
    const syncResult = await syncFlarumSession();

    if (syncResult.success) {
      setMessage('Сессия с форумом синхронизирована! Перенаправление...');
      console.log('SSO Signup Page: Flarum session synced. Redirecting to:', returnUrl);
    } else {
      setMessage(`Ошибка синхронизации с форумом: ${syncResult.error}. Вы зарегистрированы/залогинены на сайте. Перенаправление...`);
      console.warn('SSO Signup Page: Flarum session sync failed. Error:', syncResult.error, 'Redirecting anyway.');
    }
    
    setTimeout(() => {
      window.location.href = returnUrl;
    }, 2000);
  };

  // Если пользователь уже залогинен в PocketBase
  useEffect(() => {
    if (pb.authStore.isValid) {
      console.log('SSO Signup Page: User already logged in PocketBase. Triggering sync.');
      handleSignupSuccess(); // Может быть, пользователь попал сюда, будучи уже залогиненным
    }
  }, []);


  if (isProcessing || pb.authStore.isValid) {
    return (
      <Container maxWidth="sm">
        <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="h6">{message || 'Обработка регистрации...'}</Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5" sx={{ mb: 2 }}>
          Регистрация для доступа к форуму
        </Typography>
        {/* 
          Передаем isRegistering={true} если ваш Login компонент может принимать такой проп 
          для отображения формы регистрации по умолчанию.
          Если нет, пользователю придется самому кликнуть "Register" в вашем Login компоненте.
          onLoginSuccess здесь будет означать успех регистрации (и, возможно, автоматического логина).
        */}
        <Login
          open={true} 
          // Тут нужен способ сказать компоненту Login, чтобы он открыл вкладку регистрации.
          // Если ваш компонент Login это диалог, который сам управляет состоянием isRegistering,
          // то этот проп может не понадобиться, пользователь сам выберет.
          // Для примера, предположим, что ваш Login компонент при `onLoginSuccess`
          // вызывается и после успешной регистрации (когда пользователь становится pb.authStore.isValid).
          onClose={() => {
            console.log('SSO Signup Page: Signup cancelled/closed. Redirecting to Flarum.');
            window.location.href = returnUrl;
          }}
          onLoginSuccess={handleSignupSuccess} // Используем тот же обработчик, т.к. после регистрации ожидается логин
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          После регистрации вы будете автоматически перенаправлены обратно на форум.
        </Typography>
      </Box>
    </Container>
  );
};

export default SsoSignupPage;