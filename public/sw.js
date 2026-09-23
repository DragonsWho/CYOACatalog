
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// A stalled visible page must not swallow a push.
const PROBE_MS = 250;

function askClient(client, data) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => finish(Boolean(e.data && e.data.chatOpen && e.data.channel === data.channel && e.data.at >= Date.parse((data.created || '').replace(' ', 'T'))));
      client.postMessage({ type: 'cyoa-chat-probe' }, [ch.port2]);
    } catch {
      finish(false);
    }
    setTimeout(() => finish(false), PROBE_MS);
  });
}

async function chatIsWatched(data) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = list.filter((c) => c.visibilityState === 'visible');
  if (visible.length === 0) return false;
  const answers = await Promise.all(visible.map((client) => askClient(client, data)));
  return answers.some(Boolean);
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'CYOA.CAFE';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) client.postMessage({ ...data, type: 'cyoa-chat-push' });
    return (data.force ? Promise.resolve(false) : chatIsWatched(data)).then((watched) => {
      if (watched) return undefined;
      return self.registration.showNotification(title, {
        body: data.body || '',
        icon: '/web-app-manifest-192x192.png',
        badge: '/badge-96.png',
        tag: data.tag || 'cyoa-chat',
        renotify: true,
        data: { url: data.url || '/', channel: data.channel, created: data.created },
      });
    });
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data?.type !== 'cyoa-chat-read') return;
  event.waitUntil(self.registration.getNotifications().then((items) => {
    for (const item of items) {
      if (item.data?.channel === data.channel && Date.parse((item.data.created || '').replace(' ', 'T')) <= data.at) item.close();
    }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
