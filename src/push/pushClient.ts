// Веб-пуши на стороне браузера: регистрация service worker'а, подписка через
// PushManager, синхронизация с бэком (/api/custom/push/*).
//
// Почему всё через один модуль: разрешение на уведомления спрашивается ровно
// один раз за жизнь установки, и спросить его не вовремя — значит потерять
// возможность навсегда (браузер запомнит «Заблокировать»). Поэтому здесь нет
// ни одного автоматического запроса — только по явному нажатию человека.

import { pb, pbPublic } from '../pocketbase/pocketbase';

/** Режим: будить на всё или только на адресное (ответ / @упоминание). */
export type PushMode = 'mentions' | 'all';

export type PushState = {
  /** Пуши в принципе возможны: браузер умеет + на сервере есть ключи VAPID. */
  available: boolean;
  /** Разрешение браузера. 'denied' — тумблер бесполезен, нужны настройки сайта. */
  permission: NotificationPermission;
  /** Это устройство подписано. */
  subscribed: boolean;
  mode: PushMode;
};

const SW_URL = '/sw.js';
const MODE_KEY = 'push_mode';

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** base64url из VAPID-ключа → Uint8Array, как того хочет PushManager. */
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let keyCache: string | null | undefined;

/** Публичный ключ VAPID с сервера. null — пуши выключены (ключей нет). */
async function fetchPublicKey(): Promise<string | null> {
  if (keyCache !== undefined) return keyCache;
  try {
    const res = await pbPublic.send('/api/custom/push/key', { method: 'GET' });
    keyCache = res?.enabled && res?.public_key ? (res.public_key as string) : null;
  } catch {
    keyCache = null;
  }
  return keyCache;
}

/** SW регистрируем лениво — только когда пуши реально понадобились. Иначе
 *  каждый гость таскает воркер, который ему никогда не пригодится. */
async function ensureSW(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(SW_URL);
    if (existing) return existing;
    return await navigator.serviceWorker.register(SW_URL);
  } catch {
    return null;
  }
}

export function pushMode(): PushMode {
  return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'mentions';
}

/** endpoint пуш-подписки этого устройства (или null). Уходит в ping присутствия:
 *  так сервер понимает, что смотрят ИМЕННО с этого устройства, и не будит его.
 *  По человеку это считать нельзя — открытая вкладка на ноуте глушила бы
 *  телефон в кармане. */
export async function pushEndpoint(): Promise<string | null> {
  if (!supported()) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Текущее состояние для UI. Ничего не спрашивает и ни на что не подписывает. */
export async function pushState(): Promise<PushState> {
  const mode = pushMode();
  if (!supported()) {
    return { available: false, permission: 'denied', subscribed: false, mode };
  }
  const key = await fetchPublicKey();
  if (!key) return { available: false, permission: Notification.permission, subscribed: false, mode };

  let subscribed = false;
  // Уже выданное разрешение не даёт права будить: подписка могла быть снята с
  // другого устройства или протухнуть. Спрашиваем сам PushManager.
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  if (reg) subscribed = !!(await reg.pushManager.getSubscription());

  return { available: true, permission: Notification.permission, subscribed, mode };
}

/** Включить пуши на этом устройстве. Возвращает причину отказа или null (успех).
 *  Вызывать ТОЛЬКО из обработчика клика — иначе браузер не покажет запрос. */
export async function pushSubscribe(mode: PushMode = pushMode()): Promise<string | null> {
  if (!supported()) return 'This browser does not support notifications.';
  if (!pb.authStore.isValid) return 'Notifications are for signed-in users only.';

  const key = await fetchPublicKey();
  if (!key) return 'Notifications are not configured on the server.';

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    return perm === 'denied'
      ? 'Notifications are blocked in the site settings — you can only re-enable them there.'
      : 'Permission was not granted.';
  }

  const reg = await ensureSW();
  if (!reg) return 'Could not start the service worker.';
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // «тихие» пуши браузеры не разрешают, и правильно
        applicationServerKey: urlB64ToUint8Array(key) as BufferSource,
      });
    } catch {
      return 'The browser refused the subscription.';
    }
  }

  const json = sub.toJSON();
  try {
    await pb.send('/api/custom/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        mode,
      },
    });
  } catch {
    return 'The server rejected the subscription.';
  }
  localStorage.setItem(MODE_KEY, mode);
  return null;
}

/** Выключить на этом устройстве: снимаем и в браузере, и на сервере. Снять
 *  только на сервере мало — браузер продолжит считать сайт подписанным. */
export async function pushUnsubscribe(): Promise<void> {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const endpoint = sub.endpoint;
  try {
    await sub.unsubscribe();
  } catch { /* всё равно снимем на сервере */ }
  try {
    await pb.send('/api/custom/push/unsubscribe', { method: 'POST', body: { endpoint } });
  } catch { /* мёртвую подписку сервер выкинет сам при первой же отправке */ }
}

/** Сменить режим на уже подписанном устройстве (повторный subscribe = upsert). */
export async function pushSetMode(mode: PushMode): Promise<void> {
  localStorage.setItem(MODE_KEY, mode);
  const reg = await navigator.serviceWorker.getRegistration(SW_URL);
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  const json = sub.toJSON();
  try {
    await pb.send('/api/custom/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        mode,
      },
    });
  } catch { /* режим переживёт в localStorage до следующей подписки */ }
}

/** Прислать пуш себе — проверка «доходит ли вообще». */
export async function pushTest(): Promise<void> {
  await pb.send('/api/custom/push/test', { method: 'POST' });
}
