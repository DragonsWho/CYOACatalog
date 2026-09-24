// Pre-React pre-paint: a static mock of the current UI drawn into #root before the ~700 KB bundle is
// fetched and parsed, so the first frame already looks like the page and React only adds detail
// (full covers, interactivity). Bundled into index.html as a classic inline script by the
// `prepaint` plugin in vite.config.ts — no React/MUI/PocketBase here.
//
// Home (`/`, no query): header + feed panel + real cards from the snapshot Go inlines
// (window.__CATALOG__*), picked by the same function HomePage seeds from (feedSeed.ts), so the
// handoff shows identical cards. Other routes: header only. The HTML stays one shared document
// (edge-cached); filter mode, blocks and dismissed pins are applied here from cookie/localStorage.
//
// Geometry mirrors Header.tsx / HomePage.tsx / FeedModeControls.tsx / GameCard.tsx; card numbers come
// from cardGeometry.ts itself. If one of those changes, update the mock (compare screenshots with the
// bundle blocked: frames before/after React must match).

import {
  CARD_ASPECT_RATIO, CARD_PAD, CARD_TITLE_FONT, CARD_TEXT_FONT, CARD_META_FONT, CARD_META_ICON,
  CARD_CHIP_FONT, CARD_CHIP_HEIGHT, TAG_SECTION_HEIGHT, TITLE_MARGIN_BOTTOM, DESC_BOX_TOP,
  DESC_BOX_BOTTOM, TAG_BOX_BOTTOM, META_BOX_BOTTOM, OVERLAY_OPACITY, sortCardTags, isFreshOriginal,
  isFreshBump,
} from '../components/cardGeometry';
import { getTagColor, GOLD_ACCENT } from '../utils/tagColors';
import { pickFeedSeed, type FeedMode, type SeedGame } from './feedSeed';
import { ICONS } from './icons';

type Responsive = { xs: string; sm?: string; md?: string };

const SM = 600;
const MD = 900;
const LG = 1200;

// "prop: value" per MUI breakpoint → base rule + min-width overrides.
function rcss(sel: string, props: Record<string, Responsive | string>): string {
  const at: Record<'xs' | 'sm' | 'md', string[]> = { xs: [], sm: [], md: [] };
  for (const [prop, v] of Object.entries(props)) {
    const val: Responsive = typeof v === 'string' ? { xs: v } : v;
    at.xs.push(`${prop}:${val.xs}`);
    if (val.sm) at.sm.push(`${prop}:${val.sm}`);
    if (val.md) at.md.push(`${prop}:${val.md}`);
  }
  let out = `${sel}{${at.xs.join(';')}}`;
  if (at.sm.length) out += `@media(min-width:${SM}px){${sel}{${at.sm.join(';')}}}`;
  if (at.md.length) out += `@media(min-width:${MD}px){${sel}{${at.md.join(';')}}}`;
  return out;
}

const FONT = 'Roboto,Helvetica,Arial,sans-serif';
const TEXT = '#dcdcdc';
const TEXT2 = 'rgba(255,255,255,0.7)';
const RED = '#fc3447';
const PINK = '#ff4081';

const CSS = [
  // letter-spacing: MUI body1 (0.00938em at 16px) is inherited as 0.15px; h3 = 0, body2 = 0.01071em.
  `.pp{font-family:${FONT};color:${TEXT};letter-spacing:0.15008px;min-height:100vh;display:flex;flex-direction:column}`,
  `.pp-t,.pp-b{letter-spacing:0}.pp-au,.pp-cn b{letter-spacing:0.01071em}`,
  // Header (AppBar dark: #0b0b0b + 9% white overlay; Toolbar pl 14 / pr 8 / gap 2, 48px).
  `.pp-bar{position:sticky;top:0;z-index:2;height:48px;background:#212121;box-shadow:0 2px 4px -1px rgba(0,0,0,.2),0 4px 5px 0 rgba(0,0,0,.14),0 1px 10px 0 rgba(0,0,0,.12)}`,
  `.pp-tb{max-width:${LG}px;margin:0 auto;height:48px;display:flex;align-items:center;gap:2px;padding:0 8px 0 14px}`,
  `.pp-logo{color:${RED};font-weight:800;letter-spacing:.5px;font-size:clamp(0.95rem,4.2vw,1.35rem);line-height:1.5;white-space:nowrap;overflow:hidden;flex:0 1 auto;min-width:0}`,
  `.pp-grow{flex-grow:1}`,
  `.pp-ib{flex-shrink:0;padding:8px;display:flex;color:${TEXT}}`,
  `.pp-ib svg{width:1.4rem;height:1.4rem}`,
  `.pp-av{width:32px;height:32px;border-radius:50%;background:#555;margin:0 3px;flex-shrink:0;background-size:cover;background-position:center}`,
  // Filter switch (FilterSwitch.tsx): phone = 76×26 track with a pill thumb carrying the mode name;
  // <400px = 70×22; ≥600px = "SFW" 70×28 round thumb "NSFW".
  `.pp-sw{display:flex;align-items:center;gap:6px;flex-shrink:0;font-size:12px;font-weight:500;color:#9e9e9e}`,
  `.pp-sw-l{display:none}`,
  `.pp-trk{position:relative;width:76px;height:26px;border-radius:13px;border:1px solid #616161}`,
  `.pp-th{position:absolute;top:2px;height:20px;width:34px;border-radius:10px;font-size:.55rem;font-weight:700;display:flex;align-items:center;justify-content:center;text-transform:uppercase}`,
  `@media(max-width:399px){.pp-trk{width:70px;height:22px;border-radius:11px}.pp-th{height:16px;width:30px;border-radius:8px;font-size:.5rem}.pp-ib{padding:6px}.pp-ib svg{width:1.25rem;height:1.25rem}}`,
  `@media(min-width:${SM}px){.pp-sw-l{display:inline}.pp-trk{width:70px;height:28px;border-radius:14px}.pp-th{top:3px;width:20px;height:20px;border-radius:50%;font-size:0;color:transparent}}`,
  // Main = App <Container main> (mt 32, gutters 16/24) › HomePage <Container> (max 2200, px 8/16/24).
  `.pp-main{margin:32px 0;padding:0 16px;flex:1}@media(min-width:${SM}px){.pp-main{padding:0 24px}}`,
  `.pp-home{max-width:2200px;margin:0 auto;padding:0 8px 16px}@media(min-width:${SM}px){.pp-home{padding:0 16px 16px}}@media(min-width:${MD}px){.pp-home{padding:0 24px 16px}}`,
  // Search fields (HomePage fieldSx / textFieldSx).
  `.pp-f{display:flex;align-items:center;width:100%;padding:2px 4px;border:1px solid transparent;border-radius:12px;background:rgba(255,255,255,.05);min-height:50px}`,
  `.pp-f svg{width:1.2rem;height:1.2rem;margin:0 8px;color:#fff;flex-shrink:0}`,
  `.pp-f span{padding-left:8px;font-size:.95rem;color:${TEXT};opacity:.6;white-space:nowrap;overflow:hidden}`,
  `.pp-f.pp-fb{min-height:49px}.pp-f.pp-fb span{padding-left:0;color:${TEXT2}}`,
  // Narrow panel (< md): one search button + mode rows. Wide panel (≥ md): 3 fields + meaning field.
  `.pp-pn{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}`,
  `.pp-pw{display:none;flex-direction:column;gap:10px;margin-bottom:12px;align-items:center}`,
  `@media(min-width:${MD}px){.pp-pn{display:none}.pp-pw{display:flex}}`,
  `.pp-r3{display:flex;gap:8px;width:100%;max-width:1080px}.pp-r1{display:flex;width:100%;max-width:820px}`,
  // FeedModeControls: compact buttons on narrow screens (px 8.8), wider on desktop (px 12).
  `.pp-mc{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:center}`,
  `.pp-g{display:flex}`,
  `.pp-b{display:flex;align-items:center;justify-content:center;padding:4px 8.8px;border-radius:10px;background:rgba(252,52,71,.05);color:${TEXT2};font-size:13px;font-weight:500;line-height:23px;min-height:28px}`,
  `.pp-b svg{width:20px;height:20px}`,
  // ToggleButtonGroup: siblings overlap by 1px; text buttons carry a 1px border (31px tall).
  `.pp-b+.pp-b{margin-left:-1px}.pp-b.t{border:1px solid transparent;padding:3px 8.8px}`,
  `.pp-b.on{background:rgba(252,52,71,.15);color:${TEXT};font-weight:600}`,
  `.pp-dv{display:none;width:1px;height:24px;background:rgba(255,255,255,.12)}`,
  `@media(min-width:${MD}px){.pp-mc{gap:8px}.pp-b{padding:4px 12px}.pp-b.t{padding:3px 12px}.pp-dv{display:block}}`,
  // Grid (GameGrid: Grid2 spacing xs 1 / sm 2; 1/2/3/5 columns).
  `.pp-grid{display:grid;grid-template-columns:1fr;gap:8px}`,
  `@media(min-width:${SM}px){.pp-grid{grid-template-columns:repeat(2,1fr);gap:16px}}`,
  `@media(min-width:${MD}px){.pp-grid{grid-template-columns:repeat(3,1fr)}}`,
  `@media(min-width:${LG}px){.pp-grid{grid-template-columns:repeat(5,1fr)}}`,
  // Card (GameCard.tsx).
  `.pp-c{position:relative;height:0;padding-top:${CARD_ASPECT_RATIO};border-radius:8px;overflow:hidden;background:#0b0b0b;box-shadow:0 3px 3px -2px rgba(0,0,0,.2),0 3px 4px 0 rgba(0,0,0,.14),0 1px 8px 0 rgba(0,0,0,.12)}`,
  `.pp-c>*{position:absolute}`,
  `.pp-cv{inset:0;width:100%;height:100%;object-fit:cover;filter:blur(4px);z-index:1}`,
  `.pp-ov{inset:0;background:rgba(0,0,0,${OVERLAY_OPACITY});z-index:2}`,
  `.pp-ct{inset:0;z-index:3;display:flex;flex-direction:column}`,
  `.pp-glass{position:absolute;z-index:0;backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)}`,
  `@supports (-moz-appearance:none){.pp-glass{backdrop-filter:none;background-color:rgba(0,0,0,.35)}}`,
  rcss('.pp-tw', { display: 'flex', 'justify-content': 'center', width: '100%', position: 'relative', 'z-index': '10', 'box-sizing': 'border-box', 'margin-top': CARD_PAD, 'margin-bottom': TITLE_MARGIN_BOTTOM, 'padding-left': CARD_PAD, 'padding-right': CARD_PAD }),
  `.pp-ti{position:relative;display:inline-block;max-width:100%}`,
  `.pp-ti .pp-glass{top:-15%;bottom:-15%;left:-20%;right:-20%;border-radius:12px;-webkit-mask-image:radial-gradient(ellipse at center,#000 40%,transparent 100%);mask-image:radial-gradient(ellipse at center,#000 40%,transparent 100%)}`,
  rcss('.pp-t', { position: 'relative', 'z-index': '1', 'font-weight': '700', 'line-height': '1.167', 'text-align': 'center', color: RED, 'text-shadow': '2px 2px 4px rgba(0,0,0,.8)', 'font-size': CARD_TITLE_FONT, overflow: 'hidden', display: '-webkit-box', '-webkit-line-clamp': '2', '-webkit-box-orient': 'vertical', margin: '0' }),
  rcss('.pp-d', { position: 'absolute', top: DESC_BOX_TOP, bottom: DESC_BOX_BOTTOM, left: CARD_PAD, right: CARD_PAD }),
  `.pp-d .pp-glass{top:-10px;left:-10px;right:-10px;bottom:-10px;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);-webkit-mask-image:radial-gradient(ellipse at center,#000 50%,transparent 90%);mask-image:radial-gradient(ellipse at center,#000 50%,transparent 90%)}`,
  rcss('.pp-dt', { position: 'relative', 'z-index': '1', height: '100%', overflow: 'hidden', 'line-height': '1.5', color: 'rgba(255,255,255,.9)', 'text-shadow': '1px 1px 2px rgba(0,0,0,.8)', 'font-size': CARD_TEXT_FONT, '-webkit-mask-image': 'linear-gradient(to bottom,#000 80%,transparent 100%)', 'mask-image': 'linear-gradient(to bottom,#000 80%,transparent 100%)' }),
  `.pp-dt p{margin:0 0 1em}`,
  rcss('.pp-tg', { position: 'absolute', bottom: TAG_BOX_BOTTOM, left: CARD_PAD, right: CARD_PAD }),
  rcss('.pp-tgs', { display: 'flex', 'flex-wrap': 'wrap', gap: '4px', overflow: 'hidden', 'align-content': 'flex-start', 'max-height': TAG_SECTION_HEIGHT, 'font-size': CARD_CHIP_FONT }),
  rcss('.pp-ch', { display: 'inline-flex', 'align-items': 'center', 'border-radius': '4px', color: '#fff', 'text-shadow': '0 1px 2px rgba(0,0,0,.8)', 'white-space': 'nowrap', padding: '0 8px', 'box-sizing': 'border-box', height: CARD_CHIP_HEIGHT, 'font-size': CARD_CHIP_FONT }),
  `.pp-ch.gold{border:1.5px solid ${GOLD_ACCENT};color:${GOLD_ACCENT};font-weight:700}`,
  rcss('.pp-m', { position: 'absolute', display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', bottom: META_BOX_BOTTOM, left: CARD_PAD, right: CARD_PAD }),
  rcss('.pp-au', { color: TEXT, 'text-shadow': '1px 1px 3px #030303', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': '50%', 'line-height': '1.43', 'font-size': CARD_META_FONT }),
  `.pp-cn{display:flex;align-items:center;flex-shrink:0}`,
  rcss('.pp-cn svg', { color: PINK, 'margin-right': '4px', width: CARD_META_ICON, height: CARD_META_ICON }),
  rcss('.pp-cn b', { color: '#fff', 'text-shadow': '1px 1px 2px #030303', 'line-height': '1.43', 'font-size': CARD_META_FONT }),
  `.pp-cn b:first-of-type{margin-right:8px}`,
  `.pp-bd{top:10px;right:10px;z-index:20;height:24px;padding:0 8px;border-radius:4px;display:flex;align-items:center;font-size:.8125rem;font-weight:700}`,
  `.pp-fresh{background:rgba(113,206,109,.95);color:#0b3d12;box-shadow:0 2px 4px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.25)}`,
  `.pp-bump{background:rgba(0,0,0,.4);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.8)}`,
  `.pp-sk{background:#161616;box-shadow:none}`,
].join('');

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${(ICONS[name] ?? []).map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Description HTML reduced to a safe subset (DOMParser never runs scripts or loads images; only
// text and a few inline/block tags are rebuilt). GameCard shows DOMPurify-sanitized HTML.
const SAFE = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'SPAN', 'DIV', 'UL', 'OL', 'LI']);
function safeHtml(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (n: Node): string => {
    if (n.nodeType === 3) return esc(n.textContent);
    if (n.nodeType !== 1) return '';
    const el = n as Element;
    const inner = Array.from(el.childNodes).map(walk).join('');
    const tag = el.tagName;
    if (!SAFE.has(tag)) return inner;
    const t = tag.toLowerCase();
    return t === 'br' ? '<br>' : `<${t}>${inner}</${t}>`;
  };
  return Array.from(doc.body.childNodes).map(walk).join('');
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

function lsJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

interface AuthRecord {
  id?: string;
  collectionId?: string;
  avatar?: string;
  blocked_games?: string[];
  blocked_authors?: string[];
  blocked_tags?: string[];
}

function header(mode: FeedMode, user: AuthRecord | null): string {
  const thumb = {
    sfw: { bg: '#43a047', fg: '#fff', pos: 'l' },
    all: { bg: '#bdbdbd', fg: '#1c1c1c', pos: 'c' },
    nsfw: { bg: '#d32f2f', fg: '#fff', pos: 'r' },
  }[mode];
  // Thumb travel inside the track's padding box (FilterSwitch getThumbStyle); per-variant offsets.
  const place = thumb.pos === 'l' ? 'left:3px' : thumb.pos === 'r' ? 'right:3px' : 'left:50%;transform:translateX(-50%)';
  // ShoutboxButton renders only with the cached feature flag '1'.
  let chatOn = false;
  try { chatOn = localStorage.getItem('shoutbox_enabled') === '1'; } catch { /* off */ }
  const avatar = user?.avatar && user.id
    ? ` style="background-image:url('/api/files/${esc(user.collectionId || '_pb_users_auth_')}/${esc(user.id)}/${esc(user.avatar)}?thumb=100x100')"`
    : '';
  return `<header class="pp-bar"><div class="pp-tb">`
    + `<div class="pp-logo">CYOA.CAFE</div><div class="pp-grow"></div>`
    + `<div class="pp-sw"><span class="pp-sw-l">SFW</span><div class="pp-trk">`
    + `<div class="pp-th" style="${place};background:${thumb.bg};color:${thumb.fg}">${mode}</div></div>`
    + `<span class="pp-sw-l">NSFW</span></div>`
    + `<div class="pp-ib">${icon('search')}</div><div class="pp-ib">${icon('add')}</div>`
    + (chatOn ? `<div class="pp-ib">${icon('chat')}</div>` : '')
    + (user
      ? `<div class="pp-ib">${icon('bell')}</div><div class="pp-av"${avatar}></div>`
      : `<div class="pp-ib">${icon('login')}</div><div class="pp-ib">${icon('more')}</div>`)
    + `</div></header>`;
}

function modeControls(): string {
  const ib = (n: string, on = false) => `<div class="pp-b${on ? ' on' : ''}">${icon(n)}</div>`;
  const tb = (t: string, on = false) => `<div class="pp-b t${on ? ' on' : ''}">${t}</div>`;
  // Default feed: no order button lit, period "All", format "All formats".
  return `<div class="pp-mc">`
    + `<div class="pp-g">${ib('newest')}${ib('top')}${ib('comment')}${ib('shuffle')}</div><div class="pp-dv"></div>`
    + `<div class="pp-g">${tb('Month')}${tb('Year')}${tb('All', true)}</div><div class="pp-dv"></div>`
    + `<div class="pp-g">${ib('apps', true)}${ib('image')}${ib('touch')}</div></div>`;
}

function panel(): string {
  const field = (ic: string, text: string, cls = '') => `<div class="pp-f${cls}">${icon(ic)}<span>${text}</span></div>`;
  return `<div class="pp-pn">${field('search', 'Title, author or tag...', ' pp-fb')}${modeControls()}</div>`
    + `<div class="pp-pw"><div class="pp-r3">${field('title', 'Title...')}${field('tag', 'Tags (e.g. RPG, -Horror)')}${field('author', 'Authors...')}</div>`
    + `<div class="pp-r1">${field('psychology', '...or describe what you want and search by meaning')}</div>${modeControls()}</div>`;
}

function card(g: SeedGame, pinned: boolean): string {
  const b64 = typeof g.image_base64 === 'string' ? g.image_base64 : '';
  const src = b64 ? (b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`) : '';
  const tags = g.expand?.tags ?? [];
  const cat = new Map(tags.map((t) => [t.id, t.category || undefined]));
  const gold = Array.isArray(g.gold_tags) ? (g.gold_tags as string[]) : [];
  const chips = sortCardTags(tags, (id) => cat.get(id), gold).map((t) => {
    const isGold = gold.includes(t.id);
    return `<span class="pp-ch${isGold ? ' gold' : ''}" style="background:${getTagColor(cat.get(t.id), t.name)}">${esc(t.name)}</span>`;
  }).join('');
  const meta = g as { original_release?: boolean; created?: string; bumped_at?: string };
  const badge = isFreshOriginal(meta) || pinned
    ? '<div class="pp-bd pp-fresh">Fresh</div>'
    : isFreshBump(meta) ? '<div class="pp-bd pp-bump">Bump!</div>' : '';
  return `<div class="pp-c">`
    + (src ? `<img class="pp-cv" src="${src}" alt="">` : '')
    + `<div class="pp-ov"></div>${badge}<div class="pp-ct">`
    + `<div class="pp-tw"><div class="pp-ti"><div class="pp-glass"></div><div class="pp-t">${esc(g.title || 'Untitled')}</div></div></div>`
    + `<div class="pp-d"><div class="pp-glass"></div><div class="pp-dt"><div>${safeHtml(String(g.description ?? ''))}</div></div></div>`
    + `<div class="pp-tg"><div class="pp-tgs">${chips}</div></div>`
    + `<div class="pp-m"><span class="pp-au">${esc(g.expand?.authors?.[0]?.name || 'Anonymous')}</span>`
    + `<span class="pp-cn">${icon('comment')}<b>${Number(g.comments_count) || 0}</b>${icon('favorite')}<b>${Number(g.upvotes_count) || 0}</b></span></div>`
    + `</div></div>`;
}

function run(): void {
  const root = document.getElementById('root');
  if (!root || root.dataset.prepaint) return;
  const raw = readCookie('cyoa_filter_mode');
  const mode: FeedMode = raw === 'all' || raw === 'nsfw' ? raw : 'sfw';
  const auth = lsJson<{ token?: string; record?: AuthRecord; model?: AuthRecord }>('pocketbase_auth');
  const user = auth?.token ? (auth.record ?? auth.model ?? null) : null;

  let body = '';
  if (location.pathname === '/' && !location.search) {
    const seen = new Set(lsJson<string[]>('pinned_seen_ids') ?? []);
    const seed = pickFeedSeed(mode, {
      tags: user?.blocked_tags ?? [],
      games: user?.blocked_games ?? [],
      authors: user?.blocked_authors ?? [],
    }, seen);
    const cards = seed
      ? seed.pins.map((g) => card(g, true)).join('') + seed.games.map((g) => card(g, false)).join('')
      // No snapshot (dev, old cache): skeletons hold the grid's height so nothing jumps.
      : '<div class="pp-c pp-sk"></div>'.repeat(10);
    body = `<main class="pp-main"><div class="pp-home">${panel()}<div class="pp-grid">${cards}</div></div></main>`;
  }
  root.dataset.prepaint = '1';
  root.innerHTML = `<style>${CSS}</style><div class="pp" aria-hidden="true">${header(mode, user)}${body}</div>`;
}

try {
  run();
} catch {
  // Cosmetic only: React renders regardless.
}
