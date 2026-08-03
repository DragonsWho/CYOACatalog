// Дровер шаутбокса. Спека: wiki/components/shoutbox-spec.md.
// Стиль — минималистичный тёмный, в тон каталога: ноль визуального веса,
// никаких плавающих пузырей; паттерн правого дровера как у компаньона.

import React, { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Avatar, Box, Chip, CircularProgress, IconButton, SwipeableDrawer, TextField, Tooltip, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import CheckIcon from '@mui/icons-material/Check';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import ReplyIcon from '@mui/icons-material/Reply';
import { Link } from 'react-router-dom';
import { AuthContext } from '../../pocketbase/pocketbase';
import { absoluteTime } from '../CyoaPage/Comments/relativeTime';
import { anonIdentity } from './anonIdentity';
import {
  SHOUT_PAGE, ShoutMessage, ShoutReply, MentionUser, avatarUrlOf, deleteMessage, fetchMessages,
  muteMessageSource, postMessage, searchMentionUsers, subscribeMessages, unmuteMessageSource,
} from './shoutboxApi';

const MAX_LEN = 300;

// @упоминания: те же правила, что в комментариях (main.go mentionRE) — «@» на
// границе слова + 2..30 символов [A-Za-z0-9._-]. group1 = граница, group2 = ник.
const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9._-]{2,30})/g;

/** Рендер текста сообщения с подсветкой @упоминаний. Возвращает React-узлы
 *  (текст экранируется React — ни HTML, ни CSS-инъекций). Своё упоминание —
 *  ярче. */
function renderMessageText(text: string, myUsername?: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const pre = m[1];
    const uname = m[2];
    const at = m.index + pre.length; // индекс самого '@'
    if (at > last) out.push(text.slice(last, at));
    const mine = !!myUsername && uname.toLowerCase() === myUsername.toLowerCase();
    out.push(
      <Box
        component="span"
        key={`m${key++}`}
        sx={{
          px: 0.4, borderRadius: 0.5, fontWeight: 600,
          color: mine ? '#fff' : 'primary.light',
          bgcolor: mine ? 'rgba(120,110,220,0.4)' : 'rgba(120,130,220,0.16)',
        }}
      >
        @{uname}
      </Box>,
    );
    last = at + 1 + uname.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Имя автора в цитате ответа: у залогиненного — name, у анона — псевдо-ник. */
function replyDisplayName(r: ShoutReply): string {
  return r.name || anonIdentity(r.anon_key).name;
}

/** Активный токен @упоминания под кареткой (для автодополнения) или null. */
function activeMention(val: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && /[a-zA-Z0-9._-]/.test(val[i])) i--;
  if (i < 0 || val[i] !== '@') return null;
  const before = i > 0 ? val[i - 1] : '';
  if (before && /[\w@]/.test(before)) return null; // '@' должен быть на границе слова
  const query = val.slice(i + 1, caret);
  if (query.length > 30) return null;
  return { start: i, query };
}

/** Микро-формат времени: «now», «5m», «3h», «2d». Tooltip даёт абсолютное. */
function shortTime(dateStr: string): string {
  const t = new Date(dateStr.replace(' ', 'T')).getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Цвет ника залогиненного — та же палитра, что у анонов, по id юзера. */
function userColor(id: string): string {
  return anonIdentity(id).color;
}

/** Модераторы — фирменным красным (выделяются в ленте), поверх палитры.
 *  Тот же красный, что у модеров в комментариях (CommentNode MOD_RED). */
const MOD_COLOR = '#e8484e';

interface ShoutboxProps {
  open: boolean;
  onClose: () => void;
  online: number;
  /** Свой anon_key (из ping) — анону показываем его псевдо-ник и метим «you». */
  myAnonKey?: string;
  /** База ссылок на игры: на лабе остаёмся внутри лаборатории. */
  gameLinkBase?: string;
}

export default function Shoutbox({ open, onClose, online, myAnonKey = '', gameLinkBase = '/game' }: ShoutboxProps) {
  const { signedIn, user } = useContext(AuthContext);
  const isModerator = !!user?.isModerator;

  const [messages, setMessages] = useState<ShoutMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [showJump, setShowJump] = useState(false);
  // Модераторские действия: двухшаговое подтверждение + локальная память мутов
  // (какие источники замучены В ЭТОЙ сессии — сервер состояние не отдаёт, v1).
  const [confirm, setConfirm] = useState<{ id: string; action: 'delete' | 'mute' } | null>(null);
  const [mutedSources, setMutedSources] = useState<Set<string>>(new Set());
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Ответы: на что отвечаем + краткая подсветка сообщения-цели при переходе.
  const [replyTo, setReplyTo] = useState<{ id: string; name: string; text: string } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  // @упоминания: кандидаты автодополнения + активный элемент + токен под кареткой.
  const [mentions, setMentions] = useState<MentionUser[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionTokenRef = useRef<{ start: number; query: string } | null>(null);
  const mentionReqRef = useRef(0); // гвард гонки async-поиска
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const blurTimer = useRef<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const forceScrollRef = useRef(false);
  // Пагинация истории вверх: есть ли ещё старее + защита от параллельных загрузок.
  const hasMoreRef = useRef(true);
  const loadingOlderRef = useRef(false);
  // Якорь позиции при добавлении старых сверху: держим видимое сообщение на месте.
  const anchorRef = useRef<{ h: number; t: number } | null>(null);

  // Гасим отложенные таймеры (вспышка цитаты / закрытие popup) при размонтаже.
  useEffect(() => () => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    if (blurTimer.current) window.clearTimeout(blurTimer.current);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Прокрутка к низу ПОСЛЕ коммита DOM. Раньше scrollToBottom вызывался в
  // одиночном rAF, который успевал сработать до вёрстки нового (длинного)
  // сообщения → scrollHeight был старый, лента недокручивала (видна была лишь
  // пара строк) и при открытии мигали ранние сообщения. useLayoutEffect на
  // messages бежит после коммита, когда высота уже финальная.
  const wantScrollRef = useRef<false | 'auto' | 'smooth'>(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Подгрузили старые сверху → восстанавливаем позицию (высота выросла на
    // величину добавленного), чтобы лента не прыгнула под курсором.
    if (anchorRef.current) {
      el.scrollTop = el.scrollHeight - anchorRef.current.h + anchorRef.current.t;
      anchorRef.current = null;
      return;
    }
    const mode = wantScrollRef.current;
    if (!mode) return;
    wantScrollRef.current = false;
    el.scrollTo({ top: el.scrollHeight, behavior: mode });
    atBottomRef.current = true;
    setShowJump(false);
  }, [messages]);

  // Аналитика открытия — ровно на переходе в open, не на каждом флипе видимости.
  useEffect(() => {
    if (open) window.gtag?.('event', 'shoutbox_opened');
  }, [open]);

  // Активна ли вкладка (Page Visibility API). Живой поток чата держим только при
  // visible — см. эффект ниже.
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState === 'visible');
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Живой поток держим ТОЛЬКО когда дровер открыт И вкладка активна (visible).
  // Свернул/ушёл на другую вкладку → трубу ЗАКРЫВАЕМ (cleanup ниже). Иначе
  // Cloudflare всё равно рвёт её по ~100с idle-таймауту и SDK лезет
  // переподключаться — тот самый churn, что клал прод. Вернулся → дозагружаем
  // историю (catch-up через fetchMessages) и подписываемся заново. Так «висящих
  // труб» в каждый момент — только у передних активных вкладок с открытым чатом.
  useEffect(() => {
    if (!open || !visible) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    let subTimer: number | null = null;

    hasMoreRef.current = true;
    loadingOlderRef.current = false;
    anchorRef.current = null;
    setLoadingOlder(false);
    fetchMessages()
      .then((items) => {
        if (cancelled) return;
        hasMoreRef.current = items.length >= SHOUT_PAGE;
        wantScrollRef.current = 'auto';
        setMessages(items);
      })
      .catch(() => setError('Failed to load chat.'));

    // Джиттер перед подпиской: когда пачка вкладок просыпается разом (разбудили
    // ноут, вернулись в браузер), связи открываются размазанно, а не в одну
    // секунду — не создаём «стадо» реконнектов. Ленту уже показал fetch выше,
    // задержка до живых апдейтов незаметна.
    subTimer = window.setTimeout(() => {
      subscribeMessages((action, record) => {
        setMessages((prev) => {
          if (action === 'delete') return prev.filter((m) => m.id !== record.id);
          if (action === 'update') return prev.map((m) => (m.id === record.id ? record : m));
          // -998: держим в памяти столько же, сколько живёт по ретенции (999),
          // чтобы новое сообщение не отрезало подгруженную вверх историю.
          if (action === 'create') return [...prev.slice(-998), record];
          return prev;
        });
        if (action === 'create') {
          if (atBottomRef.current || forceScrollRef.current) {
            forceScrollRef.current = false;
            wantScrollRef.current = 'smooth';
          } else {
            setShowJump(true);
          }
        }
      }).then((u) => {
        if (cancelled) u();
        else unsub = u;
      }).catch(() => { /* реалтайм упал — лента останется статичной */ });
    }, Math.random() * 1500);

    return () => {
      cancelled = true;
      if (subTimer !== null) window.clearTimeout(subTimer);
      unsub?.();
    };
  }, [open, visible, scrollToBottom]);

  // Кнопка/жест «назад» закрывает чат, а не уводит со страницы: на открытии
  // кладём запись в history, popstate = закрытие. Ручное закрытие запись НЕ
  // выталкивает (back() из cleanup ломал бы переходы по ссылкам из чата) —
  // одна «холостая» запись остаётся, повторное открытие её переиспользует.
  useEffect(() => {
    if (!open) return;
    if (!(window.history.state && window.history.state.shoutbox)) {
      window.history.pushState({ ...window.history.state, shoutbox: true }, '');
    }
    const onPop = () => onClose();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, onClose]);

  // Подгрузка страницы старее самого верхнего сообщения. Якорим позицию в
  // layout-эффекте, чтобы контент не прыгнул. Гвард hasMore/loading — от дублей.
  const loadOlder = async () => {
    if (loadingOlderRef.current || !hasMoreRef.current) return;
    const oldest = messages[0];
    if (!oldest) return;
    const el = listRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const older = await fetchMessages(oldest.created);
      if (older.length < SHOUT_PAGE) hasMoreRef.current = false;
      if (older.length) {
        anchorRef.current = { h: el?.scrollHeight ?? 0, t: el?.scrollTop ?? 0 };
        setMessages((prev) => [...older, ...prev]);
      }
    } catch { /* история недоступна — молча оставляем что есть */ } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottomRef.current) setShowJump(false);
    // Близко к верху — тянем историю (если ещё есть и не грузим прямо сейчас).
    if (el.scrollTop < 80 && hasMoreRef.current && !loadingOlderRef.current) loadOlder();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      await postMessage(text, replyTo?.id);
      setDraft('');
      setReplyTo(null);
      setMentions([]);
      forceScrollRef.current = true;
      window.gtag?.('event', 'shoutbox_posted');
    } catch (e: any) {
      setError(e?.response?.message || e?.message || 'Failed to send.');
    } finally {
      setSending(false);
    }
  };

  // Начать ответ на сообщение: показываем цитату над вводом, фокус в поле.
  const startReply = (m: ShoutMessage) => {
    setReplyTo({ id: m.id, name: nick(m).name, text: m.text });
    inputRef.current?.focus();
  };

  // Переход к цитируемому сообщению (если оно в подгруженной ленте) + вспышка.
  const scrollToMessage = (id: string) => {
    const el = listRef.current?.querySelector(`[data-mid="${id}"]`) as HTMLElement | null;
    if (!el) return; // старее подгруженного — тихо игнорим (v1)
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setFlashId(id);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1500);
  };

  // Ввод: обновляем черновик и пересчитываем активный токен @упоминания.
  const onDraftChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value.slice(0, MAX_LEN);
    setDraft(val);
    if (error) setError('');
    const tok = activeMention(val, e.target.selectionStart ?? val.length);
    mentionTokenRef.current = tok;
    if (!tok || tok.query.length < 1) { setMentions([]); return; }
    const reqId = ++mentionReqRef.current;
    searchMentionUsers(tok.query).then((users) => {
      if (reqId !== mentionReqRef.current || !mentionTokenRef.current) return; // устарел
      setMentions(users);
      setMentionIdx(0);
    });
  };

  // Подставить выбранного кандидата: заменяем «@частичный» на «@username ».
  const pickMention = (u: MentionUser) => {
    const tok = mentionTokenRef.current;
    const el = inputRef.current;
    if (!tok || !el) return;
    const caret = el.selectionStart ?? draft.length;
    const before = draft.slice(0, tok.start);
    const insert = `@${u.username} `;
    const next = (before + insert + draft.slice(caret)).slice(0, MAX_LEN);
    setDraft(next);
    setMentions([]);
    mentionTokenRef.current = null;
    const pos = (before + insert).length;
    requestAnimationFrame(() => {
      el.focus();
      try { el.setSelectionRange(pos, pos); } catch { /* нет фокуса */ }
    });
  };

  const closeMentions = () => { setMentions([]); mentionTokenRef.current = null; };

  const nick = (m: ShoutMessage): { name: string; color: string } => {
    const u = m.expand?.user;
    if (u) return { name: u.name || u.username || '?', color: u.isModerator ? MOD_COLOR : userColor(u.id) };
    return anonIdentity(m.anon_key);
  };

  const renderSystem = (m: ShoutMessage) => {
    const ev = m.event;
    let icon = <CampaignOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />;
    let body: React.ReactNode = m.text;
    if (ev?.type === 'new_game' && ev.games?.length) {
      icon = <CasinoOutlinedIcon sx={{ fontSize: 14, opacity: 0.7 }} />;
      body = (
        <>
          {ev.games.length === 1 ? 'New game: ' : `${ev.games.length} new games: `}
          {ev.games.map((g, i) => (
            <React.Fragment key={g.id}>
              {i > 0 && ', '}
              <Box
                component={Link}
                to={`${gameLinkBase}/${g.id}`}
                sx={{ color: 'primary.light', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}
              >
                {g.title}
              </Box>
              {ev.games.length === 1 && g.author !== 'unknown' && (
                <Box component="span" sx={{ opacity: 0.6 }}> by {g.author}</Box>
              )}
            </React.Fragment>
          ))}
        </>
      );
    }
    return (
      <Box sx={{
        display: 'flex', alignItems: 'baseline', gap: 0.75, px: 1, py: 0.5, my: 0.25,
        borderRadius: 1, bgcolor: 'rgba(255,255,255,0.035)',
      }}>
        {icon}
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
          {body}
          <Tooltip title={absoluteTime(m.created)}>
            <Box component="span" sx={{ opacity: 0.45, ml: 0.75 }}>{shortTime(m.created)}</Box>
          </Tooltip>
        </Typography>
      </Box>
    );
  };

  return (
    // SwipeableDrawer: свайп вправо по чату закрывает его (мобайл). Открытие
    // свайпом с края НЕ включаем (disableSwipeToOpen) — край экрана принадлежит
    // браузерной навигации; «назад» жестом/кнопкой тоже закрывает (см. popstate).
    <SwipeableDrawer
      anchor="right"
      open={open}
      onClose={onClose}
      onOpen={() => {}}
      disableSwipeToOpen
      disableDiscovery
      slotProps={{
        paper: {
          sx: {
            width: { xs: '100%', sm: 380 },
            bgcolor: 'rgba(16,16,16,0.97)',
            backdropFilter: 'blur(14px)',
            borderLeft: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
          },
        },
      }}
    >
      {/* Заголовок */}
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.25,
        borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, letterSpacing: 0.3 }}>
          Chat
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, opacity: 0.7 }}>
          <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: '#66bb6a' }} />
          <Typography variant="caption">{online} online</Typography>
        </Box>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton size="small" onClick={onClose} aria-label="Close chat">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Лента */}
      <Box
        ref={listRef}
        onScroll={handleScroll}
        sx={{
          flexGrow: 1, overflowY: 'auto', px: 1.5, py: 1, position: 'relative',
          // Тонкая ненавязчивая полоса вместо жирной нативной (десктоп).
          // Firefox: overlay-стиль. WebKit: узкий бегунок без стрелок/трека,
          // проявляется только при наведении на ленту.
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.12) transparent',
          '&::-webkit-scrollbar': { width: 8 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': {
            backgroundColor: 'rgba(255,255,255,0.08)',
            borderRadius: 8,
            border: '2px solid transparent',
            backgroundClip: 'padding-box',
            transition: 'background-color 0.2s',
          },
          '&:hover::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.18)' },
          '&::-webkit-scrollbar-thumb:hover': { backgroundColor: 'rgba(255,255,255,0.28)' },
        }}
      >
        {loadingOlder && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
            <CircularProgress size={16} sx={{ opacity: 0.5 }} />
          </Box>
        )}
        {messages.length === 0 && !loadingOlder && (
          <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', mt: 4, opacity: 0.6 }}>
            Say hi!
          </Typography>
        )}
        {messages.map((m) => {
          if (m.kind === 'system') return <Box key={m.id}>{renderSystem(m)}</Box>;
          const n = nick(m);
          const isOwn = user ? m.user === user.id : !!myAnonKey && m.anon_key === myAnonKey;
          const sourceKey = m.user || m.anon_key;
          const confirming = confirm?.id === m.id ? confirm.action : null;
          return (
            <Box
              key={m.id}
              data-mid={m.id}
              sx={{
                py: 0.5, px: 0.5, borderRadius: 1, display: 'flex', gap: 1,
                transition: 'background-color 0.4s',
                bgcolor: flashId === m.id ? 'rgba(120,130,220,0.18)' : 'transparent',
                '&:hover': { bgcolor: flashId === m.id ? 'rgba(120,130,220,0.18)' : 'rgba(255,255,255,0.025)' },
                '&:hover .shout-mod': { opacity: 1 },
              }}
            >
              {/* Аватар: у залогиненных — картинка (или инициал на цветном кружке);
                  у анонов картинки нет — инициал на цвете их псевдо-ника. */}
              <Avatar
                src={avatarUrlOf(m.expand?.user)}
                sx={{
                  width: 28, height: 28, mt: 0.25, flexShrink: 0,
                  fontSize: '0.8rem', fontWeight: 600,
                  bgcolor: n.color, color: 'rgba(0,0,0,0.72)',
                }}
              >
                {n.name.charAt(0).toUpperCase()}
              </Avatar>
              <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
                <Tooltip title={m.expand?.user?.username ? `@${m.expand.user.username}` : ''} arrow>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: n.color, cursor: m.expand?.user?.username ? 'help' : 'default' }}>
                    {n.name}
                    {isOwn && <Box component="span" sx={{ fontWeight: 400, opacity: 0.55 }}> (you)</Box>}
                  </Typography>
                </Tooltip>
                <Tooltip title={absoluteTime(m.created)}>
                  <Typography variant="caption" sx={{ opacity: 0.4 }}>
                    {shortTime(m.created)}
                  </Typography>
                </Tooltip>
                <Box sx={{ flexGrow: 1 }} />
                {!confirming && (
                  <Tooltip title="Reply">
                    <IconButton
                      className="shout-mod"
                      size="small"
                      sx={{
                        p: 0.5, opacity: 0, transition: 'opacity 0.15s',
                        '@media (hover: none)': { opacity: 0.55 },
                      }}
                      aria-label="Reply"
                      onClick={() => startReply(m)}
                    >
                      <ReplyIcon sx={{ fontSize: 17 }} />
                    </IconButton>
                  </Tooltip>
                )}
                {isModerator && (confirming ? (
                  // Второй шаг: ✓ выполняет, ✕ отменяет. Цвет намекает на действие.
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Typography variant="caption" sx={{ opacity: 0.6 }}>
                      {confirming === 'delete' ? 'delete?' : 'mute 24h?'}
                    </Typography>
                    <IconButton
                      size="small"
                      sx={{ p: 0.5, color: confirming === 'delete' ? 'error.main' : 'warning.main' }}
                      aria-label={`Confirm ${confirming}`}
                      onClick={() => {
                        setConfirm(null);
                        if (confirming === 'delete') {
                          deleteMessage(m.id).catch(() => {});
                        } else {
                          muteMessageSource(m.id)
                            .then(() => setMutedSources((prev) => new Set(prev).add(sourceKey)))
                            .catch(() => {});
                        }
                      }}
                    >
                      <CheckIcon sx={{ fontSize: 17 }} />
                    </IconButton>
                    <IconButton size="small" sx={{ p: 0.5 }} aria-label="Cancel" onClick={() => setConfirm(null)}>
                      <CloseIcon sx={{ fontSize: 17 }} />
                    </IconButton>
                  </Box>
                ) : (
                  <Box
                    className="shout-mod"
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 1.25,
                      opacity: 0, transition: 'opacity 0.15s',
                      '@media (hover: none)': { opacity: 0.55 },
                    }}
                  >
                    <Tooltip title="Delete">
                      <IconButton size="small" sx={{ p: 0.5 }} aria-label="Delete message" onClick={() => setConfirm({ id: m.id, action: 'delete' })}>
                        <DeleteOutlineIcon sx={{ fontSize: 17 }} />
                      </IconButton>
                    </Tooltip>
                    {mutedSources.has(sourceKey) ? (
                      <Tooltip title="Unmute">
                        <IconButton
                          size="small"
                          sx={{ p: 0.5, color: 'warning.main' }}
                          aria-label="Unmute"
                          onClick={() =>
                            unmuteMessageSource(m.id)
                              .then(() => setMutedSources((prev) => {
                                const next = new Set(prev);
                                next.delete(sourceKey);
                                return next;
                              }))
                              .catch(() => {})
                          }
                        >
                          <VolumeUpIcon sx={{ fontSize: 17 }} />
                        </IconButton>
                      </Tooltip>
                    ) : (
                      <Tooltip title="Mute 24h">
                        <IconButton size="small" sx={{ p: 0.5 }} aria-label="Mute source" onClick={() => setConfirm({ id: m.id, action: 'mute' })}>
                          <VolumeOffIcon sx={{ fontSize: 17 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Box>
                ))}
              </Box>
              {m.reply && (
                <Box
                  onClick={() => scrollToMessage(m.reply!.id)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25, cursor: 'pointer',
                    borderLeft: '2px solid rgba(255,255,255,0.18)', pl: 0.75,
                    opacity: 0.65, '&:hover': { opacity: 1 },
                  }}
                >
                  <ReplyIcon sx={{ fontSize: 12, transform: 'scaleX(-1)', opacity: 0.6, flexShrink: 0 }} />
                  <Typography variant="caption" sx={{ fontWeight: 600, flexShrink: 0 }}>
                    {replyDisplayName(m.reply)}
                  </Typography>
                  <Typography variant="caption" noWrap sx={{ opacity: 0.7, minWidth: 0 }}>
                    {m.reply.text}
                  </Typography>
                </Box>
              )}
              <Typography variant="body2" sx={{ lineHeight: 1.45, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                {renderMessageText(m.text, user?.username)}
              </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* «↓ новые» — если юзер отскроллил вверх */}
      {showJump && (
        <Box sx={{ position: 'relative', flexShrink: 0 }}>
          <Chip
            size="small"
            icon={<ArrowDownwardIcon sx={{ fontSize: 14 }} />}
            label="New messages"
            onClick={() => scrollToBottom(true)}
            sx={{
              position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
              bgcolor: 'rgba(40,40,40,0.95)', border: '1px solid rgba(255,255,255,0.15)',
            }}
          />
        </Box>
      )}

      {/* Ввод */}
      <Box sx={{ px: 1.5, pt: 1, pb: 1.25, borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0, position: 'relative' }}>
        {/* Автодополнение @упоминаний (над полем). onMouseDown с preventDefault —
            чтобы клик по кандидату не уводил фокус из поля до подстановки. */}
        {mentions.length > 0 && (
          <Box
            onMouseDown={(e) => e.preventDefault()}
            sx={{
              position: 'absolute', bottom: '100%', left: 12, right: 12, mb: 0.5, zIndex: 5,
              bgcolor: 'rgba(28,28,28,0.98)', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 1.5, boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
              maxHeight: 220, overflowY: 'auto',
            }}
          >
            {mentions.map((u, i) => (
              <Box
                key={u.id}
                onClick={() => pickMention(u)}
                onMouseEnter={() => setMentionIdx(i)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.75, cursor: 'pointer',
                  bgcolor: i === mentionIdx ? 'rgba(255,255,255,0.08)' : 'transparent',
                }}
              >
                <Avatar
                  src={avatarUrlOf(u)}
                  sx={{ width: 22, height: 22, fontSize: '0.7rem', fontWeight: 600, bgcolor: userColor(u.id), color: 'rgba(0,0,0,0.72)' }}
                >
                  {(u.name || u.username).charAt(0).toUpperCase()}
                </Avatar>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{u.name || u.username}</Typography>
                <Typography variant="caption" sx={{ opacity: 0.5 }}>@{u.username}</Typography>
              </Box>
            ))}
          </Box>
        )}

        {/* Цитата отвечаемого сообщения над полем ввода. */}
        {replyTo && (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75, px: 1, py: 0.5,
            borderRadius: 1, bgcolor: 'rgba(255,255,255,0.05)',
            borderLeft: '2px solid', borderLeftColor: 'primary.main',
          }}>
            <ReplyIcon sx={{ fontSize: 15, opacity: 0.6, flexShrink: 0 }} />
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 600, display: 'block' }}>
                Replying to {replyTo.name}
              </Typography>
              <Typography variant="caption" noWrap sx={{ opacity: 0.6, display: 'block' }}>
                {replyTo.text}
              </Typography>
            </Box>
            <IconButton size="small" sx={{ p: 0.5 }} aria-label="Cancel reply" onClick={() => setReplyTo(null)}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>
        )}

        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.75 }}>
          <TextField
            fullWidth
            multiline
            maxRows={4}
            size="small"
            value={draft}
            inputRef={inputRef}
            onChange={onDraftChange}
            onBlur={() => {
              // Закрываем popup с задержкой, чтобы клик по кандидату успел сработать.
              if (blurTimer.current) window.clearTimeout(blurTimer.current);
              blurTimer.current = window.setTimeout(closeMentions, 150);
            }}
            onKeyDown={(e) => {
              if (mentions.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentions.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentions.length) % mentions.length); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentions[mentionIdx]); return; }
                if (e.key === 'Escape') { e.preventDefault(); closeMentions(); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Say something…"
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: 'rgba(255,255,255,0.04)', borderRadius: 2, fontSize: '0.9rem',
                '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
              },
              // Тонкая полоса в textarea (появляется при >4 строк) — в тон ленте.
              '& textarea': {
                scrollbarWidth: 'thin',
                scrollbarColor: 'rgba(255,255,255,0.12) transparent',
                '&::-webkit-scrollbar': { width: 8 },
                '&::-webkit-scrollbar-track': { background: 'transparent' },
                '&::-webkit-scrollbar-thumb': {
                  backgroundColor: 'rgba(255,255,255,0.12)',
                  borderRadius: 8,
                  border: '2px solid transparent',
                  backgroundClip: 'padding-box',
                },
                '&::-webkit-scrollbar-thumb:hover': { backgroundColor: 'rgba(255,255,255,0.28)' },
              },
            }}
          />
          <IconButton
            color="primary"
            onClick={send}
            disabled={sending || !draft.trim()}
            aria-label="Send"
            sx={{ mb: 0.25 }}
          >
            <SendIcon fontSize="small" />
          </IconButton>
        </Box>
        <Typography variant="caption" sx={{ color: error ? 'error.main' : 'text.secondary', opacity: error ? 1 : 0.55, display: 'block', mt: 0.5 }}>
          {error || (signedIn ? (
            'Be nice.'
          ) : (
            <>
              {myAnonKey && (
                <>
                  {'You are '}
                  <Box component="span" sx={{ fontWeight: 600, color: anonIdentity(myAnonKey).color }}>
                    {anonIdentity(myAnonKey).name}
                  </Box>
                  {' · '}
                </>
              )}
              Be nice. No links from anons.
            </>
          ))}
        </Typography>
      </Box>
    </SwipeableDrawer>
  );
}
