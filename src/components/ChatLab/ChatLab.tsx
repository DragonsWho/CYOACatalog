// Полигон чата v2. Спека: wiki/components/shoutbox-v2-spec.md.
//
// Отдельная скрытая страница (/chat-lab), а не правка живого дровера: чат
// доводится на глазах у автора, но не у пользователей. Когда устаканится —
// переезжает в шапку на место v1.
//
// Что здесь нового против дровера v1:
//  • каналы в ДВУХ режимах — общая лента с чипами и раздельные комнаты (§4.1);
//  • тумблер «написать анонимно» для залогиненных (§5);
//  • пароль на удаление своего сообщения для гостей (§6);
//  • картинки-реакции ≤2 МБ (§9);
//  • «кто сейчас здесь» с явным согласием показаться (§8);
//  • ответы, @упоминания с автодополнением и модераторские кнопки.
//
// Интерфейс по-английски: сайт англоязычный, чат показываем бетатестерам.

import {
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, IconButton, Popover, Snackbar,
  Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ReplyOutlinedIcon from '@mui/icons-material/ReplyOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import PeopleOutlineIcon from '@mui/icons-material/PeopleOutline';
import ViewAgendaOutlinedIcon from '@mui/icons-material/ViewAgendaOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import MasksOutlinedIcon from '@mui/icons-material/MasksOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import PushBell from '../../push/PushBell';
import { pushEndpoint } from '../../push/pushClient';
import { AuthContext } from '../../pocketbase/pocketbase';
import {
  dayLabel, sameDay,
} from '../CyoaPage/Comments/relativeTime';
import { anonIdentity, nickColor } from '../Shoutbox/anonIdentity';
import {
  MentionUser, SHOUT_PAGE, ShoutChannel, ShoutMessage, ShoutProfile, ShoutWho, avatarUrlOf,
  deleteMessage, deleteOwnMessage, editOwnMessage, fetchChannels, fetchMessages, fetchProfile,
  fetchNewer, fetchWho, messageInChannel, muteMessageSource, pinMessage, postMessageV2,
  searchMentionUsers, subscribeMessages,
} from '../Shoutbox/shoutboxApi';
import MessageRow from './MessageRow';
import { pb } from '../../pocketbase/pocketbase';

// Сколько строк ленты держим в памяти одновременно. Дальше история не
// пропадает — она просто подгружается страницами с обеих сторон, как в Discord:
// улистал вверх — из памяти выпал низ, вернулся вниз — выпал верх. Тысячи живых
// DOM-узлов чат не переживает: на дешёвом телефоне это секунды на кадр даже без
// перерисовки, просто на пересчёт раскладки.
const WINDOW_MAX = 500;

const MAX_LEN = 300;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** Сообщения одного автора, идущие подряд, склеиваются в блок: аватарка и ник
 *  показываются один раз. Это главная визуальная примета мессенджера — без неё
 *  лента читается как форум. Пять минут — привычный порог: после паузы человек
 *  уже «зашёл снова», и подпись уместна. */
const GROUP_GAP_SEC = 5 * 60;

/** Карточка человека по клику на ник. Флаг, потому что профили на сайте пока
 *  почти пустые: показать нечего, кроме аватарки и даты. Ставим false — и
 *  карточка исчезает вместе с запросом за профилем, ничего больше не меняя. */
const PROFILE_POPOVER = true;

/** Режим показа каналов. Автор просил обе схемы: слитную ленту с чипами (моё
 *  предложение) и привычные раздельные комнаты как в Discord — «привычно и
 *  понятно выглядит» это тоже часть уюта. Выбор живёт в localStorage. */
type ChannelMode = 'merged' | 'rooms';
const MODE_KEY = 'chatlab_channel_mode';
const VISIBLE_KEY = 'chatlab_visible';
const DELPASS_KEY = 'chatlab_delpass';

const SEEN_KEY = 'chatlab_channel_seen';

/** Полоска над полем ввода (ответ, правка, выбранная картинка). Один вид на все
 *  три: разнобой над одним и тем же полем читается как поломка. */
const STRIP_SX = {
  mb: 0.5,
  px: 1,
  py: 0.5,
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.04)',
} as const;

/** Хвост строки вида «@ник» — по нему открывается автодополнение упоминаний. */
const MENTION_TAIL = /@([A-Za-z0-9_]{1,30})$/;

/** «Докуда я дочитал в каждой комнате»: канал → unix-секунды. Отметка на
 *  устройство и по делу: прочитанное на ноуте не делает прочитанным на
 *  телефоне, который ты ещё не открывала. Держать это на сервере значило бы
 *  завести поле на человека×канал и писать в базу при каждом переключении
 *  комнаты — ради точки на чипе это чересчур. */
function loadChannelSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
  } catch {
    return {};
  }
}

function markChannelsSeen(ids: string[]) {
  const all = loadChannelSeen();
  const now = Math.floor(Date.now() / 1000);
  for (const id of ids) all[id] = now;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch { /* приватный режим — подсветка просто не запомнится */ }
}

function loadMode(): ChannelMode {
  return localStorage.getItem(MODE_KEY) === 'rooms' ? 'rooms' : 'merged';
}

/** Комнат стало больше двух, и возвращаться каждый раз в General — тот же
 *  раздражитель, что и потеря режима. Помним последнюю выбранную; если комнату
 *  убрали или закрыли, тихо падаем в дефолтную (см. место применения). */
const CHAN_KEY = 'chatlab_channel';

/** Пароли на удаление, которые мы оставили за собой: id сообщения → пароль.
 *  Живут в localStorage, чтобы кнопка «удалить» работала у гостя без ввода
 *  пароля вручную; сам пароль нужен только когда localStorage потерян или
 *  человек удаляет с другого устройства. */
function loadDelPasses(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DELPASS_KEY) || '{}');
  } catch {
    return {};
  }
}

function rememberDelPass(id: string, pass: string) {
  const all = loadDelPasses();
  all[id] = pass;
  // Ретенция чата — месяц, но столько паролей хранить незачем: держим последние 50.
  const keys = Object.keys(all);
  if (keys.length > 50) delete all[keys[0]];
  localStorage.setItem(DELPASS_KEY, JSON.stringify(all));
}

/** Случайный пароль на удаление для гостя. Гость его не видит и не запоминает —
 *  он лежит в localStorage и нужен ровно для того, чтобы кнопка «удалить» жила
 *  дольше, чем anon_key (неделя) или смена IP. Спека §6. */
function makeDelPass(): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

/** Кто написал — одной строкой, чтобы сравнивать соседние сообщения. У гостя
 *  личность держится на anon_key, у зарегистрированного — на id. */
function authorKey(m: ShoutMessage): string {
  if (m.user) return `u:${m.user}`;
  if (m.anon_key) return `a:${m.anon_key}`;
  return '';
}

/** Продолжает ли `m` блок предыдущего сообщения. Склеиваем только обычные
 *  сообщения одного автора в одной комнате, если между ними меньше GROUP_GAP_SEC.
 *  Ответ (reply) блок всегда разрывает: у него своя шапка с цитатой, и без
 *  аватарки было бы непонятно, кто отвечает. */
function sameRun(prev: ShoutMessage | undefined, m: ShoutMessage): boolean {
  if (!prev || m.reply) return false;
  if (prev.kind !== 'user' || m.kind !== 'user') return false;
  if ((prev.channel || '') !== (m.channel || '')) return false;
  const key = authorKey(m);
  if (!key || authorKey(prev) !== key) return false;
  const dt = (new Date(m.created.replace(' ', 'T')).getTime()
    - new Date(prev.created.replace(' ', 'T')).getTime()) / 1000;
  return dt >= 0 && dt < GROUP_GAP_SEC;
}

export default function ChatLab() {
  const { signedIn, user, isModerator } = useContext(AuthContext);

  const [channels, setChannels] = useState<ShoutChannel[]>([]);
  const [mode, setMode] = useState<ChannelMode>(loadMode);
  const [active, setActive] = useState<string>(''); // slug активного канала ('' — все)
  const [messages, setMessages] = useState<ShoutMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  // Лента отцеплена от живого хвоста: снизу из окна памяти выпали сообщения.
  // Пока это так, realtime в ленту не клеим — иначе между историей и свежим
  // сообщением получится молчаливая дыра.
  const [hasNewer, setHasNewer] = useState(false);

  const [text, setText] = useState('');
  const [anon, setAnon] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [replyTo, setReplyTo] = useState<ShoutMessage | null>(null);

  const [mentionQ, setMentionQ] = useState('');
  const [mentionOpts, setMentionOpts] = useState<MentionUser[]>([]);

  // Подсветка комнат. chanLast — когда в канале последний раз писали (сервер,
  // unix-секунды), chanMentions — где звали лично. Сверяется с локальной
  // отметкой «докуда я тут дочитал»: она на устройство, поэтому и живёт в
  // localStorage, а не в базе — иначе это поле на человека×канал в схеме и
  // запись при каждом переключении комнаты.
  const [chanLast, setChanLast] = useState<Record<string, number>>({});
  const [chanMentions, setChanMentions] = useState<string[]>([]);
  const [channelSeen, setChannelSeen] = useState<Record<string, number>>(loadChannelSeen);
  const openChannelsRef = useRef<string[]>([]);
  // Отметка прочтения на МОМЕНТ ОТКРЫТИЯ страницы — по ней рисуется черта
  // «новое». Обычный channelSeen для этого не годится: он обновляется, пока ты
  // читаешь, и черта уползала бы вниз прямо из-под курсора. Снимок берётся при
  // первом рендере, то есть заведомо раньше эффекта, который помечает прочтённым.
  const seenAtOpenRef = useRef<Record<string, number>>(loadChannelSeen());
  // Правка: сообщение, которое сейчас в поле ввода вместо нового.
  const [editing, setEditing] = useState<ShoutMessage | null>(null);
  // Карточка человека по клику на ник. Профили тянем по одному и запоминаем:
  // в чате одни и те же собеседники, второй клик по тому же нику — уже бесплатно.
  // Строка, по которой коснулись пальцем: на телефоне это единственный способ
  // показать кнопки — наведения там нет, а держать их видимыми всегда значит
  // закрыть ими текст.
  const [touched, setTouched] = useState<string | null>(null);
  const [profileAnchor, setProfileAnchor] = useState<HTMLElement | null>(null);
  const [profile, setProfile] = useState<ShoutProfile | null>(null);
  const profileCache = useRef<Record<string, ShoutProfile>>({});

  const [anonKey, setAnonKey] = useState('');
  const [online, setOnline] = useState(0);
  const [who, setWho] = useState<ShoutWho[]>([]);
  const [visible, setVisible] = useState(() => localStorage.getItem(VISIBLE_KEY) === '1');
  // «Кто здесь» — выпадашка от кнопки со счётчиком, а не панель в потоке: панель
  // на телефоне отъедала треть ленты ровно тогда, когда в неё хочется смотреть.
  const [whoAnchor, setWhoAnchor] = useState<HTMLElement | null>(null);
  const showWho = Boolean(whoAnchor);
  // Человек ушёл вверх по истории — показываем кнопку «вниз». Это то же, что
  // atBottomRef, но в состоянии: ref не перерисовывает.
  const [atBottom, setAtBottom] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const atBottomRef = useRef(true);
  const activePillRef = useRef<HTMLElement | null>(null);
  // Подгрузка истории вверх. Гвард от параллельных загрузок обязателен: одно
  // движение пальцем у верхнего края — это десятки событий scroll, а курсор
  // (created самого верхнего сообщения) во всех замыканиях один и тот же, пока
  // не приедет первый ответ. Без гварда лента вклеивала одну и ту же страницу
  // истории по нескольку раз — те самые повторяющиеся куски по несколько дней.
  const loadingOlderRef = useRef(false);
  // Якорь позиции: держим на месте КОНКРЕТНУЮ строку (по data-mid), а не
  // разницу высот. Окно памяти меняет ленту с обеих сторон сразу — сверху
  // приехала история, снизу выпал хвост, — и «лента выросла ровно на столько-то»
  // тут врёт: экран уезжал бы на высоту выпавшего.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  // Подгрузка вниз — свой гвард: она может идти одновременно с подгрузкой вверх
  // (инерционная прокрутка успевает задеть оба края).
  const loadingNewerRef = useRef(false);
  // Realtime-подписка живёт дольше рендера, поэтому «отцеплены ли мы» ей нужно
  // в ref: в замыкании state навсегда остался бы тем, каким был при подписке.
  const hasNewerRef = useRef(false);
  hasNewerRef.current = hasNewer;
  // Где сейчас стоит взгляд: запоминаем строку и её место на экране, чтобы
  // после перекройки ленты вернуть её туда же.
  const anchorOn = useCallback((id: string) => {
    const el = listRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (!el || !node) return;
    anchorRef.current = {
      id,
      top: node.getBoundingClientRect().top - el.getBoundingClientRect().top,
    };
  }, []);

  // Поколение ленты, растёт на каждой перезагрузке (смена комнаты/режима).
  // Ответ, выехавший из прошлой комнаты, в новую ленту не попадёт.
  const feedGenRef = useRef(0);

  const activeChannel = useMemo(
    () => channels.find((c) => c.slug === active),
    [channels, active],
  );

  // Дефолтный канал — первый в списке (сервер отдаёт их отсортированными). Только
  // в нём показываем старые сообщения без канала: они написаны до появления
  // комнат, и их место в общей, а не в каждой.
  const isDefaultChannel = Boolean(activeChannel && channels[0]?.id === activeChannel.id);

  // «В комнате есть новое»: серверное время последнего сообщения новее моей
  // локальной отметки прочтения.
  const channelHasNew = (id: string) => (chanLast[id] ?? 0) > (channelSeen[id] ?? 0);

  // Первое непрочитанное сообщение — перед ним встанет черта «новое». Считаем
  // по снимку отметок на момент открытия, поэтому черта стоит на месте, пока
  // страница открыта, и не убегает от читающего.
  //
  // Тем, кто в комнате впервые (отметки нет вообще), черту не рисуем: ставить её
  // над самым верхом ленты бессмысленно — там «новое» просто всё.
  const firstUnreadId = useMemo(() => {
    const home = channels[0]?.id;
    for (const m of messages) {
      const chId = m.channel || home;
      if (!chId) continue;
      const seen = seenAtOpenRef.current[chId];
      if (!seen) continue;
      if (new Date(m.created.replace(' ', 'T')).getTime() / 1000 > seen) return m.id;
    }
    return null;
  }, [messages, channels]);

  // ---------------------------------------------------------------- загрузка

  useEffect(() => {
    fetchChannels().then((cs) => {
      setChannels(cs);
      // В режиме комнат надо где-то стоять; в слитном — по умолчанию «всё сразу».
      // Запомненную комнату берём, только если она ещё в списке: её могли убрать
      // или закрыть, и тогда фильтр по несуществующему каналу дал бы пустую ленту.
      const saved = localStorage.getItem(CHAN_KEY);
      const remembered = cs.some((c) => c.slug === saved) ? saved! : cs[0]?.slug;
      setActive((cur) => (cur || (loadMode() === 'rooms' && cs[0] ? remembered : '')));
    });
  }, [signedIn]);

  const reload = useCallback(async () => {
    setLoading(true);
    // Новое поколение ленты: всё, что грузилось для прошлой комнаты, теперь
    // чужое. Заодно снимаем гвард пагинации — иначе застрявший на смене комнаты
    // флаг навсегда выключил бы подгрузку истории.
    feedGenRef.current += 1;
    const gen = feedGenRef.current;
    loadingOlderRef.current = false;
    loadingNewerRef.current = false;
    anchorRef.current = null;
    setHasMore(true);
    // Свежая страница — это и есть живой хвост, лента снова прицеплена.
    setHasNewer(false);
    hasNewerRef.current = false;
    // Фильтруем по каналу только в режиме комнат: в слитной ленте чипы — это
    // подпись «откуда сообщение», не фильтр, иначе теряется весь смысл
    // общей ленты (видеть всё сразу и не пропускать редкие каналы).
    const chId = mode === 'rooms' ? activeChannel?.id : undefined;
    try {
      const items = await fetchMessages(undefined, chId, isDefaultChannel);
      // На старте reload успевает сходить дважды (сначала без каналов, потом с
      // восстановленной комнатой). Ответ прошлого поколения выбрасываем: иначе
      // он мог приехать вторым и подменить ленту чужой комнатой.
      if (gen !== feedGenRef.current) return;
      setMessages(items);
      setHasMore(items.length >= SHOUT_PAGE);
    } catch {
      if (gen === feedGenRef.current) setError('Could not load messages.');
    } finally {
      if (gen === feedGenRef.current) setLoading(false);
    }
  }, [mode, activeChannel?.id, isDefaultChannel]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Realtime. Фильтрация по каналу на клиенте: подписка одна на коллекцию, и
  // решать «моё сообщение или чужой комнаты» дешевле здесь, чем держать
  // отдельный SSE-канал на каждую комнату (прод уже ловил шторм из-за SSE).
  //
  // Текущий канал держим в ref: подписка живёт всё время жизни страницы, а
  // замыкание на state показывало бы чужие комнаты после переключения.
  const filterRef = useRef<{ id?: string; legacy: boolean }>({ legacy: false });
  filterRef.current = {
    id: mode === 'rooms' ? activeChannel?.id : undefined,
    legacy: isDefaultChannel,
  };

  // Догон ленты после паузы. Пока труба закрыта (свернули вкладку, уснул ноут,
  // отвалилась сеть), события realtime идут мимо, и сервер их НЕ хранит:
  // переподключение само по себе пропущенного не принесёт. Именно поэтому на
  // разбуженном телефоне оставались висеть сообщения, удалённые модератором с
  // компьютера, — вкладка о них просто не узнала.
  //
  // Перечитываем не всю историю, а последнюю страницу, и ею заменяем свой
  // хвост: так уезжают удалённые, подхватываются правки и приходят пропущенные.
  // Всё, что старше границы страницы, человек мог подгрузить прокруткой вверх —
  // выкидывать его из истории (и утаскивать в конец ленты) незачем.
  const lastCatchUpRef = useRef(0);
  const catchUp = useCallback(async () => {
    // Пробуждение часто приходит сразу двумя событиями (вкладка показалась и
    // проснулся таймер) — второй заход подряд ничего не добавит.
    if (Date.now() - lastCatchUpRef.current < 3000) return;
    // Человек стоит в истории с отцепленным хвостом — догонять нечего: свежую
    // страницу он получит, когда вернётся вниз.
    if (hasNewerRef.current) return;
    lastCatchUpRef.current = Date.now();
    const gen = feedGenRef.current;
    try {
      const chId = mode === 'rooms' ? activeChannel?.id : undefined;
      const page = await fetchMessages(undefined, chId, isDefaultChannel);
      if (gen !== feedGenRef.current || page.length === 0) return;
      const edge = page[0].created;
      const fresh = new Set(page.map((m) => m.id));
      // Ни одно известное сообщение не попало в свежее окно — значит, проспали
      // больше страницы, и между своей историей и хвостом дыра. Склеивать через
      // неё нельзя (получится лента с молчаливым провалом): показываем сплошной
      // хвост с сервера, остальное человек дотянет прокруткой вверх.
      if (messages.length && !messages.some((m) => fresh.has(m.id))) {
        setMessages(page);
        setHasMore(true);
        return;
      }
      const merged = [
        ...messages.filter((m) => m.created < edge && !fresh.has(m.id)),
        ...page,
      ];
      // Окно памяти держим и здесь: за долгий сон хвост мог прирасти так, что
      // лента перевалила за предел. Лишнее срезаем сверху — историю человек
      // дотянет прокруткой, — а видимое место удерживаем якорем.
      if (merged.length > WINDOW_MAX) {
        const cut = merged.slice(merged.length - WINDOW_MAX);
        anchorOn(cut[0].id);
        setMessages(cut);
        setHasMore(true);
        return;
      }
      setMessages(merged);
    } catch { /* сеть ещё не вернулась — догоним на следующем пробуждении */ }
  }, [mode, activeChannel?.id, isDefaultChannel, messages, anchorOn]);
  // Подписка не должна пересоздаваться из-за смены комнаты, поэтому внутрь неё
  // догон попадает ссылкой, а не зависимостью.
  const catchUpRef = useRef(catchUp);
  catchUpRef.current = catchUp;

  // Спит ли страница. Живой поток держим ТОЛЬКО пока вкладка на экране: дело не
  // в экономии клиента, а в проде — постоянные SSE-трубы через Cloudflare его
  // уже клали (спека §12в), а свёрнутая вкладка всё равно держит мёртвую трубу,
  // которую Cloudflare рвёт по idle-таймауту.
  const [awake, setAwake] = useState(() => (
    typeof document === 'undefined' || document.visibilityState === 'visible'
  ));
  // Счётчик пробуждений: меняется — значит, надо переподключиться и догнать.
  const [wakeEpoch, setWakeEpoch] = useState(0);
  useEffect(() => {
    const onVis = () => setAwake(document.visibilityState === 'visible');
    const onWake = () => setWakeEpoch((n) => n + 1);
    // Ноут, уснувший с открытой вкладкой, visibilitychange не шлёт: вкладка как
    // была видимой, так и осталась. Такое пробуждение видно только по разрыву во
    // времени — таймер, «проспавший» своё окно, и есть признак сна. Фоновые
    // вкладки браузер и так тормозит до раза в минуту, поэтому порог с запасом.
    let last = Date.now();
    const t = window.setInterval(() => {
      const now = Date.now();
      const slept = now - last > 90_000;
      last = now;
      if (slept) onWake();
    }, 30_000);
    // pageshow ловим только с persisted: обычная загрузка страницы шлёт его
    // тоже, и без проверки первый же вход считался бы пробуждением.
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) onWake(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onWake);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onWake);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  const subscribedOnceRef = useRef(false);
  useEffect(() => {
    if (!awake) return undefined;
    let stop: (() => void) | undefined;
    let dead = false;
    // Самая первая подписка — это загрузка страницы, ленту только что принёс
    // reload() и догонять нечего. Все следующие — возвращение из паузы.
    if (subscribedOnceRef.current) catchUpRef.current();
    subscribedOnceRef.current = true;
    // Джиттер перед подпиской: когда пачка вкладок просыпается разом (открыли
    // ноут), трубы открываются размазанно, а не в одну секунду.
    const t = window.setTimeout(() => {
      subscribeMessages((action, rec) => {
        if (dead) return;
        setMessages((cur) => {
          if (action === 'delete') return cur.filter((m) => m.id !== rec.id);
          if (action === 'update') return cur.map((m) => (m.id === rec.id ? rec : m));
          // Низ ленты выпал из окна памяти: свежее сообщение приедет
          // страницей, когда человек спустится обратно (или нажмёт «вниз»).
          if (hasNewerRef.current) return cur;
          const { id, legacy } = filterRef.current;
          if (!messageInChannel(rec, id, legacy)) return cur;
          if (cur.some((m) => m.id === rec.id)) return cur;
          return [...cur, rec];
        });
      }).then((fn) => {
        if (dead) fn();
        else stop = fn;
      }).catch(() => { /* поток не поднялся — лента останется на догоне */ });
    }, Math.random() * 1500);
    return () => {
      dead = true;
      window.clearTimeout(t);
      stop?.();
    };
  }, [awake, wakeEpoch]);

  // Пинг присутствия. visible=1/0 — явное согласие показаться или спрятаться;
  // пинг из шапки сайта ходит без этого параметра и карточку не трогает (§8).
  //
  // Вместе с пингом отдаём endpoint пуш-подписки этого устройства: сервер по
  // нему понимает, что смотрят именно отсюда, и не будит эту вкладку пушем.
  //
  // chat=1 просит попутно прислать подсветку каналов, ch=<id> — «этот канал я
  // сейчас читаю, упоминание в нём погаси». Отдельного запроса под подсветку
  // нет намеренно: лишний раунд-трип раз в минуту на каждого читателя.
  //
  // Свёрнутая вкладка не пингует вовсе: «я тут» про того, кто смотрит, а
  // подсветку комнат некому смотреть. Вернулись — эффект перезапустится и
  // сходит сразу, не дожидаясь минуты.
  useEffect(() => {
    if (!awake) return undefined;
    let alive = true;
    const ping = async () => {
      try {
        const endpoint = await pushEndpoint();
        const q = new URLSearchParams({ chat: '1' });
        if (signedIn) q.set('visible', visible ? '1' : '0');
        const openCh = openChannelsRef.current;
        if (openCh.length === 1) q.set('ch', openCh[0]);
        const res = await pb.send(
          `/api/custom/shoutbox/ping?${q.toString()}`,
          { method: 'POST', body: endpoint ? { endpoint } : {} },
        );
        if (!alive) return;
        setOnline(res?.online ?? 0);
        if (res?.anon_key) setAnonKey(res.anon_key);
        setChanLast(res?.channels ?? {});
        setChanMentions(res?.mentions ?? []);
      } catch {
        /* пинг — не критичный путь, молчим */
      }
    };
    ping();
    const t = setInterval(ping, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [visible, signedIn, awake]);

  // Каналы, которые человек видит прямо сейчас: в комнатах — один активный,
  // в слитной ленте — все сразу. Всё, что видно, считается прочитанным.
  const activeChannelId = activeChannel?.id;
  useEffect(() => {
    const ids = mode === 'rooms'
      ? (activeChannelId ? [activeChannelId] : [])
      : channels.map((c) => c.id);
    openChannelsRef.current = ids;
    if (ids.length === 0) return;
    markChannelsSeen(ids);
    setChannelSeen(loadChannelSeen());
    // Упоминание в открытом канале гасим сразу, не дожидаясь ответа сервера:
    // точка на комнате, в которой сидишь, выглядит поломкой.
    setChanMentions((cur) => cur.filter((id) => !ids.includes(id)));
  }, [mode, activeChannelId, channels, messages.length]);

  // Комнат больше, чем влезает в ряд, — активная легко оказывается за краем
  // (например, последняя по списку, восстановленная из localStorage). Подтягиваем
  // её в видимую часть ряда; block:'nearest' — чтобы не дёргать ничего по вертикали.
  useEffect(() => {
    activePillRef.current?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [active, mode, channels.length]);

  useEffect(() => {
    if (!showWho) return undefined;
    let alive = true;
    const load = () => fetchWho().then((r) => {
      if (alive) {
        setOnline(r.online);
        setWho(r.who);
      }
    });
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [showWho]);

  // Автодополнение @упоминаний. Дебаунс: человек печатает быстрее, чем сервер
  // успевает искать, а каждая буква — это запрос.
  useEffect(() => {
    if (!mentionQ) {
      setMentionOpts([]);
      return undefined;
    }
    let alive = true;
    const t = setTimeout(() => {
      searchMentionUsers(mentionQ).then((u) => { if (alive) setMentionOpts(u); });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [mentionQ]);

  // Автоскролл вниз — только если человек и так стоял внизу. Иначе он читает
  // историю, и уезжающая лента бесит больше, чем пропущенное сообщение.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Лента поехала (подклеили страницу, выпал край окна) — возвращаем на
    // прежнее место ту строку, за которую держится взгляд. Делаем это в
    // layout-эффекте, а не в rAF: rAF успевал показать кадр с уехавшей лентой, и
    // на длинной истории прокрутка «залипала» у верхнего края, продолжая тянуть
    // страницу за страницей.
    if (anchorRef.current) {
      const { id, top } = anchorRef.current;
      anchorRef.current = null;
      const node = el.querySelector<HTMLElement>(`[data-mid="${id}"]`);
      if (node) {
        const now = node.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop += now - top;
        return;
      }
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || loading || loadingOlderRef.current) return;
    const oldest = messages[0];
    if (!oldest) return;
    const gen = feedGenRef.current;
    loadingOlderRef.current = true;
    try {
      const chId = mode === 'rooms' ? activeChannel?.id : undefined;
      const older = await fetchMessages(oldest.created, chId, isDefaultChannel);
      if (gen !== feedGenRef.current) return; // пока грузили, сменили комнату
      if (older.length < SHOUT_PAGE) setHasMore(false);
      // Дедуп по id: страницы могут перекрыться (несколько сообщений с
      // одинаковым created на границе), да и реалтайм мог что-то уже принести.
      const known = new Set(messages.map((m) => m.id));
      const add = older.filter((m) => !known.has(m.id));
      if (!add.length) return;
      anchorOn(oldest.id);
      // Переполнили окно — отцепляем низ. Живой хвост человеку сейчас не нужен,
      // он читает историю; вернётся — подтянем страницами.
      if (messages.length + add.length > WINDOW_MAX) {
        setHasNewer(true);
        // Ref обновляем сразу, не дожидаясь перерисовки: realtime-обработчик
        // может сработать раньше неё и приклеить сообщение за дырой.
        hasNewerRef.current = true;
      }
      setMessages((cur) => {
        const merged = [...add, ...cur];
        return merged.length > WINDOW_MAX ? merged.slice(0, WINDOW_MAX) : merged;
      });
    } catch { /* история недоступна — молча оставляем что есть */ } finally {
      // Флаг снимает только своё поколение: reload уже снял его за нас, и
      // затирать чужую загрузку нельзя.
      if (gen === feedGenRef.current) loadingOlderRef.current = false;
    }
  }, [hasMore, loading, messages, mode, activeChannel?.id, isDefaultChannel, anchorOn]);

  // Обратная сторона окна: человек возвращается вниз, а хвост из памяти выпал.
  const loadNewer = useCallback(async () => {
    if (!hasNewer || loadingNewerRef.current) return;
    const newest = messages[messages.length - 1];
    if (!newest) return;
    const gen = feedGenRef.current;
    loadingNewerRef.current = true;
    try {
      const chId = mode === 'rooms' ? activeChannel?.id : undefined;
      const page = await fetchNewer(newest.created, chId, isDefaultChannel);
      if (gen !== feedGenRef.current) return;
      // Неполная страница — это и есть конец: лента снова прицеплена к живому
      // хвосту, дальше её ведёт realtime.
      if (page.length < SHOUT_PAGE) {
        setHasNewer(false);
        hasNewerRef.current = false;
      }
      const known = new Set(messages.map((m) => m.id));
      const add = page.filter((m) => !known.has(m.id));
      if (!add.length) return;
      anchorOn(newest.id);
      // Симметрично: переполнили окно — сверху история выпала, и её снова можно
      // тянуть прокруткой вверх.
      if (messages.length + add.length > WINDOW_MAX) setHasMore(true);
      setMessages((cur) => {
        const merged = [...cur, ...add];
        return merged.length > WINDOW_MAX ? merged.slice(merged.length - WINDOW_MAX) : merged;
      });
    } catch { /* хвост недоступен — попробуем на следующей прокрутке */ } finally {
      if (gen === feedGenRef.current) loadingNewerRef.current = false;
    }
  }, [hasNewer, messages, mode, activeChannel?.id, isDefaultChannel, anchorOn]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = fromBottom < 60;
    setAtBottom((cur) => (cur === atBottomRef.current ? cur : atBottomRef.current));
    // Пороги разные: историю тянем у самого края, хвост — заранее, чтобы
    // возвращение вниз не упиралось в пустоту на каждой странице.
    if (el.scrollTop <= 80) loadOlder();
    if (fromBottom < 400) loadNewer();
  }, [loadOlder, loadNewer]);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    // Лента отцеплена от хвоста — прокруткой до конца окна памяти живых
    // сообщений не достать. Забираем свежую страницу: это одна выдача вместо
    // десятка страниц догона.
    if (hasNewerRef.current) {
      reload();
      return;
    }
    const el = listRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [reload]);

  // ---------------------------------------------------------------- отправка

  const pickImage = (f: File | null) => {
    if (!f) {
      setImage(null);
      return;
    }
    if (f.size > IMAGE_MAX_BYTES) {
      setError('Image is over 2 MB. This chat is for reactions, not for canvases.');
      return;
    }
    setImage(f);
  };

  const changeText = (v: string) => {
    const next = v.slice(0, MAX_LEN);
    setText(next);
    setMentionQ(MENTION_TAIL.exec(next)?.[1] ?? '');
  };

  /** Дописать @ник в поле ввода: из автодополнения или кликом по нику в ленте.
   *  Без этого упоминания невидимы — про них надо было бы догадаться. */
  const insertMention = useCallback((username: string) => {
    setText((cur) => {
      const base = MENTION_TAIL.test(cur) ? cur.replace(MENTION_TAIL, '') : cur;
      const sep = base && !base.endsWith(' ') ? ' ' : '';
      return `${base}${sep}@${username} `.slice(0, MAX_LEN);
    });
    setMentionQ('');
    inputRef.current?.focus();
  }, []);

  const send = async () => {
    const t = text.trim();
    // Правка идёт своей ручкой и ничего не создаёт: ни нового сообщения, ни
    // уведомлений об упоминаниях. Картинку правка не трогает — поэтому пустой
    // текст допустим ровно тогда, когда картинка у сообщения уже есть.
    if (editing) {
      if (sending || (!t && !editing.image)) return;
      setSending(true);
      setError('');
      try {
        await editOwnMessage(editing.id, t, loadDelPasses()[editing.id]);
        setMessages((cur) => cur.map((x) => (
          x.id === editing.id ? { ...x, text: t, edited: true } : x)));
        cancelEdit();
      } catch (e) {
        const msg = (e as { response?: { message?: string } })?.response?.message;
        setError(msg || 'Edit not saved. Try again.');
      } finally {
        setSending(false);
      }
      return;
    }
    if ((!t && !image) || sending) return;
    setSending(true);
    setError('');
    // Пароль на удаление ставим гостю всегда и молча: без него удалить своё
    // сообщение можно только с того же IP и только неделю.
    const delPass = signedIn ? undefined : makeDelPass();
    try {
      await postMessageV2(t, {
        channel: active || undefined,
        replyTo: replyTo?.id,
        anon: signedIn ? anon : undefined,
        delPass,
        image,
      });
      // Пароль привязываем к последнему своему сообщению после того, как оно
      // приедет по realtime: id пост-ручка не возвращает наружу типизированно,
      // а гадать не нужно — свои сообщения находим по anon_key.
      if (delPass) pendingPass.current = delPass;
      setText('');
      setMentionQ('');
      setReplyTo(null);
      setImage(null);
      if (fileRef.current) fileRef.current.value = '';
      atBottomRef.current = true;
      // Писали, стоя в истории с отцепленным хвостом: своё сообщение realtime в
      // такую ленту не принесёт, поэтому возвращаемся к живому хвосту сами.
      if (hasNewerRef.current) reload();
    } catch (e) {
      const msg = (e as { response?: { message?: string } })?.response?.message;
      setError(msg || 'Message not sent. Try again.');
    } finally {
      setSending(false);
    }
  };

  // Пароль ждёт своего сообщения: как только оно приходит по realtime, привязываем.
  const pendingPass = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingPass.current || !anonKey) return;
    const mine = [...messages].reverse().find((m) => m.anon_key === anonKey);
    if (mine) {
      rememberDelPass(mine.id, pendingPass.current);
      pendingPass.current = null;
    }
  }, [messages, anonKey]);

  // passes передаётся снаружи: это localStorage + JSON.parse, и на длинной
  // ленте чтение на КАЖДУЮ строку заметно дороже самой проверки.
  const canDelete = useCallback((m: ShoutMessage, passes: Record<string, string>): boolean => {
    if (m.kind === 'system') return false;
    if (signedIn && user && m.user === user.id) return true;
    if (anonKey && m.anon_key === anonKey) return true;
    return Boolean(passes[m.id]);
  }, [signedIn, user, anonKey]);

  const removeOwn = useCallback(async (m: ShoutMessage) => {
    try {
      await deleteOwnMessage(m.id, loadDelPasses()[m.id]);
      setMessages((cur) => cur.filter((x) => x.id !== m.id));
    } catch {
      setError('Could not delete — the message may no longer count as yours.');
    }
  }, []);

  // ------------------------------------------------------------- модерация

  // Кнопки видит только модератор. Обе спрашивают подтверждение: удаление
  // необратимо, а мут бьёт по живому человеку — случайный тык по соседней
  // иконке на телефоне не должен ничего этого делать.
  const modRemove = useCallback(async (m: ShoutMessage) => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await deleteMessage(m.id);
      setMessages((cur) => cur.filter((x) => x.id !== m.id));
    } catch {
      setError('Could not delete the message.');
    }
  }, []);

  const modMute = useCallback(async (m: ShoutMessage) => {
    if (!window.confirm('Mute the author of this message for 24 hours?')) return;
    try {
      await muteMessageSource(m.id);
      setError('Author muted for 24 hours.');
    } catch {
      setError('Could not mute the author.');
    }
  }, []);

  const togglePin = useCallback(async (m: ShoutMessage) => {
    try {
      await pinMessage(m.id, !m.pinned);
      setMessages((cur) => cur.map((x) => (x.id === m.id ? { ...x, pinned: !m.pinned } : x)));
    } catch {
      setError('Could not pin the message.');
    }
  }, []);

  // ------------------------------------------------------------ правка своего

  // Право на правку то же, что на удаление: своё сообщение, свой anon_key или
  // пароль гостя. Системные не правит никто, включая модератора: они не чьи-то
  // слова, а факт (вышла игра), и переписывать факт задним числом незачем.
  const canEdit = useCallback(
    (m: ShoutMessage, passes: Record<string, string>): boolean => (
      m.kind !== 'system' && canDelete(m, passes)
    ),
    [canDelete],
  );

  // Обработчики строки — стабильные: MessageRow сравнивает пропсы, и новая
  // функция на каждый рендер отменила бы всю мемоизацию ленты.
  const toggleTouched = useCallback((m: ShoutMessage) => {
    setTouched((cur) => (cur === m.id ? null : m.id));
  }, []);
  const replyToMessage = useCallback((m: ShoutMessage) => {
    setReplyTo(m);
    inputRef.current?.focus();
  }, []);

  // Правим в общем поле ввода, а не отдельным окошком внутри ленты: там уже
  // живут счётчик длины, автодополнение @ников и Ctrl+Enter — второй такой же
  // редактор пришлось бы делать заново и потом чинить дважды.
  const startEdit = useCallback((m: ShoutMessage) => {
    setReplyTo(null);
    setEditing(m);
    setText(m.text);
    setMentionQ('');
    inputRef.current?.focus();
  }, []);

  const cancelEdit = () => {
    setEditing(null);
    setText('');
    setMentionQ('');
  };

  // ---------------------------------------------------- карточка собеседника

  const openProfile = useCallback((e: React.MouseEvent<HTMLElement>, m: ShoutMessage) => {
    const u = m.expand?.user;
    if (!u) return;
    // Флаг выключен — возвращаемся к старому поведению: клик по нику просто
    // подставляет @упоминание.
    if (!PROFILE_POPOVER) {
      if (u.username) insertMention(u.username);
      return;
    }
    setProfileAnchor(e.currentTarget);
    const cached = profileCache.current[u.id];
    if (cached) { setProfile(cached); return; }
    setProfile(null);
    fetchProfile(u.id).then((p) => {
      if (!p) return;
      profileCache.current[u.id] = p;
      setProfile(p);
    });
  }, [insertMention]);

  // ---------------------------------------------------------------- рендер

  const changeMode = (m: ChannelMode) => {
    setMode(m);
    localStorage.setItem(MODE_KEY, m);
    // В комнатах надо стоять в конкретной; в слитной ленте — «всё сразу».
    // Возврат в комнаты — в ту же, где сидел до слитной ленты.
    const saved = localStorage.getItem(CHAN_KEY);
    const back = channels.some((c) => c.slug === saved) ? saved! : channels[0]?.slug || '';
    setActive(m === 'rooms' ? (active || back) : '');
  };

  const openChannel = (slug: string) => {
    setActive(slug);
    localStorage.setItem(CHAN_KEY, slug);
  };

  const toggleVisible = () => {
    const v = !visible;
    setVisible(v);
    localStorage.setItem(VISIBLE_KEY, v ? '1' : '0');
  };

  const channelTitle = useCallback(
    (id?: string) => channels.find((c) => c.id === id)?.title,
    [channels],
  );

  // Лента собирается отдельно от остального экрана и запоминается. Здесь
  // считается только то, чего строка не знает про себя сама, — соседство:
  // черта суток, склейка блока, смена комнаты. Всё остальное — внутри
  // MessageRow, и он memo, так что перерисовка экрана (буква в поле ввода,
  // ответ на пинг присутствия) до строк не доходит.
  const feed = useMemo(() => {
    const passes = loadDelPasses();
    return messages.map((m, i) => {
      const prev = messages[i - 1];
      const unread = m.id === firstUnreadId;
      return (
        <MessageRow
          key={m.id}
          m={m}
          daySepLabel={i === 0 || !sameDay(prev.created, m.created)
            ? dayLabel(m.created)
            : undefined}
          // Ярлык комнаты в слитной ленте ставим только на смене комнаты: одна
          // и та же метка у каждой строки подряд ничего не сообщает, а глазу
          // мешает. Дальше действует «пока не сказано иное — та же комната».
          chTitle={mode === 'merged' && (i === 0 || (prev.channel || '') !== (m.channel || ''))
            ? channelTitle(m.channel)
            : undefined}
          unread={unread}
          // Склейка: то же авторство, та же комната, недолгая пауза. Ответ
          // всегда начинает новый блок — у него своя шапка с цитатой, и без
          // подписи автора она повисает в воздухе. Черта «новое» тоже рвёт
          // блок: склеивать через неё значит спрятать её в середину чужого.
          grouped={!unread && sameRun(prev, m)}
          touched={touched === m.id}
          isModerator={isModerator}
          canEdit={canEdit(m, passes)}
          canDelete={canDelete(m, passes)}
          meUsername={user?.username}
          onTouch={toggleTouched}
          onReply={replyToMessage}
          onEdit={startEdit}
          onDeleteOwn={removeOwn}
          onTogglePin={togglePin}
          onModDelete={modRemove}
          onModMute={modMute}
          onOpenProfile={openProfile}
          onMention={insertMention}
        />
      );
    });
  }, [
    messages, touched, firstUnreadId, isModerator, mode, user?.username,
    channelTitle, canEdit, canDelete, toggleTouched, replyToMessage, startEdit,
    removeOwn, togglePin, modRemove, modMute, openProfile, insertMention,
  ]);

  return (
    // Оболочка мессенджера: шапка комнат сверху, лента посередине (единственное
    // место, которое прокручивается), поле ввода снизу. Высоту задаёт App: на
    // этом маршруте она ровно в экран, поэтому здесь достаточно flex:1 и
    // minHeight:0 — без него лента растёт вниз вместо прокрутки.
    <Box sx={{
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      maxWidth: 900,
      mx: 'auto',
      // На широком экране чат — карточка с тонкими краями; на телефоне краёв
      // нет вовсе, там каждый пиксель ширины идёт под текст.
      borderLeft: { xs: 0, md: 1 },
      borderRight: { xs: 0, md: 1 },
      borderColor: { md: 'divider' },
    }}>
      {/* Шапка: комнаты слева, действия справа. Комнаты прокручиваются вбок —
          на телефоне их больше, чем влезает, а перенос на вторую строку съедал
          бы высоту ленты. */}
      <Box sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: { xs: 0.75, sm: 1.25 },
        minHeight: 48,
        borderBottom: 1,
        borderColor: 'divider',
        // Полупрозрачное стекло: под шапкой уезжает лента, и край текста,
        // проходящий под ней, выглядит живее, чем упирающийся в глухую полосу.
        bgcolor: 'rgba(21,21,21,0.72)',
        backdropFilter: 'blur(12px)',
      }}>
        <Box sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          flex: 1,
          minWidth: 0,
          overflowX: 'auto',
          py: 0.75,
          // Полоса прокрутки под пилюлями крадёт высоту и мозолит глаза.
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}>
          {mode === 'rooms' ? (
            channels.map((c) => {
              const isActive = c.slug === active;
              const mentioned = !isActive && chanMentions.includes(c.id);
              const fresh = !isActive && !mentioned && channelHasNew(c.id);
              return (
                <Box
                  key={c.id}
                  component="button"
                  type="button"
                  ref={isActive ? activePillRef : undefined}
                  onClick={() => openChannel(c.slug)}
                  sx={{
                    // Три состояния, и разница между ними намеренно резкая: тебя
                    // звали — заметно, просто написали — еле-еле, ты тут —
                    // залитая пилюля. Счётчиков нет: ради числа пришлось бы
                    // держать прочтение на человека×канал в базе, а отвечает
                    // оно на тот же вопрос, что и точка.
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    flexShrink: 0,
                    px: 1.25,
                    py: 0.5,
                    borderRadius: 999,
                    border: 1,
                    borderColor: mentioned ? 'error.main' : isActive ? 'primary.main' : 'transparent',
                    bgcolor: isActive ? 'rgba(252,52,71,0.16)' : 'transparent',
                    color: isActive || fresh || mentioned ? 'text.primary' : 'text.secondary',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: isActive || fresh || mentioned ? 700 : 500,
                    lineHeight: 1.4,
                    whiteSpace: 'nowrap',
                    cursor: 'pointer',
                    transition: 'background-color .15s, color .15s',
                    '&:hover': { bgcolor: isActive ? 'rgba(252,52,71,0.22)' : 'rgba(255,255,255,0.06)' },
                  }}
                >
                  <Box component="span" sx={{ opacity: 0.45 }}>#</Box>
                  {c.title}
                  {(mentioned || fresh) && (
                    <Box sx={{
                      width: mentioned ? 'auto' : 6,
                      height: mentioned ? 'auto' : 6,
                      px: mentioned ? 0.5 : 0,
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                      lineHeight: '14px',
                      bgcolor: mentioned ? 'error.main' : 'primary.main',
                      color: mentioned ? '#fff' : 'transparent',
                    }}>
                      {mentioned ? '@' : ''}
                    </Box>
                  )}
                </Box>
              );
            })
          ) : (
            <Typography sx={{ fontSize: 13, fontWeight: 700, px: 0.5, whiteSpace: 'nowrap' }}>
              All rooms
            </Typography>
          )}
        </Box>

        <Tooltip title={mode === 'merged'
          ? 'Now: one feed, each message tagged with its channel. Switch to separate rooms'
          : 'Now: separate rooms. Switch to a single feed'}
        >
          <IconButton size="small" onClick={() => changeMode(mode === 'merged' ? 'rooms' : 'merged')}>
            {mode === 'merged' ? <ViewAgendaOutlinedIcon fontSize="small" /> : <ViewListOutlinedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>

        <PushBell signedIn={signedIn} onMessage={setError} />

        {/* Счётчик — часть кнопки: живая зелёная точка с числом читается
            мгновенно, отдельная цифра рядом с иконкой выглядела мусором. */}
        <Tooltip title="Who is here now">
          <Box
            component="button"
            type="button"
            onClick={(e: React.MouseEvent<HTMLElement>) => setWhoAnchor(showWho ? null : e.currentTarget)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0,
              px: 1, py: 0.5, borderRadius: 999, border: 0,
              bgcolor: showWho ? 'rgba(255,255,255,0.09)' : 'transparent',
              color: 'text.secondary', fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
            }}
          >
            <Box sx={{
              width: 7, height: 7, borderRadius: '50%',
              bgcolor: online > 0 ? '#3fb950' : 'text.disabled',
              boxShadow: online > 0 ? '0 0 6px rgba(63,185,80,0.8)' : 'none',
            }} />
            {online}
            <PeopleOutlineIcon sx={{ fontSize: 15, opacity: 0.7 }} />
          </Box>
        </Tooltip>
      </Box>

      {/* «Кто сейчас здесь» */}
      <Popover
        open={showWho}
        anchorEl={whoAnchor}
        onClose={() => setWhoAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { p: 1.5, width: 280, maxWidth: '92vw', borderRadius: 2 } } }}
      >
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle2" sx={{ flex: 1 }}>
            Here now: {online}
          </Typography>
          {signedIn && (
            <Tooltip title={visible ? 'You are shown in the list' : 'You are hidden — counted only'}>
              <IconButton size="small" onClick={toggleVisible}>
                {visible ? <VisibilityOutlinedIcon fontSize="small" /> : <VisibilityOffOutlinedIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        {who.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            Nobody is showing their name — and that's fine.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {who.map((w) => (
              <Chip
                key={w.id}
                size="small"
                avatar={<Avatar src={avatarUrlOf(w)}>{w.name?.[0]}</Avatar>}
                label={w.name}
                sx={w.mod ? { color: 'error.main', borderColor: 'error.main' } : undefined}
                variant="outlined"
              />
            ))}
          </Stack>
        )}
      </Popover>

      {/* Лента. Обёртка нужна ради кнопки «вниз»: она висит над лентой, но не
          прокручивается вместе с ней. */}
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <Box
        ref={listRef}
        onScroll={onScroll}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          px: { xs: 0.5, sm: 1 },
          py: 1,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* mt:auto прижимает короткую ленту к полю ввода: в пустой комнате
            разговор должен начинаться снизу, как в любом мессенджере, а не
            висеть под шапкой посреди пустого экрана. Когда сообщений много,
            авто-отступ схлопывается сам и ничего не мешает прокрутке. */}
        <Box sx={{ mt: 'auto' }}>
        {loading && messages.length === 0 ? (
          <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress size={24} /></Stack>
        ) : messages.length === 0 ? (
          <Stack alignItems="center" spacing={1} sx={{ py: 6, opacity: 0.6 }}>
            <ChatBubbleOutlineIcon sx={{ fontSize: 32 }} />
            <Typography variant="body2" color="text.secondary">
              Nothing here yet. Be the first.
            </Typography>
          </Stack>
        ) : (
          feed
        )}
        </Box>
      </Box>

        {/* «Вниз» — только когда человек ушёл в историю. Иначе кнопка просто
            закрывала бы последнюю строку собой. */}
        {(!atBottom || hasNewer) && messages.length > 0 && (
          <Box
            component="button"
            type="button"
            onClick={jumpToBottom}
            sx={{
              position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 0.5,
              px: 1.25, py: 0.5, borderRadius: 999,
              border: 1, borderColor: 'divider', bgcolor: 'background.paper',
              color: 'text.secondary', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
              cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
              '&:hover': { color: 'text.primary' },
            }}
          >
            <KeyboardArrowDownIcon sx={{ fontSize: 16 }} />
            Jump to latest
          </Box>
        )}
      </Box>

      {/* Ввод */}
      <Box sx={{
        flexShrink: 0,
        px: { xs: 0.75, sm: 1.25 },
        pt: 0.75,
        pb: 1,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'background.default',
      }}>
        {/* Полоски над полем: ответ, правка, картинка, подсказка @ников. Все
            одного покроя — узкая строка с иконкой слева и крестиком справа. */}
        {replyTo && (
          <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
            <ReplyOutlinedIcon sx={{ fontSize: 15, color: 'text.secondary' }} />
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
              Replying to {replyTo.expand?.user
                ? (replyTo.expand.user.name || replyTo.expand.user.username || 'User')
                : (replyTo.anon_key ? anonIdentity(replyTo.anon_key).name : 'Anonymous')}
              : {replyTo.text?.slice(0, 60) || 'image'}
            </Typography>
            <IconButton size="small" sx={{ p: 0.25 }} onClick={() => setReplyTo(null)}>
              <CloseIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Stack>
        )}

        {editing && (
          <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
            <EditOutlinedIcon sx={{ fontSize: 15, color: 'warning.main' }} />
            <Typography variant="caption" color="warning.main" noWrap sx={{ flex: 1 }}>
              Editing your message — Esc to cancel
            </Typography>
            <IconButton size="small" sx={{ p: 0.25 }} onClick={cancelEdit}>
              <CloseIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Stack>
        )}

        {image && (
          <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
            <Box component="img" src={URL.createObjectURL(image)} alt=""
              sx={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 1.5 }} />
            <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
              {image.name}
            </Typography>
            <IconButton size="small" sx={{ p: 0.25 }} onClick={() => pickImage(null)}>
              <CloseIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Stack>
        )}

        {mentionOpts.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mb: 0.5, flexWrap: 'wrap', gap: 0.5 }}>
            {mentionOpts.map((mu) => (
              <Chip
                key={mu.id}
                size="small"
                avatar={<Avatar src={avatarUrlOf(mu)}>{(mu.name || mu.username)[0]}</Avatar>}
                label={`@${mu.username}`}
                onClick={() => insertMention(mu.username)}
              />
            ))}
          </Stack>
        )}

        {/* Поле ввода — одна пилюля: слева анонимность и картинка, справа
            отправка. Отдельная строка с тумблером и счётчиком отсюда убрана: на
            телефоне она съедала высоту ленты ради двух слов. */}
        <Box sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 0.25,
          px: 0.5,
          py: 0.25,
          borderRadius: 3,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'background.paper',
          transition: 'border-color .15s',
          '&:focus-within': { borderColor: 'primary.main' },
        }}>
          {signedIn && (
            <Tooltip title={anon ? `Posting as ${anonIdentity(anonKey).name} — tap to sign it` : 'Post anonymously'}>
              <IconButton
                size="small"
                onClick={() => setAnon((v) => !v)}
                sx={{ color: anon ? 'primary.main' : 'text.secondary', mb: 0.25 }}
              >
                <MasksOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {signedIn && (
            <Tooltip title="Image up to 2 MB">
              <IconButton
                size="small"
                onClick={() => fileRef.current?.click()}
                sx={{ color: 'text.secondary', mb: 0.25 }}
              >
                <ImageOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <TextField
            fullWidth
            multiline
            maxRows={5}
            variant="standard"
            inputRef={inputRef}
            placeholder={
              mode === 'rooms' && activeChannel
                ? `Message #${activeChannel.title}…`
                : 'Write a message…'
            }
            value={text}
            onChange={(e) => changeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
              if (e.key === 'Escape' && editing) {
                e.preventDefault();
                cancelEdit();
              }
            }}
            slotProps={{ input: { disableUnderline: true } }}
            sx={{
              // 16px — не эстетика, а требование iOS: при меньшем шрифте Safari
              // зумит страницу на фокусе поля, и чат уезжает за край экрана.
              '& .MuiInputBase-root': { fontSize: 16, px: 0.75, py: 0.75 },
            }}
          />
          {/* Счётчик появляется только на подходе к пределу: постоянный «0/300»
              — шум, а вот «осталось 20» вовремя спасает мысль. */}
          {text.length > MAX_LEN - 60 && (
            <Typography
              variant="caption"
              sx={{ alignSelf: 'flex-end', mb: 1, mr: 0.5, fontSize: 11, color: text.length >= MAX_LEN ? 'error.main' : 'text.secondary' }}
            >
              {MAX_LEN - text.length}
            </Typography>
          )}
          <IconButton
            onClick={send}
            disabled={sending || (!text.trim() && !image)}
            sx={{
              width: 34, height: 34, mb: 0.25,
              transition: 'background-color .15s',
              ...(sending || (!text.trim() && !image)
                ? { color: 'text.disabled' }
                : {
                  bgcolor: 'primary.main',
                  color: '#fff',
                  '&:hover': { bgcolor: 'primary.dark' },
                }),
            }}
          >
            {sending ? <CircularProgress size={18} /> : <SendIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        </Box>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          hidden
          onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
        />

        {/* Гостю важно знать, под каким именем он говорит и что сможет стереть
            своё сообщение. Залогиненному то же самое сообщает иконка маски. */}
        {!signedIn && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 0.5, px: 1, fontSize: 11, opacity: 0.8 }}
          >
            Posting as {anonIdentity(anonKey).name} — you can delete your own message.
          </Typography>
        )}
      </Box>

      {/* Карточка собеседника. Показывает ровно то, что о человеке известно:
          аватарка, ник, с какого дня он тут. Сознательно бедная — профили на
          сайте пока пустые, и притворяться, что это не так, смысла нет. Место
          заготовлено под любимые игры и билды, когда они у профиля появятся. */}
      <Popover
        open={Boolean(profileAnchor)}
        anchorEl={profileAnchor}
        onClose={() => setProfileAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 1.5, maxWidth: 260 } } }}
      >
        {profile ? (
          <Stack spacing={1}>
            <Stack direction="row" spacing={1.25} alignItems="center">
              <Avatar src={avatarUrlOf(profile)} sx={{ width: 40, height: 40 }}>
                {(profile.name || profile.username || '?')[0]}
              </Avatar>
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  variant="subtitle2"
                  noWrap
                  sx={{ color: profile.isModerator ? 'error.main' : nickColor(profile.id) }}
                >
                  {profile.name || profile.username || 'User'}
                </Typography>
                {profile.username && (
                  <Typography variant="caption" color="text.secondary" noWrap display="block">
                    @{profile.username}
                  </Typography>
                )}
              </Box>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {profile.isModerator ? 'Moderator · ' : ''}
              Here since {new Date(profile.created.replace(' ', 'T')).toLocaleDateString()}
            </Typography>
            {profile.username && (
              <Button
                size="small"
                variant="outlined"
                onClick={() => {
                  insertMention(profile.username as string);
                  setProfileAnchor(null);
                }}
              >
                Mention
              </Button>
            )}
          </Stack>
        ) : (
          <Typography variant="caption" color="text.secondary">Loading…</Typography>
        )}
      </Popover>

      <Snackbar
        open={Boolean(error)}
        autoHideDuration={5000}
        onClose={() => setError('')}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="warning" onClose={() => setError('')}>{error}</Alert>
      </Snackbar>
    </Box>
  );
}
