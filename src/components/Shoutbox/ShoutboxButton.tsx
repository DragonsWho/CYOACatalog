// Иконка шаутбокса (для хедера / лабы): чат-пузырь + бейдж непрочитанного.
// Владеет присутствием («я тут») и стейтом дровера.
// Фиче-флаг выключен → рендерит null (фича неотличима от несуществующей).
//
// Это САМЫЙ массовый код сайта: он висит в шапке каждой страницы у каждого
// посетителя, включая тех, кто чат не откроет никогда. Поэтому с закрытым чатом
// он делает ровно две вещи, и обе — дешёвые:
//
//   1. читает «пульс» — ОДИН общий на всех ответ, который отдаёт край сети
//      (Cloudflare), а число непрочитанного считает у себя в браузере;
//   2. изредка сообщает «я тут» — не по таймеру, а по факту того, что человек
//      шевелился, и не чаще раза в 10 минут.
//
// Постоянной подписки на /api/realtime здесь нет НАМЕРЕННО: раньше каждый
// посетитель на каждой вкладке тянул отдельный SSE-поток даже с закрытым чатом,
// и на масштабе это дало шторм реконнектов через Cloudflare и 100% CPU на проде.
// Живой SSE держится ТОЛЬКО пока открыт дровер (см. Shoutbox.tsx, gated на open).

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Badge, IconButton, Tooltip } from '@mui/material';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import {
  fetchPulse, countPulseUnread, pingPresence, markSeenServer, type ShoutPulse,
} from './shoutboxApi';

// Сам чат грузится отдельным куском и ТОЛЬКО когда его открыли. Раньше он ехал
// в общем чанке шапки — десяток килобайт разметки, ленты и загрузчика картинок
// приезжали каждому, кто зашёл почитать одну игру.
const Shoutbox = lazy(() => import('./Shoutbox'));

// Как часто перечитываем пульс, пока вкладка видима. Ответ лежит на краю сети,
// так что это не «запрос к серверу», а «взять из кэша рядом с собой».
const PULSE_MS = 60_000;

// Вкладку открыли и забыли (браузер её не прячет — она просто лежит на втором
// мониторе или на соседней вкладке телефона): темп падает впятеро. На масштабе
// таких вкладок большинство, и минута против пяти — это разница в пять раз во
// всём фоновом трафике сайта.
const IDLE_AFTER_MS = 10 * 60_000;
const PULSE_MS_IDLE = 5 * 60_000;

// Присутствие: реже раза в 10 минут не сообщаем о себе НИКОГДА, а «онлайн» на
// сервере живёт полчаса (shoutOnlineWindow). Спящая вкладка не шлёт ничего.
const PRESENCE_MIN_GAP_MS = 10 * 60_000;

const SEEN_KEY = 'shoutbox_seen'; // localStorage: момент последнего прочтения
const ENABLED_KEY = 'shoutbox_enabled'; // localStorage: кэш фиче-флага (антидёрг)

// Стартовое значение флага берём из кэша, чтобы иконка сидела в строке С ПЕРВОГО
// кадра, а не «прыгала» после ответа сервера. Вернувшийся посетитель (почти все)
// видит иконку сразу; первый визит — один раз, дальше кэш. Флаг выключат на
// сервере → следующий пульс вернёт 404, кэш очистится, иконка пропадёт.
function cachedEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

/** Момент времени из ISO-строки; пусто/мусор → 0. Сравнивать отметки строками
 *  нельзя: браузер пишет «…:00.000Z», сервер — «…:00Z», и лексикографически
 *  одинаковые моменты оказываются разными. */
function ms(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

interface ShoutboxButtonProps {
  iconFontSize?: string;
  padding?: string;
  /** Открыть дровер сразу после маунта (тестовая лаба). */
  autoOpen?: boolean;
  gameLinkBase?: string;
}

export default function ShoutboxButton({
  iconFontSize, padding, autoOpen = false, gameLinkBase,
}: ShoutboxButtonProps) {
  const [enabled, setEnabled] = useState(cachedEnabled);
  const [online, setOnline] = useState(0);
  const [unread, setUnread] = useState(0);
  const [anonKey, setAnonKey] = useState('');
  const [open, setOpen] = useState(false);
  // Дровер монтируем с первого открытия и дальше держим: закрытый он ничего не
  // делает (все эффекты внутри gated на open), а размонтирование ломало бы
  // анимацию закрытия и заново качало бы чанк.
  const [everOpen, setEverOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  // «Последнее прочитанное» держим в ref (не в state — не хотим ре-рендеров) +
  // localStorage. Новый посетитель стартует с «now» → 0 непрочитанных; вернувшийся
  // видит накопленное. markSeen двигает отметку на текущий момент и гасит бейдж.
  const lastSeenRef = useRef<string>('');
  const openRef = useRef(open);
  const wasOpenRef = useRef(false);
  const pulseRef = useRef<ShoutPulse | null>(null);
  // Присутствие: «человек шевелился с прошлого пинга» + когда пинговали.
  const activeRef = useRef(true);
  const pingedAtRef = useRef(0);
  // Когда человек последний раз что-то делал и когда мы последний раз читали
  // пульс — этой пары хватает, чтобы отличить живую вкладку от забытой.
  const activeAtRef = useRef(Date.now());
  const pulsedAtRef = useRef(0);

  const markSeen = () => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    try { localStorage.setItem(SEEN_KEY, now); } catch { /* приватный режим */ }
    setUnread(0);
  };

  useEffect(() => {
    const saved = (() => { try { return localStorage.getItem(SEEN_KEY); } catch { return null; } })();
    if (saved) {
      lastSeenRef.current = saved;
    } else {
      lastSeenRef.current = new Date().toISOString();
      try { localStorage.setItem(SEEN_KEY, lastSeenRef.current); } catch { /* приватный режим */ }
    }
  }, []);

  // Открыл = читаю (гасим бейдж и двигаем отметку); закрыл = всё до этого момента
  // прочитано. На первом маунте (open=false, ещё не открывали) — ничего, чтобы не
  // затереть межсессионное непрочитанное.
  useEffect(() => {
    openRef.current = open;
    if (open) setEverOpen(true);
    // Локальная отметка (localStorage → storage-событие гасит бейдж в других
    // вкладках) + серверная (users.shoutbox_last_seen → гасит на других
    // устройствах). Серверную двигаем только на переходах открыл/закрыл, а не на
    // каждом тике — 2 записи на сессию чата.
    if (open) { markSeen(); markSeenServer(); }
    else if (wasOpenRef.current) { markSeen(); markSeenServer(); }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    let cancelled = false;

    const applyPulse = (p: ShoutPulse) => {
      pulseRef.current = p;
      setOnline(p.online);
      setUnread(openRef.current ? 0 : countPulseUnread(p, lastSeenRef.current));
    };

    const pulse = async () => {
      const p = await fetchPulse();
      if (cancelled || !p) return;
      if (p === 'disabled') {
        try { localStorage.setItem(ENABLED_KEY, '0'); } catch { /* приватный режим */ }
        setEnabled(false);
        stopLoop();
        return;
      }
      try { localStorage.setItem(ENABLED_KEY, '1'); } catch { /* приватный режим */ }
      setEnabled(true);
      applyPulse(p);
    };

    // Сказать «я тут». force — на загрузке страницы; дальше только если человек
    // за это время что-то нажал И прошло достаточно времени. Заодно приносит
    // свой anon_key (псевдо-ник анонима) и серверную отметку прочтения.
    const ping = async (force = false) => {
      if (!force) {
        if (!activeRef.current) return;
        if (Date.now() - pingedAtRef.current < PRESENCE_MIN_GAP_MS) return;
      }
      activeRef.current = false;
      pingedAtRef.current = Date.now();
      try {
        const res = await pingPresence(lastSeenRef.current);
        if (cancelled) return;
        setAnonKey(res.anonKey);
        // Прочитал на другом устройстве → серверная отметка новее локальной.
        if (ms(res.lastSeen) > ms(lastSeenRef.current)) {
          lastSeenRef.current = res.lastSeen;
          try { localStorage.setItem(SEEN_KEY, res.lastSeen); } catch { /* приватный режим */ }
          if (pulseRef.current && !openRef.current) {
            setUnread(countPulseUnread(pulseRef.current, res.lastSeen));
          }
        }
      } catch { /* оффлайн — состояние не трогаем */ }
    };

    const tick = () => {
      const now = Date.now();
      const idle = now - activeAtRef.current > IDLE_AFTER_MS;
      if (!idle || now - pulsedAtRef.current >= PULSE_MS_IDLE) {
        pulsedAtRef.current = now;
        pulse();
      }
      ping();
    };

    const startLoop = () => {
      if (timerRef.current !== null) return;
      tick();
      timerRef.current = window.setInterval(tick, PULSE_MS);
    };
    function stopLoop() {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') { stopLoop(); return; }
      // Вернулся к вкладке — это и есть активность.
      activeRef.current = true;
      activeAtRef.current = Date.now();
      // Вернулся с другого устройства/вкладки — бейдж должен поправиться сразу,
      // а не через минуту. Стоит это ноль: в пределах 10 секунд ответ отдаст
      // даже собственный кэш браузера, дальше — край сети.
      if (timerRef.current === null) startLoop(); // startLoop сам делает первый тик
      else { pulsedAtRef.current = Date.now(); pulse(); }
    };
    // Любое действие человека на странице = «он ещё здесь». Само по себе не шлёт
    // ничего: только взводит флажок, который прочтёт очередной тик.
    const onActivity = () => { activeRef.current = true; activeAtRef.current = Date.now(); };

    // Пинг на загрузке страницы — единственный безусловный за всю сессию.
    ping(true);
    if (autoOpen) setOpen(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onVisibility);
    for (const ev of ['pointerdown', 'keydown', 'scroll'] as const) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    onVisibility();

    return () => {
      cancelled = true;
      stopLoop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onVisibility);
      for (const ev of ['pointerdown', 'keydown', 'scroll'] as const) {
        window.removeEventListener(ev, onActivity);
      }
    };
  }, [autoOpen]);

  // Кросс-таб: другая вкладка того же браузера отметила чат прочитанным
  // (localStorage SEEN_KEY сменился) → гасим бейдж и подтягиваем отметку здесь.
  // storage-событие приходит только в ДРУГИЕ вкладки, не в ту, что записала.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === SEEN_KEY && e.newValue) {
        lastSeenRef.current = e.newValue;
        setUnread(0);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Открытие чата извне (клик по чат-уведомлению в колокольчике).
  useEffect(() => {
    const openChat = () => setOpen(true);
    window.addEventListener('shoutbox:open', openChat);
    return () => window.removeEventListener('shoutbox:open', openChat);
  }, []);

  if (!enabled) return null;

  return (
    <>
      <Tooltip title="Chat" arrow>
        <IconButton color="inherit" onClick={() => setOpen(true)} sx={{ padding }} aria-label="Chat">
          <Badge
            badgeContent={unread}
            // Потолок ровно тот, что везёт пульс (shoutPulseKeep): больше сервер
            // и не считает — разницы между «сто» и «двести» для человека нет.
            max={50}
            overlap="circular"
            sx={{
              // Непрочитанные, а не онлайн (онлайн — в шапке чата). Приглушённый
              // зелёный: заметно, но не кричит; при 0 MUI прячет бейдж сам.
              '& .MuiBadge-badge': {
                bgcolor: 'rgba(56,110,66,0.9)', color: 'rgba(255,255,255,0.82)',
                fontSize: '0.6rem', fontWeight: 500, minWidth: 15, height: 15, px: 0.5,
              },
            }}
          >
            <ChatBubbleOutlineIcon sx={{ fontSize: iconFontSize }} />
          </Badge>
        </IconButton>
      </Tooltip>
      {everOpen && (
        <Suspense fallback={null}>
          <Shoutbox
            open={open}
            onClose={() => setOpen(false)}
            online={online}
            myAnonKey={anonKey}
            gameLinkBase={gameLinkBase}
          />
        </Suspense>
      )}
    </>
  );
}
