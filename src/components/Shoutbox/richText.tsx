// Лёгкая разметка сообщений чата: ссылки, **жирный**, *курсив*, ~~зачёркнутый~~,
// `код`, ||спойлер||, > цитата, @упоминания.
//
// Почему свой парсер, а не marked + dompurify: две библиотеки весят больше, чем
// весь чат, тянутся в чанк ради шести значков и приносят с собой ровно ту
// поверхность, от которой потом защищаются — HTML. Здесь HTML не появляется
// нигде: разбор сразу собирает узлы React, поэтому «вставить тег» физически
// нечем. Это не строгий markdown и не должен им быть — это то, что люди и так
// печатают в чатах.
//
// Границы намеренные: ни картинок, ни заголовков, ни таблиц, ни вложенных
// списков. Сообщение — 300 символов, ему хватит.
import { Fragment, useState } from 'react';
import { Box } from '@mui/material';
import { Link } from 'react-router-dom';

type Opts = {
  /** Клик по @нику — подставить его в поле ввода (в ленте есть, в превью нет). */
  onMention?: (username: string) => void;
  /** Свой username: упоминание себя подсвечивается заметнее. */
  me?: string;
};

/** Ссылка целиком, но без хвостовой пунктуации: «зашёл на https://site.com.» —
 *  точка в конце принадлежит предложению, а не адресу. Скобку отдаём назад
 *  только если она непарная, иначе ломаются адреса вида …/wiki/Foo_(bar). */
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1];
    if ('.,;:!?»"\''.includes(ch)) { end -= 1; continue; }
    if (ch === ')') {
      const inner = url.slice(0, end - 1);
      if ((inner.match(/\(/g) || []).length > (inner.match(/\)/g) || []).length) break;
      end -= 1;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

/** Длинный адрес в ленте — стена символов. Показываем узнаваемое начало,
 *  ведёт всё равно целиком. */
function linkLabel(url: string): string {
  const short = url.replace(/^https?:\/\//, '');
  return short.length <= 60 ? short : `${short.slice(0, 57)}…`;
}

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Box
      component="span"
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setOpen((v) => !v); }}
      title={open ? undefined : 'Spoiler — click to reveal'}
      sx={{
        cursor: 'pointer',
        borderRadius: 0.5,
        px: 0.25,
        transition: 'color .12s, background-color .12s',
        ...(open
          ? { bgcolor: 'rgba(255,255,255,0.07)' }
          : { bgcolor: 'text.primary', color: 'transparent', userSelect: 'none' }),
      }}
    >
      {children}
    </Box>
  );
}

function SiteLink({ url }: { url: string }) {
  const sx = {
    color: 'primary.light',
    textDecoration: 'none',
    wordBreak: 'break-all' as const,
    '&:hover': { textDecoration: 'underline' },
  };
  // Свои ссылки открываем маршрутизатором: перезагружать всё приложение ради
  // перехода на карточку игры незачем.
  let path = '';
  try {
    const u = new URL(url);
    if (u.host === window.location.host) path = u.pathname + u.search + u.hash;
  } catch { /* адрес кривой — пусть будет обычной внешней ссылкой */ }

  if (path) return <Box component={Link} to={path} sx={sx}>{linkLabel(url)}</Box>;
  return (
    <Box component="a" href={url} target="_blank" rel="noopener noreferrer nofollow" sx={sx}>
      {linkLabel(url)}
    </Box>
  );
}

/** Обёртки «значок — оформление». `**` стоит раньше `*`, иначе жирный распадётся
 *  на два курсива. */
const WRAPS: { open: string; wrap: (inner: React.ReactNode, key: number) => React.ReactNode }[] = [
  { open: '||', wrap: (inner, key) => <Spoiler key={key}>{inner}</Spoiler> },
  { open: '**', wrap: (inner, key) => <b key={key}>{inner}</b> },
  { open: '~~', wrap: (inner, key) => <s key={key}>{inner}</s> },
  { open: '*', wrap: (inner, key) => <i key={key}>{inner}</i> },
  { open: '_', wrap: (inner, key) => <i key={key}>{inner}</i> },
];

type Hit = { at: number; len: number; take: (key: number) => React.ReactNode };

/** Разбор одной строки: ищем ближайший значок, оформляем, продолжаем с остатка.
 *  Внутренность парных значков разбираем рекурсивно, глубина ограничена — на
 *  случай сообщения вида «*_*_*_*…». */
function inline(src: string, opts: Opts, depth = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = src;
  let key = 0;

  while (rest) {
    let best: Hit | null = null;
    const consider = (h: Hit | null) => {
      if (h && h.at >= 0 && (!best || h.at < best.at)) best = h;
    };

    // `код` — раньше всех: внутри него звёздочки остаются буквами.
    const code = rest.match(/`([^`\n]+)`/);
    if (code?.index !== undefined) {
      consider({
        at: code.index,
        len: code[0].length,
        take: (k) => (
          <Box
            key={k}
            component="code"
            sx={{
              px: 0.5, py: 0.1, borderRadius: 0.5, fontSize: '0.92em', fontFamily: 'monospace',
              bgcolor: 'rgba(255,255,255,0.08)', wordBreak: 'break-word',
            }}
          >
            {code[1]}
          </Box>
        ),
      });
    }

    const url = rest.match(/https?:\/\/[^\s<>]+/);
    if (url?.index !== undefined) {
      const clean = trimUrlTail(url[0]);
      consider({ at: url.index, len: clean.length, take: (k) => <SiteLink key={k} url={clean} /> });
    }

    const mention = rest.match(/@([A-Za-z0-9_]{2,30})/);
    if (mention?.index !== undefined) {
      const uname = mention[1];
      const mine = !!opts.me && uname.toLowerCase() === opts.me.toLowerCase();
      consider({
        at: mention.index,
        len: mention[0].length,
        take: (k) => (
          <Box
            key={k}
            component="span"
            onClick={opts.onMention ? () => opts.onMention?.(uname) : undefined}
            sx={{
              color: mine ? 'warning.light' : 'primary.light',
              bgcolor: mine ? 'rgba(255,193,7,0.14)' : 'rgba(144,202,249,0.12)',
              borderRadius: 0.5,
              px: 0.25,
              fontWeight: mine ? 600 : 400,
              cursor: opts.onMention ? 'pointer' : 'default',
            }}
          >
            @{uname}
          </Box>
        ),
      });
    }

    if (depth < 4) {
      for (const w of WRAPS) {
        const at = rest.indexOf(w.open);
        if (at < 0) continue;
        const closeAt = rest.indexOf(w.open, at + w.open.length);
        if (closeAt < 0) continue;
        const inner = rest.slice(at + w.open.length, closeAt);
        if (!inner.trim()) continue; // «**» или «||» сами по себе — просто символы
        consider({
          at,
          len: closeAt + w.open.length - at,
          take: (k) => w.wrap(inline(inner, opts, depth + 1), k),
        });
      }
    }

    if (!best) { out.push(rest); break; }
    const hit: Hit = best;
    if (hit.at > 0) out.push(rest.slice(0, hit.at));
    out.push(hit.take(key));
    key += 1;
    rest = rest.slice(hit.at + hit.len);
  }
  return out;
}

/** Текст сообщения → узлы React. Строки, начинающиеся с «> », собираются в
 *  цитату; остальные переносы сохраняются контейнером (whiteSpace: pre-wrap). */
export function renderRichText(text: string, opts: Opts = {}): React.ReactNode {
  const out: React.ReactNode[] = [];
  let quote: string[] = [];
  let plainSince = false; // была ли уже обычная строка — нужен ли перенос перед следующей

  const flushQuote = (key: string) => {
    if (!quote.length) return;
    const body = quote.join('\n');
    quote = [];
    plainSince = false;
    out.push(
      <Box
        key={key}
        sx={{
          borderLeft: 3, borderColor: 'rgba(255,255,255,0.25)', pl: 1, my: 0.25,
          color: 'text.secondary', display: 'block', whiteSpace: 'pre-wrap',
        }}
      >
        {inline(body, opts)}
      </Box>,
    );
  };

  text.split('\n').forEach((line, i) => {
    if (line.startsWith('> ') || line === '>') {
      quote.push(line.slice(2));
      return;
    }
    flushQuote(`q${i}`);
    out.push(
      <Fragment key={`l${i}`}>
        {plainSince ? '\n' : ''}
        {inline(line, opts)}
      </Fragment>,
    );
    plainSince = true;
  });
  flushQuote('qend');
  return out;
}
