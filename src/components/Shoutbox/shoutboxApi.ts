// API шаутбокса. Чтение — штатный PB list + realtime-подписка (listRule
// публичный, payload режем fields-whitelist'ом — feedback-payload-discipline).
// Запись/модерация/presence — только Go-эндпоинты /api/custom/shoutbox/*.

import { pb, pbPublic } from '../../pocketbase/pocketbase';

export type ShoutGameRef = { id: string; title: string; author: string };
export type ShoutEvent =
  | { type: 'new_game'; games: ShoutGameRef[] }
  | { type: 'announcement'; title: string };

/** Денормализованный снимок родителя для цитаты в ответе (пишет бэкенд). */
export type ShoutReply = { id: string; name: string; anon_key: string; text: string };

export type ShoutMessage = {
  id: string;
  text: string;
  user: string;
  anon_key: string;
  kind: 'user' | 'system';
  event: ShoutEvent | null;
  reply: ShoutReply | null;
  created: string;
  /** v2: id канала. Пусто у старых сообщений и у системных — их показываем везде. */
  channel?: string;
  /** Закреплено модератором: висит шапкой над лентой своей комнаты. */
  pinned?: boolean;
  /** Автор правил текст после отправки. Своё поле, а не расхождение updated с
   *  created (как у комментариев): updated бьёт и закреп, и лента подписывала бы
   *  «изменено» сообщения, которых автор не касался. */
  edited?: boolean;
  /** v2: имя файла картинки-реакции (пусто = обычное текстовое сообщение). */
  image?: string;
  expand?: { user?: { id: string; name: string; username?: string; avatar: string; isModerator?: boolean } };
};

/** Лёгкий юзер для автодополнения @упоминаний. */
export type MentionUser = { id: string; name: string; username: string; avatar: string };

const COL = 'shoutbox_messages';
const FIELDS =
  'id,text,user,anon_key,kind,event,reply,created,channel,pinned,edited,image,' +
  'expand.user.id,expand.user.name,expand.user.username,expand.user.avatar,expand.user.isModerator';

/** Размер страницы ленты: и первая загрузка, и подгрузка старых при скролле. */
export const SHOUT_PAGE = 50;

/** URL аватара для лёгкого user-объекта из expand. В нём нет collectionName
 *  (режем fields-вайтлистом), поэтому строим URL на коллекцию users вручную.
 *  undefined → аноним/без аватара, рисуем инициал. */
export function avatarUrlOf(u?: { id: string; avatar?: string }): string | undefined {
  if (!u?.avatar) return undefined;
  return pb.files.getURL({ id: u.id, collectionName: 'users' } as never, u.avatar, { thumb: '100x100' });
}

/** Страница сообщений, старые → новые (лента рендерится сверху вниз). Без before
 *  — самые свежие; с before (created сообщения) — на страницу старше него, для
 *  подгрузки истории при прокрутке вверх. Меньше SHOUT_PAGE в ответе = дальше нет. */
export async function fetchMessages(
  before?: string,
  channelId?: string,
  /** Активный канал — дефолтный (первый в списке). Только туда падают старые
   *  сообщения без канала: они написаны до появления комнат и по смыслу лежат в
   *  общей. Раньше их показывало в КАЖДОЙ комнате — вся доканальная переписка
   *  всплывала в suggestions. */
  withLegacy = false,
): Promise<ShoutMessage[]> {
  return fetchPage({ before, channelId, withLegacy });
}

/** Страница НОВЕЕ курсора (created сообщения), старые → новые. Нужна окну
 *  памяти: улистав далеко в историю, лента отцепляется от живого хвоста, и
 *  обратно вниз она идёт такими же страницами, а не перезагрузкой всего. */
export async function fetchNewer(
  after: string,
  channelId?: string,
  withLegacy = false,
): Promise<ShoutMessage[]> {
  return fetchPage({ after, channelId, withLegacy });
}

async function fetchPage(opts: {
  before?: string;
  after?: string;
  channelId?: string;
  withLegacy?: boolean;
}): Promise<ShoutMessage[]> {
  const { before, after, channelId, withLegacy = false } = opts;
  const parts: string[] = [];
  if (before) parts.push(pbPublic.filter('created < {:before}', { before }));
  if (after) parts.push(pbPublic.filter('created > {:after}', { after }));
  // Режим «раздельные каналы»: тянем только свой канал. Системные события
  // (новые игры, анонсы) сохраняются без канала, поэтому попадают сюда тем же
  // условием channel = "", что и доканальная история, — то есть ТОЛЬКО в
  // дефолтную комнату. Раньше они шли в каждую (`kind = "system"` в фильтре), и
  // тематическая ветка на пару живых реплик тонула в ленте новых игр.
  if (channelId) {
    parts.push(pbPublic.filter(
      withLegacy ? '(channel = {:ch} || channel = "")' : 'channel = {:ch}',
      { ch: channelId },
    ));
  }
  // Идём от курсора наружу: вверх — самые свежие из старых, вниз — самые старые
  // из новых. Поэтому направление сортировки зависит от стороны, а ленте всегда
  // отдаём порядок «старые → новые».
  const res = await pbPublic.collection(COL).getList<ShoutMessage>(1, SHOUT_PAGE, {
    sort: after ? 'created' : '-created',
    filter: parts.join(' && '),
    expand: 'user',
    fields: FIELDS,
    requestKey: null,
  });
  return after ? res.items : res.items.reverse();
}

/** Место сообщения в текущей ленте: те же правила, что в фильтре fetchMessages,
 *  но для одной записи. Realtime-подписка одна на всю коллекцию, и приходящие
 *  из чужих комнат сообщения надо отсеивать здесь — иначе, стоя в suggestions,
 *  видишь, как в ленту падает свежий general. */
export function messageInChannel(m: ShoutMessage, channelId?: string, withLegacy = false): boolean {
  if (!channelId) return true; // слитная лента — показываем всё
  if (m.channel === channelId) return true;
  // Системные (без канала) — как и доканальная история: только в дефолтной.
  return withLegacy && !m.channel;
}

/** Realtime только пока дровер открыт; вернувшийся колбэк закрывает подписку. */
export async function subscribeMessages(
  onEvent: (action: string, record: ShoutMessage) => void,
): Promise<() => void> {
  return pb.collection(COL).subscribe<ShoutMessage>(
    '*',
    (e) => onEvent(e.action, e.record),
    { expand: 'user', fields: FIELDS },
  );
}

export async function postMessage(text: string, replyTo?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox', {
    method: 'POST',
    body: replyTo ? { text, reply_to: replyTo } : { text },
  });
}

// ---------------------------------------------------------------------------
// v2: каналы, анон-тумблер, пароль на удаление, картинки, «кто здесь»
// Спека: wiki/components/shoutbox-v2-spec.md
// ---------------------------------------------------------------------------

export type ShoutChannel = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  is_private?: boolean;
};

/** Участник в списке «кто сейчас здесь». Показываются только те, кто сам
 *  согласился светиться (ping с visible) — по умолчанию человек невидим. */
export type ShoutWho = { id: string; name: string; avatar?: string; mod?: boolean };

export type ShoutPostOptions = {
  replyTo?: string;
  /** slug канала; пусто — дефолтный (первый публичный). */
  channel?: string;
  /** Отправить анонимно, будучи залогиненным. */
  anon?: boolean;
  /** Пароль, которым потом можно снести это сообщение с любого устройства. */
  delPass?: string;
  /** Картинка-реакция, ≤2 МБ, только для залогиненных. */
  image?: File | null;
};

/** Каналы, доступные звонящему. Закрытые видны только участникам — сервер сам
 *  их отфильтрует, отдельного флага «я в клубе» фронту не нужно. */
export async function fetchChannels(): Promise<ShoutChannel[]> {
  try {
    const res = await pb.send('/api/custom/shoutbox/channels', { method: 'GET' });
    return (res?.channels ?? []) as ShoutChannel[];
  } catch {
    return [];
  }
}

/** Отправка v2. С картинкой уходит multipart, без неё — обычный JSON: незачем
 *  гонять FormData ради текстовой строчки. */
export async function postMessageV2(text: string, opts: ShoutPostOptions = {}): Promise<void> {
  const { replyTo, channel, anon, delPass, image } = opts;

  if (!image) {
    const body: Record<string, unknown> = { text };
    if (replyTo) body.reply_to = replyTo;
    if (channel) body.channel = channel;
    if (anon) body.anon = true;
    if (delPass) body.del_pass = delPass;
    await pb.send('/api/custom/shoutbox', { method: 'POST', body });
    return;
  }

  const fd = new FormData();
  fd.append('text', text);
  if (replyTo) fd.append('reply_to', replyTo);
  if (channel) fd.append('channel', channel);
  if (anon) fd.append('anon', '1');
  if (delPass) fd.append('del_pass', delPass);
  fd.append('image', image);
  await pb.send('/api/custom/shoutbox', { method: 'POST', body: fd });
}

/** Снести СВОЁ сообщение: по авторству, по anon_key (тот же IP) или по паролю.
 *  Сервер намеренно отвечает одинаковым 403 на «не твоё» и «пароль не тот». */
export async function deleteOwnMessage(id: string, delPass?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/delete-own', {
    method: 'POST',
    body: delPass ? { id, del_pass: delPass } : { id },
  });
}

/** Счётчик онлайна + список видимых. Гостей и невидимок в списке нет. */
export async function fetchWho(): Promise<{ online: number; who: ShoutWho[] }> {
  try {
    const res = await pb.send('/api/custom/shoutbox/who', { method: 'GET' });
    return { online: res?.online ?? 0, who: (res?.who ?? []) as ShoutWho[] };
  } catch {
    return { online: 0, who: [] };
  }
}

/** URL картинки сообщения. thumb '360x0' — лента, без thumb — просмотр целиком. */
export function messageImageUrl(m: ShoutMessage, thumb?: string): string | undefined {
  if (!m.image) return undefined;
  return pb.files.getURL(
    { id: m.id, collectionName: COL } as never,
    m.image,
    thumb ? { thumb } : {},
  );
}

/** Кандидаты для @упоминания по подстроке. Пусто/ошибка → []. */
export async function searchMentionUsers(q: string): Promise<MentionUser[]> {
  if (!q.trim()) return [];
  try {
    const res = await pb.send(`/api/custom/shoutbox/users?q=${encodeURIComponent(q)}`, { method: 'GET' });
    return (res?.users ?? []) as MentionUser[];
  } catch {
    return [];
  }
}

export async function deleteMessage(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/delete', { method: 'POST', body: { id } });
}

/** Что показывает карточка человека по клику на ник. Профили на сайте пока
 *  бедные, поэтому и полей мало — карточка задумана как место, куда потом
 *  доедут любимые игры и билды. */
export type ShoutProfile = {
  id: string;
  name?: string;
  username?: string;
  avatar?: string;
  created: string;
  isModerator?: boolean;
};

/** Правка своего сообщения. Картинку не трогаем: заменить её — это, по сути,
 *  другое сообщение, проще удалить и написать заново. */
export async function editOwnMessage(id: string, text: string, delPass?: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/edit', {
    method: 'POST',
    body: delPass ? { id, text, del_pass: delPass } : { id, text },
  });
}

/** Закрепить/открепить (модератор). Закреплённое висит шапкой над своей комнатой. */
export async function pinMessage(id: string, pinned: boolean): Promise<void> {
  await pb.send('/api/custom/shoutbox/pin', { method: 'POST', body: { id, pinned } });
}

/** Профиль человека для карточки по клику на ник. Тянем ОТДЕЛЬНЫМ запросом и
 *  только по клику: добавить эти поля в ленту значит платить за них на каждом
 *  сообщении у каждого читателя ради редкого нажатия. */
export async function fetchProfile(id: string): Promise<ShoutProfile | null> {
  try {
    const r = await pb.collection('users').getOne(id, {
      fields: 'id,name,username,avatar,created,isModerator',
    });
    return r as unknown as ShoutProfile;
  } catch {
    return null;
  }
}

export async function muteMessageSource(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/mute', { method: 'POST', body: { id } });
}

export async function unmuteMessageSource(id: string): Promise<void> {
  await pb.send('/api/custom/shoutbox/unmute', { method: 'POST', body: { id } });
}

/** Пинг presence. Возвращает онлайн, число непрочитанных с момента since,
 *  СВОЙ anon_key звонящего (для показа анону его псевдо-ника) и серверную
 *  отметку прочтения (синхронизация бейджа между устройствами). */
export async function pingPresence(
  since = '',
): Promise<{ online: number; unread: number; anonKey: string; lastSeen: string }> {
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await pb.send(`/api/custom/shoutbox/ping${q}`, { method: 'POST' });
  return {
    online: res?.online ?? 0,
    unread: res?.unread ?? 0,
    anonKey: res?.anon_key ?? '',
    lastSeen: res?.last_seen ?? '',
  };
}

// ---------------------------------------------------------------------------
// «Пульс»: единственный запрос страницы с закрытым чатом
// ---------------------------------------------------------------------------

/** Времена последних сообщений по публичным каналам (unix-секунды, новые
 *  первыми) + счётчик онлайна. Ключ "" — сообщения без канала. */
export type ShoutPulse = { online: number; t: Record<string, number[]> };

/** Прочитать пульс. ГОЛЫЙ fetch без единого заголовка авторизации — намеренно:
 *  ответ одинаков для всех, и только безымянный запрос край сети (Cloudflare)
 *  соглашается отдавать из кэша. Пошли мы сюда токен — каждый залогиненный
 *  ходил бы за ответом на наш сервер лично, ради тех же самых цифр. */
export async function fetchPulse(): Promise<ShoutPulse | 'disabled' | null> {
  try {
    const res = await fetch('/api/custom/shoutbox/pulse', { credentials: 'omit' });
    // Выключенный фиче-флаг неотличим от несуществующего роута — 404 на всю
    // группу /shoutbox. Узнаём об этом отсюда же и не тратим на флаг отдельный
    // (некэшируемый!) запрос: пульс всё равно первое, что делает страница.
    if (res.status === 404) return 'disabled';
    if (!res.ok) return null;
    const j = await res.json();
    return { online: j?.online ?? 0, t: (j?.t ?? {}) as Record<string, number[]> };
  } catch {
    return null; // оффлайн — пусть счётчик держит прошлое значение
  }
}

/** Сколько сообщений в пульсе новее отметки прочтения. Считает браузер: полсотни
 *  чисел сравнить дешевле, чем сходить на сервер за готовым числом (а главное —
 *  дешевле для сервера, для которого это число персональное). */
export function countPulseUnread(
  pulse: ShoutPulse,
  sinceISO: string,
  onlyChannels?: string[],
): number {
  const since = sinceISO ? new Date(sinceISO).getTime() : 0;
  if (!since || Number.isNaN(since)) return 0;
  let n = 0;
  for (const [ch, list] of Object.entries(pulse.t)) {
    if (onlyChannels && !onlyChannels.includes(ch)) continue;
    // Списки отсортированы «новые первыми» — на первом же старом можно бросать.
    for (const ts of list) {
      if (ts * 1000 <= since) break;
      n += 1;
    }
  }
  return n;
}

/** Отметить чат прочитанным НА СЕРВЕРЕ (users.shoutbox_last_seen = now). Только
 *  для залогиненных — синхронит бейдж между устройствами (прочитал на ПК → гаснет
 *  на телефоне). Аноним — no-op (его read-состояние живёт лишь в localStorage).
 *  Best-effort: упало — бейдж всё равно поправит следующий пинг. */
export async function markSeenServer(): Promise<void> {
  if (!pb.authStore.isValid) return;
  try {
    await pb.send('/api/custom/shoutbox/seen', { method: 'POST' });
  } catch { /* не критично */ }
}

/** Фиче-флаг + онлайн. 404 (флаг выключен) → enabled:false. */
export async function fetchConfig(): Promise<{ enabled: boolean; online: number }> {
  try {
    const res = await pbPublic.send('/api/custom/shoutbox/config', {});
    return { enabled: !!res?.enabled, online: res?.online ?? 0 };
  } catch {
    return { enabled: false, online: 0 };
  }
}
