// src/components/Sso/SsoLoginPage.tsx
import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Container, Typography, Box, CircularProgress } from '@mui/material';
import Login from '../Header/Login'; // Импортируем ваш существующий компонент Login
import { syncFlarumSession } from '../../utils/sso-utils'; // Путь к вашим SSO утилитам
import { pb } from '../../pocketbase/pocketbase';

const SsoLoginPage: React.FC = () => {
  const location = useLocation(); 
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Извлекаем return_url из параметров URL
  const queryParams = new URLSearchParams(location.search);
  const returnUrl = queryParams.get('return') || 'https://forum.cyoa.cafe'; // Дефолтный URL, если не передан

  const handleLoginSuccess = async () => {
    setIsProcessing(true);
    setMessage('Синхронизация сессии с форумом...');
    console.log('SSO Login Page: PocketBase login successful. Syncing Flarum session...');
    const syncResult = await syncFlarumSession();

    if (syncResult.success) {
      setMessage('Сессия с форумом синхронизирована! Перенаправление...');
      console.log('SSO Login Page: Flarum session synced. Redirecting to:', returnUrl);
    } else {
      setMessage(`Ошибка синхронизации с форумом: ${syncResult.error}. Вы залогинены на сайте. Перенаправление...`);
      console.warn('SSO Login Page: Flarum session sync failed. Error:', syncResult.error, 'Redirecting anyway.');
    }
    
    // Небольшая задержка перед редиректом, чтобы пользователь увидел сообщение
    setTimeout(() => {
      window.location.href = returnUrl;
    }, 2000);
  };

  // Если пользователь уже залогинен в PocketBase при заходе на эту страницу,
  // сразу пытаемся синхронизировать и редиректнуть.
  useEffect(() => {
    if (pb.authStore.isValid) {
      console.log('SSO Login Page: User already logged in PocketBase. Triggering sync.');
      handleLoginSuccess();
    }
  }, []); // Пустой массив зависимостей, чтобы выполнилось один раз при монтировании

  if (isProcessing || pb.authStore.isValid) { // Показываем индикатор/сообщение, если обрабатываем или уже залогинены
    return (
      <Container maxWidth="sm">
        <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <CircularProgress sx={{ mb: 2 }} />
          <Typography variant="h6">{message || 'Обработка входа...'}</Typography>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxWidth="sm">
      <Box sx={{ mt: 8, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5" sx={{ mb: 2 }}>
          Вход для доступа к форуму
        </Typography>
        {/* 
          Используем ваш существующий компонент Login. 
          Ему нужно передать `open={true}` и обработчик `onLoginSuccess`.
          `onClose` здесь, вероятно, не нужен в том же виде, как в модальном окне,
          т.к. это отдельная страница. Можно либо адаптировать Login компонент,
          либо сделать его onClose перенаправляющим на returnUrl без логина.
          Пока что предполагаем, что onLoginSuccess - главный триггер.
        */}
        <Login 
          open={true} // Чтобы он был видим (если он Dialog)
          onClose={() => { // При отмене/закрытии диалога Login (если он так работает)
            console.log('SSO Login Page: Login cancelled/closed. Redirecting to Flarum.');
            window.location.href = returnUrl;
          }}
          onLoginSuccess={handleLoginSuccess}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          После входа вы будете автоматически перенаправлены обратно на форум.
        </Typography>
      </Box>
    </Container>
  );
};

export default SsoLoginPage;