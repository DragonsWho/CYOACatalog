// Service worker: только веб-пуши. Офлайн-кэша здесь НЕТ намеренно — кэшировать
// SPA-оболочку значит обещать «работает офлайн», а каталог без сети всё равно
// пустой. Появится нужда — отдельным заходом и с версионированием кэша.
//
// Регистрируется из src/push/pushClient.ts. Живёт в public/ (vite копирует как
// есть), чтобы лежать в корне сайта: SW видит только свою область видимости,
// и из /assets/ он бы не покрывал весь сайт.

self.addEventListener('install', () => {
  // Не ждём закрытия старых вкладок: сидеть на прошлой версии SW ради чата не за что.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Бэкенд шлёт {title, body, url, tag}. Битое/пустое тело не роняем: пуш без
  // показанной нотификации браузер считает нарушением и грозит отписать.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'CYOA.CAFE';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/web-app-manifest-192x192.png',
      badge: '/favicon-96x96.png',
      // tag схлопывает серию сообщений в одну строчку вместо стопки одинаковых.
      tag: data.tag || 'cyoa-chat',
      renotify: false,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    // Уже открытая вкладка сайта — переиспользуем, а не плодим копии: у человека
    // и так чат где-то открыт, вторая вкладка того же чата только мешает.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(self.location.origin)) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
