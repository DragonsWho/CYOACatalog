// src/utils/sso-utils.ts
import Cookies from 'js-cookie';
import { pb } from '../pocketbase/pocketbase'; // Убедитесь, что путь к вашему инстансу pb правильный

// Функция для получения специального Flarum SSO токена с вашего бэкенда
async function getFlarumSsoToken(): Promise<string | null> {
  if (!pb.authStore.isValid || !pb.authStore.token) {
    console.warn('SSO: User not authenticated in PocketBase to get Flarum SSO token.');
    return null;
  }

  try {
    // URL к вашему кастомному эндпоинту.
    // Если ваше React приложение и PocketBase бэкенд на одном домене,
    // относительный путь /api/custom/sso/flarum-token должен работать.
    // Если они на разных доменах (например, в разработке на разных портах),
    // вам может понадобиться полный URL: `${import.meta.env.VITE_POCKETBASE_URL}/api/custom/sso/flarum-token`
    // или аналогичный способ получения базового URL вашего API.
    // Пока что используем относительный путь.
    const apiUrl = '/api/custom/sso/flarum-token'; 
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${pb.authStore.token}`, // Используем стандартный PB токен
      },
    });

    if (!response.ok) {
      let errorData: any = {};
      try {
        errorData = await response.json();
      } catch (e) {
        // Если тело ответа не JSON, или пустое
        console.error('SSO: Failed to parse error response from getFlarumSsoToken as JSON');
      }
      const errorMessage = errorData?.message || `Failed to get Flarum SSO token from backend. Status: ${response.status}`;
      console.error(`SSO: ${errorMessage}`, errorData);
      return null;
    }

    const data = await response.json();
    if (!data.flarum_sso_token) {
        console.warn('SSO: flarum_sso_token not found in backend response.', data);
        return null;
    }
    return data.flarum_sso_token;

  } catch (err) {
    console.error('SSO: Network or other error during Flarum SSO token fetch:', err);
    return null;
  }
}

export async function syncFlarumSession(): Promise<{ success: boolean; error?: string }> {
  console.log('SSO: Attempting to sync Flarum session...');
  const flarumSsoToken = await getFlarumSsoToken();

  if (!flarumSsoToken) {
    const errorMessage = 'Failed to obtain Flarum SSO token for Flarum API.';
    console.warn(`SSO: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }

  console.log('SSO: Flarum SSO token obtained, sending to Flarum API.');

  try {
    const flarumApiUrl = 'https://forum.cyoa.cafe/api/sso/jwt'; // URL вашего Flarum API

    const flarumApiResponse = await fetch(flarumApiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${flarumSsoToken}`, // Используем специальный Flarum SSO токен
        'Accept': 'application/json',
      },
    });

    if (!flarumApiResponse.ok) {
      let errorData: any = {};
      try {
        errorData = await flarumApiResponse.json();
      } catch (e) {
        console.error('SSO: Failed to parse error response from Flarum API as JSON');
      }
      const errorMessage = errorData?.message || `Flarum API request failed. Status: ${flarumApiResponse.status}`;
      console.warn('SSO: Flarum API Sync Error:', errorMessage, errorData);
      return { success: false, error: errorMessage };
    }

    const flarumData = await flarumApiResponse.json();

    if (!flarumData.token) {
      console.warn('SSO: Flarum session token (flarumData.token) not received from Flarum API.', flarumData);
      return { success: false, error: 'Flarum session token not received from Flarum API.' };
    }

    // Убедитесь, что VITE_NODE_ENV устанавливается в 'production' для сборки
    // или просто используйте true для secure cookie, если сайт всегда на HTTPS
    const isProduction = true;  

    Cookies.set('flarum_token', flarumData.token, {
      domain: '.cyoa.cafe', // Важно: точка в начале для поддоменов
      path: '/',
      secure: isProduction, 
      sameSite: 'Lax', // 'Lax' или 'None' (если 'None', то secure: true обязательно)
      // expires: 7, // Опционально: время жизни cookie в днях, если нужно
    });

    console.log('SSO: Flarum session synchronized successfully. Flarum token cookie set.');
    return { success: true };

  } catch (err: any) {
    console.error('SSO: Network or other error during Flarum session synchronization with Flarum API:', err);
    return { success: false, error: err.message || 'Unknown error during Flarum API sync.' };
  }
}