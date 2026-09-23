// Lightweight chat markup: links, **bold**, *italic*, ~~strike~~, `code`, ||spoiler||, > quote,
// [c=red]color[/c], @mentions. Own parser instead of marked + dompurify: the two libraries weigh
// more than the whole chat, get pulled into the chunk for six markers, and bring exactly the attack
// surface they then defend against — HTML. No HTML appears anywhere here: parsing builds React
// nodes directly, so there's physically no way to inject a tag. Not strict markdown and shouldn't
// be — it's what people already type in chats. Deliberate limits: no images, headings, tables or
// nested lists.

import { Fragment, useState } from 'react';
import { Box } from '@mui/material';
import { Link } from 'react-router-dom';
import EmojiImg from '../Emoji/EmojiImg';
import { EMOJI_SIZE, JUMBO_MAX, emojiIndex } from '../Emoji/registry';

type Opts = {
  // Click on @name inserts it into the composer (feed only, not previews).
  onMention?: (username: string) => void;
  // Own username: self-mentions are highlighted more strongly.
  me?: string;
  emojiSize?: number;
};

// Custom emoji shortcode min length 2 on purpose: otherwise ":3" and ":D" became images — text
// smileys must not be touched.
const SHORTCODE = /:([a-z0-9_]{2,32}):/;

// Emoji-only messages (1..JUMBO_MAX custom emoji) render large like Discord. 0 = normal message.
export function emojiOnlyCount(text: string): number {
  const pack = emojiIndex();
  if (pack.size === 0) return 0;
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let n = 0;
  for (const t of tokens) {
    // Several shortcodes glued without spaces are also one "word".
    const parts = t.split(/(:[a-z0-9_]{2,32}:)/).filter(Boolean);
    for (const p of parts) {
      const m = p.match(/^:([a-z0-9_]{2,32}):$/);
      if (!m || !pack.has(m[1])) return 0;
      n += 1;
      if (n > JUMBO_MAX) return 0;
    }
  }
  return n;
}

// Whole URL minus trailing punctuation (a sentence's final period isn't part of the address). A
// closing paren is returned only if unbalanced, or …/wiki/Foo_(bar) breaks.
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

// A long URL in the feed is a wall of characters: show a recognizable start; the link still points
// to the full URL.
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
  // Own links go through the router: no full app reload to open a game card.
  let path = '';
  try {
    const u = new URL(url);
    if (u.host === window.location.host) path = u.pathname + u.search + u.hash;
  } catch { }  // malformed URL — leave it as a plain external link

  if (path) return <Box component={Link} to={path} sx={sx}>{linkLabel(url)}</Box>;
  return (
    <Box component="a" href={url} target="_blank" rel="noopener noreferrer nofollow" sx={sx}>
      {linkLabel(url)}
    </Box>
  );
}

// Colors for `[c=name]text[/c]`. CLOSED, deliberately pale set: arbitrary `#rrggbb` from users
// means black-on-black on day one; these eight read on the chat background and don't compete with
// brand red. Unknown names aren't markup at all — the brackets stay as typed.
export const TEXT_COLORS: { name: string; hex: string }[] = [
  { name: 'red', hex: '#ff6b6b' },
  { name: 'orange', hex: '#ffa94d' },
  { name: 'yellow', hex: '#ffd43b' },
  { name: 'green', hex: '#69db7c' },
  { name: 'cyan', hex: '#66d9e8' },
  { name: 'blue', hex: '#74c0fc' },
  { name: 'purple', hex: '#b197fc' },
  { name: 'pink', hex: '#f783ac' },
];

const COLOR_HEX = new Map(TEXT_COLORS.map((c) => [c.name, c.hex]));

// Wrapper markers → styles. `**` before `*`, or bold splits into two italics.
const WRAPS: { open: string; wrap: (inner: React.ReactNode, key: number) => React.ReactNode }[] = [
  { open: '||', wrap: (inner, key) => <Spoiler key={key}>{inner}</Spoiler> },
  { open: '**', wrap: (inner, key) => <b key={key}>{inner}</b> },
  { open: '~~', wrap: (inner, key) => <s key={key}>{inner}</s> },
  { open: '*', wrap: (inner, key) => <i key={key}>{inner}</i> },
  { open: '_', wrap: (inner, key) => <i key={key}>{inner}</i> },
];

type Hit = { at: number; len: number; take: (key: number) => React.ReactNode };

// Parse a line: find the nearest marker, style, continue with the rest. Paired contents parsed
// recursively with limited depth (for messages like "*_*_*_*…").
function inline(src: string, opts: Opts, depth = 0): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = src;
  let key = 0;

  while (rest) {
    let best: Hit | null = null;
    const consider = (h: Hit | null) => {
      if (h && h.at >= 0 && (!best || h.at < best.at)) best = h;
    };

    // `code` first: asterisks inside stay literal.
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

    // Custom emoji: only names known to the pack are replaced; an unknown ":foo:" must stay text,
    // or colons in normal speech and URLs would turn into holes.
    const shortcode = rest.match(SHORTCODE);
    if (shortcode?.index !== undefined) {
      const def = emojiIndex().get(shortcode[1]);
      if (def) {
        consider({
          at: shortcode.index,
          len: shortcode[0].length,
          take: (k) => (
            <EmojiImg key={k} emoji={def} size={opts.emojiSize ?? EMOJI_SIZE.inline} inline />
          ),
        });
      }
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

    // Color is parsed before paired markers, or a `*` inside the colored span would tear it apart.
    if (depth < 4) {
      const col = rest.match(/\[c=([a-z]{3,9})\]([^[]*?)\[\/c\]/);
      const hex = col ? COLOR_HEX.get(col[1]) : undefined;
      if (col?.index !== undefined && hex && col[2].trim()) {
        const inner = col[2];
        consider({
          at: col.index,
          len: col[0].length,
          take: (k) => (
            <Box key={k} component="span" sx={{ color: hex }}>
              {inline(inner, opts, depth + 1)}
            </Box>
          ),
        });
      }
    }

    if (depth < 4) {
      for (const w of WRAPS) {
        const at = rest.indexOf(w.open);
        if (at < 0) continue;
        const closeAt = rest.indexOf(w.open, at + w.open.length);
        if (closeAt < 0) continue;
        const inner = rest.slice(at + w.open.length, closeAt);
        if (!inner.trim()) continue;  // "**" or "||" alone are just characters
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

// Message text → React nodes. Lines starting with "> " group into a quote; other newlines are
// preserved by the container (whiteSpace: pre-wrap).
export function renderRichText(text: string, opts: Opts = {}): React.ReactNode {
  const out: React.ReactNode[] = [];
  let quote: string[] = [];
  let plainSince = false;

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
