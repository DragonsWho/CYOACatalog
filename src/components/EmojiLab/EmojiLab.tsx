// Hidden page /emoji-lab: emoji pack inspection stand. The components (EmojiPicker, ReactionBar,
// EmojiImg) already run in the real chat; here the whole pack can be seen at once at feed size on
// different backgrounds to catch bad images before people see them. The feed is fake (hardcoded
// messages, reactions in tab memory, no server requests), but parsing is the real renderRichText,
// or the stand would lie.
// The Pack tab is the real pack admin panel for moderators (chat_emoji collection; edits go to the
// server immediately, no rebuild/deploy); others see the pack read-only. It does NOT convert
// animations: a third of the pack is animated webp and canvas extracts one frame, silently breaking
// them — python3 _dev/emoji_pack/build.py prepares those; the panel accepts finished .webp and
// compresses static png/jpg itself.

import { useContext, useMemo, useRef, useState } from 'react';
import {
  Alert, Avatar, Box, Button, Chip, CircularProgress, Divider, InputAdornment,
  Slider, Stack, Tab, Tabs, TextField, ToggleButton, ToggleButtonGroup, Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import AddReactionOutlinedIcon from '@mui/icons-material/AddReactionOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import VisibilityIcon from '@mui/icons-material/Visibility';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import EditIcon from '@mui/icons-material/Edit';

import EmojiImg from '../Emoji/EmojiImg';
import EmojiPicker from '../Emoji/EmojiPicker';
import ReactionBar from '../Emoji/ReactionBar';
import { renderRichText, emojiOnlyCount } from '../Shoutbox/richText';
import {
  EMOJI_SIZE, EmojiDef, ReactionMap, useEmojiPack,
} from '../Emoji/registry';
import {
  EMOJI_NAME_RE, createEmoji, deleteEmoji, moveEmoji, prepareEmoji,
  suggestName, updateEmoji,
} from '../Emoji/emojiAdminApi';
import { AuthContext } from '../../pocketbase/pocketbase';

const ME = 'me';

interface MockMessage {
  id: string;
  author: string;
  color: string;
  time: string;
  text: string;
  reactions: ReactionMap;
}

const SEED: MockMessage[] = [
  {
    id: 'm1',
    author: 'Dragonswho',
    color: '#b06fd0',
    time: '13:02',
    text: 'pushed a new CYOA to the catalog, someone take a look at the point balance',
    reactions: {},
  },
  {
    id: 'm2',
    author: 'anon',
    color: '#5865f2',
    time: '13:03',
    text: ':thumbs_up:',
    reactions: {},
  },
  {
    id: 'm3',
    author: 'Rhea',
    color: '#e0a458',
    time: '13:04',
    text: 'page three charges 40 points for that, which is just rude :panickedno:',
    reactions: { joy: ['u1', 'u2', 'u3'], fire: [ME] },
  },
  {
    id: 'm4',
    author: 'kit',
    color: '#3ba55d',
    time: '13:07',
    text: ':happy::fire::party_popper:',
    reactions: {},
  },
  {
    id: 'm5',
    author: 'Dragonswho',
    color: '#b06fd0',
    time: '13:09',
    // The text smiley must stay text: replacing ":3"/":D" with images must never happen in this
    // chat.
    text: 'guess it is paid content then, suffer :D',
    reactions: {
      skull: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7'],
      eyes: ['u1', 'u2'],
      crying_face: ['u1', 'u2', 'u3', ME],
      thumbs_down: ['u1'],
    },
  },
];

const BACKGROUNDS = [
  { key: 'chat', label: 'Chat', value: '#0f0f0f' },
  { key: 'paper', label: 'Lighter', value: '#26282c' },
  { key: 'white', label: 'White', value: '#ffffff' },
];

export default function EmojiLab() {
  const pack = useEmojiPack();
  const [tab, setTab] = useState(0);

  return (
    <Box sx={{ p: { xs: 1.5, md: 3 }, maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h5" gutterBottom>
        Emoji Lab{' '}
        <Typography component="span" variant="caption" sx={{ color: '#888' }}>
          (hidden · chat emoji and reactions)
        </Typography>
      </Typography>

      {pack.failed && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load the emoji pack from the server. The chat still works —
          shortcodes just stay as text.
        </Alert>
      )}
      {!pack.ready && !pack.failed && <CircularProgress size={24} />}

      {pack.ready && (
        <>
          <Tabs value={tab} onChange={(_, v: number) => setTab(v)} sx={{ mb: 2 }}>
            <Tab label="Feed" />
            <Tab label={`Pack (${pack.everything.length})`} />
          </Tabs>
          {tab === 0 ? <ChatPreview pack={pack} /> : <PackManager pack={pack} />}
        </>
      )}
    </Box>
  );
}

type Pack = ReturnType<typeof useEmojiPack>;

function ChatPreview({ pack }: { pack: Pack }) {
  const [messages, setMessages] = useState<MockMessage[]>(SEED);
  const [bg, setBg] = useState(BACKGROUNDS[0].value);
  const [inlineSize, setInlineSize] = useState(EMOJI_SIZE.inline);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLInputElement>(null);
  const [composerPicker, setComposerPicker] = useState(false);
  const composerBtnRef = useRef<HTMLButtonElement>(null);

  // Same toggle as the server: a second press removes the reaction and an emptied name drops from
  // the map (no accumulated zeros).
  const toggleReaction = (msgId: string, name: string) => {
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const uids = m.reactions[name] ?? [];
      const next = uids.includes(ME) ? uids.filter((u) => u !== ME) : [...uids, ME];
      const reactions = { ...m.reactions };
      if (next.length) reactions[name] = next;
      else delete reactions[name];
      return { ...m, reactions };
    }));
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [...prev, {
      id: `m${Date.now()}`,
      author: 'you',
      color: '#00b0ff',
      time: new Date().toTimeString().slice(0, 5),
      text,
      reactions: {},
    }]);
    setDraft('');
  };

  return (
    <>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ sm: 'center' }}
        sx={{ mb: 2 }}
      >
        <ToggleButtonGroup
          size="small"
          exclusive
          value={bg}
          onChange={(_, v: string | null) => v && setBg(v)}
        >
          {BACKGROUNDS.map((b) => (
            <ToggleButton key={b.key} value={b.value} sx={{ textTransform: 'none' }}>
              {b.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Box sx={{ width: 220 }}>
          <Typography variant="caption" sx={{ color: '#888' }}>
            Inline size: {inlineSize}px
          </Typography>
          <Slider
            size="small"
            min={18}
            max={40}
            value={inlineSize}
            onChange={(_, v) => setInlineSize(v as number)}
          />
        </Box>
      </Stack>

      <Typography variant="caption" sx={{ color: '#777', display: 'block', mb: 1 }}>
        Hover a message for the quick row. Unicode 😄 and text smileys like :D are
        never replaced — only explicit :shortcodes: from the pack.
      </Typography>

      <Box sx={{ bgcolor: bg, borderRadius: 2, py: 1, transition: 'background-color .2s' }}>
        {messages.map((m) => (
          <MockRow
            key={m.id}
            msg={m}
            pack={pack}
            inlineSize={inlineSize}
            light={bg === '#ffffff'}
            onToggle={(name) => toggleReaction(m.id, name)}
          />
        ))}
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 2 }} alignItems="flex-start">
        <TextField
          inputRef={composerRef}
          fullWidth
          size="small"
          placeholder="Type something and drop in an :emoji:…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          InputProps={{
            endAdornment: (
              <InputAdornment position="end">
                <Box
                  component="button"
                  ref={composerBtnRef}
                  type="button"
                  onClick={() => setComposerPicker(true)}
                  sx={{
                    all: 'unset', cursor: 'pointer', display: 'flex', color: '#999',
                    '&:hover': { color: '#fff' },
                  }}
                >
                  <AddReactionOutlinedIcon fontSize="small" />
                </Box>
              </InputAdornment>
            ),
          }}
        />
        <Button variant="contained" onClick={send}>Send</Button>
      </Stack>

      <EmojiPicker
        open={composerPicker}
        anchorEl={composerBtnRef.current}
        onClose={() => setComposerPicker(false)}
        emoji={pack.all}
        quick={pack.quick}
        keepOpen
        onPick={(e) => {
          setDraft((d) => `${d}${d && !d.endsWith(' ') ? ' ' : ''}:${e.name}: `);
          composerRef.current?.focus();
        }}
      />
    </>
  );
}

function MockRow({
  msg, pack, inlineSize, light, onToggle,
}: {
  msg: MockMessage;
  pack: Pack;
  inlineSize: number;
  light: boolean;
  onToggle: (name: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  // Parsing is shared with chat, incl. "emoji-only messages render large".
  const jumbo = emojiOnlyCount(msg.text);
  const body = useMemo(
    () => renderRichText(msg.text, {
      emojiSize: jumbo ? EMOJI_SIZE.jumbo : inlineSize,
    }),
    [msg.text, inlineSize, jumbo],
  );

  const textColor = light ? '#111' : '#dcddde';
  const metaColor = light ? '#666' : '#888';

  return (
    <Box
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        position: 'relative',
        display: 'flex',
        gap: 1.5,
        px: 2,
        py: 0.75,
        '&:hover': { bgcolor: light ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.03)' },
      }}
    >
      <Avatar sx={{ width: 36, height: 36, bgcolor: msg.color, fontSize: 15 }}>
        {msg.author[0].toUpperCase()}
      </Avatar>

      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="baseline">
          <Typography variant="body2" sx={{ fontWeight: 700, color: msg.color }}>
            {msg.author}
          </Typography>
          <Typography variant="caption" sx={{ color: metaColor }}>{msg.time}</Typography>
        </Stack>

        <Typography
          variant="body2"
          sx={{
            color: textColor,
            wordBreak: 'break-word',
            lineHeight: jumbo ? 1 : 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {body}
        </Typography>

        <ReactionBar
          reactions={msg.reactions}
          meId={ME}
          onToggle={onToggle}
          // "+" in the pill row only once reactions exist: the first comes from the hover panel;
          // two pluses at once is noise.
          showAdd={Object.keys(msg.reactions).length > 0}
        />
      </Box>

      {/*
        Discord-style hover panel over the message's right edge. In the real chat the corner button
        in MessageRow plays this role.
      */}
      {hovered && pack.quick.length > 0 && (
        <Stack
          direction="row"
          spacing={0.25}
          sx={{
            position: 'absolute',
            top: -10,
            right: 12,
            bgcolor: '#1a1a1a',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 1.5,
            p: 0.25,
            zIndex: 2,
            boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
          }}
        >
          {pack.quick.slice(0, 6).map((e) => (
            <Tooltip key={e.name} title={`:${e.name}:`} placement="top" enterDelay={400}>
              <Box
                component="button"
                type="button"
                onClick={() => onToggle(e.name)}
                sx={{
                  all: 'unset',
                  cursor: 'pointer',
                  p: 0.5,
                  borderRadius: 1,
                  display: 'flex',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' },
                }}
              >
                <EmojiImg emoji={e} size={20} animate />
              </Box>
            </Tooltip>
          ))}
          <Box
            component="button"
            ref={addRef}
            type="button"
            onClick={() => setPickerOpen(true)}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              p: 0.5,
              borderRadius: 1,
              display: 'flex',
              color: '#aaa',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.12)', color: '#fff' },
            }}
          >
            <AddReactionOutlinedIcon sx={{ fontSize: 20 }} />
          </Box>
        </Stack>
      )}

      <EmojiPicker
        open={pickerOpen}
        anchorEl={addRef.current}
        onClose={() => setPickerOpen(false)}
        emoji={pack.all}
        quick={pack.quick}
        onPick={(e) => onToggle(e.name)}
      />
    </Box>
  );
}

type PackFilter = 'all' | 'service' | 'anime' | 'animated' | 'opaque' | 'heavy'
  | 'ugly' | 'hidden';

const FILTERS: { key: PackFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'service', label: 'Service' },
  { key: 'anime', label: 'Anime' },
  { key: 'animated', label: 'Animated' },
  { key: 'opaque', label: 'No transparency' },
  { key: 'heavy', label: 'Over 60 KB' },
  { key: 'ugly', label: 'Awkward names' },
  { key: 'hidden', label: 'Hidden' },
];

// Shortcodes are typed by hand ("chpic_su_ahegaoemoji_by_fstikbot_021" can't be). Same threshold as
// build.py so lists match.
const isUgly = (e: EmojiDef) => e.name.length > 20 || /^\d+$/.test(e.name);
const HEAVY_BYTES = 60 * 1024;

// A picked but unsent file: the name can be fixed before upload ("5390-no" is no shortcode).
interface Pending {
  key: string;
  name: string;
  blob?: Blob;
  w: number;
  h: number;
  error?: string;
  preview?: string;
}

function PackManager({ pack }: { pack: Pack }) {
  const { isModerator } = useContext(AuthContext);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<PackFilter>('all');
  const [tiny, setTiny] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState('');
  // Escape blurs, and blur saves — without this flag cancel would save exactly what was abandoned.
  const renameCancelled = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const items = pack.everything;

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((e) => {
      if (needle && !e.name.includes(needle)) return false;
      switch (filter) {
        case 'service': return e.pack === 'service';
        case 'anime': return e.pack === 'anime';
        case 'animated': return e.animated;
        case 'opaque': return e.opaque;
        case 'heavy': return e.bytes >= HEAVY_BYTES;
        case 'ugly': return isUgly(e);
        case 'hidden': return e.hidden;
        default: return true;
      }
    });
  }, [items, q, filter]);

  const totalKb = items.reduce((n, e) => n + e.bytes, 0) / 1024;
  // Arrows move within the pack's global order, not the filtered view (a filtered step often
  // changes nothing visible).
  const narrowed = filter !== 'all' || q.trim() !== '';

  // One wrapper for all edits: busy, error, no local state — the pack is refetched whole after each
  // edit (emojiAdminApi).
  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy('');
    }
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setErr('');
    const next: Pending[] = [];
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2, 8)}`;
      try {
        const prepared = await prepareEmoji(file);
        next.push({
          key,
          name: suggestName(file.name),
          blob: prepared.blob,
          w: prepared.w,
          h: prepared.h,
          preview: URL.createObjectURL(prepared.blob),
        });
      } catch (e) {
        next.push({
          key,
          name: suggestName(file.name),
          w: 0,
          h: 0,
          error: e instanceof Error ? e.message : 'Could not read this file',
        });
      }
    }
    setPending((cur) => [...cur, ...next]);
  };

  const uploadPending = () => run('new', async () => {
    const failures: Pending[] = [];
    for (const item of pending) {
      if (!item.blob) { failures.push(item); continue; }
      if (!EMOJI_NAME_RE.test(item.name)) {
        failures.push({ ...item, error: 'Name must be 2-32 chars of a-z, 0-9 and _' });
        continue;
      }
      try {
        await createEmoji({
          name: item.name,
          pack: 'anime',
          source: item.key.split(':')[0],
          w: item.w,
          h: item.h,
          file: item.blob,
        });
        if (item.preview) URL.revokeObjectURL(item.preview);
      } catch (e) {
        failures.push({ ...item, error: e instanceof Error ? e.message : 'Upload failed' });
      }
    }
    setPending(failures);
    if (failures.length > 0) throw new Error(`${failures.length} of ${pending.length} could not be uploaded`);
  });

  // No drag-and-drop on purpose: dragging a row through a grid of a hundred cells is worse than
  // arrows; the neighbor is computed server-side by global order.
  const move = (id: string, dir: 'up' | 'down' | 'top') =>
    run(id, () => moveEmoji(id, dir));

  // Rename is saved on Enter or on blur — don't lose typing on a misclick.
  const commitRename = (e: EmojiDef, raw: string) => {
    setEditing('');
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    const name = raw.trim().toLowerCase();
    if (!name || name === e.name) return;
    if (!EMOJI_NAME_RE.test(name)) {
      setErr('A shortcode is 2-32 characters of a-z, 0-9 and _ — nothing else.');
      return;
    }
    void run(e.id, () => updateEmoji(e.id, { name }));
  };

  return (
    <>
      {!isModerator && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Viewing the pack. Editing it is moderators-only.
        </Alert>
      )}
      {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

      {isModerator && (
        <Box
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void addFiles(e.dataTransfer.files); }}
          sx={{
            mb: 2, p: 2, borderRadius: 1, textAlign: 'center',
            border: '1px dashed rgba(255,255,255,0.25)',
          }}
        >
          <Typography variant="body2" sx={{ color: '#aaa' }}>
            Drop PNG or JPG here — they get squeezed to 128px WebP in the browser.
            <br />
            Animated ones have to come from{' '}
            <code>python3 _dev/emoji_pack/build.py</code> — drop the .webp it makes.
          </Typography>
          <Button size="small" sx={{ mt: 1 }} onClick={() => fileInput.current?.click()}>
            Pick files
          </Button>
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
          />
        </Box>
      )}

      {pending.length > 0 && (
        <Box sx={{ mb: 2, p: 1.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)' }}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Ready to upload ({pending.length}) — check the shortcodes first
          </Typography>
          <Stack spacing={1}>
            {pending.map((item, idx) => (
              <Stack key={item.key} direction="row" spacing={1} alignItems="center">
                <Box sx={{ width: 40, height: 40, bgcolor: '#0f0f0f', borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {item.preview && (
                    <Box component="img" src={item.preview} alt="" sx={{ maxWidth: 36, maxHeight: 36 }} />
                  )}
                </Box>
                <TextField
                  size="small"
                  value={item.name}
                  disabled={Boolean(item.error) && !item.blob}
                  error={Boolean(item.name) && !EMOJI_NAME_RE.test(item.name)}
                  onChange={(e) => setPending((cur) => cur.map((x, i) =>
                    (i === idx ? { ...x, name: e.target.value.toLowerCase() } : x)))}
                  sx={{ width: 220 }}
                />
                <Typography variant="caption" sx={{ flex: 1, color: item.error ? '#e57373' : '#888' }}>
                  {item.error ?? `${item.w}×${item.h} · ${((item.blob?.size ?? 0) / 1024).toFixed(1)} KB`}
                </Typography>
                <Button
                  size="small"
                  onClick={() => setPending((cur) => cur.filter((_, i) => i !== idx))}
                >
                  Remove
                </Button>
              </Stack>
            ))}
          </Stack>
          <Button
            variant="contained"
            size="small"
            sx={{ mt: 1.5 }}
            disabled={busy === 'new' || !pending.some((x) => x.blob)}
            onClick={uploadPending}
          >
            {busy === 'new' ? 'Uploading…' : `Upload ${pending.filter((x) => x.blob).length}`}
          </Button>
        </Box>
      )}

      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Quick row ({pack.quick.length}) — starred emoji, in pack order
      </Typography>
      <Stack
        direction="row"
        spacing={0.5}
        flexWrap="wrap"
        useFlexGap
        sx={{
          mb: 2, p: 1, minHeight: 52, alignItems: 'center',
          bgcolor: 'rgba(255,255,255,0.04)', borderRadius: 1,
        }}
      >
        {pack.quick.length === 0 && (
          <Typography variant="caption" sx={{ color: '#888' }}>
            Empty — star a few below.
          </Typography>
        )}
        {pack.quick.map((e) => (
          <Tooltip key={e.id} title={`:${e.name}:`}>
            <Box sx={{ bgcolor: 'rgba(255,255,255,0.06)', borderRadius: 1, p: 0.5, display: 'flex' }}>
              <EmojiImg emoji={e} size={24} animate />
            </Box>
          </Tooltip>
        ))}
      </Stack>

      <Divider sx={{ mb: 2 }} />

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          placeholder="Search by name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ minWidth: 220 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" sx={{ color: '#777' }} />
              </InputAdornment>
            ),
          }}
        />
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {FILTERS.map((f) => (
            <Chip
              key={f.key}
              label={f.label}
              size="small"
              color={filter === f.key ? 'primary' : 'default'}
              onClick={() => setFilter(f.key)}
            />
          ))}
        </Stack>
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
        <Button
          size="small"
          variant={tiny ? 'contained' : 'outlined'}
          onClick={() => setTiny((v) => !v)}
        >
          22px check
        </Button>
        <Typography variant="caption" sx={{ color: '#888' }}>
          {shown.length} of {items.length} · pack {totalKb.toFixed(0)} KB
        </Typography>
      </Stack>

      {/*
        Small mode: the only honest way to know an emoji reads in the feed is to see it at real
        size.
      */}
      {tiny ? (
        <Box sx={{
          display: 'flex', flexWrap: 'wrap', gap: 1, p: 1.5, bgcolor: '#0f0f0f', borderRadius: 1,
        }}
        >
          {shown.map((e) => (
            <Tooltip key={e.id} title={`:${e.name}:`}>
              <Box><EmojiImg emoji={e} size={22} animate /></Box>
            </Tooltip>
          ))}
        </Box>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
            gap: 1,
          }}
        >
          {shown.map((e) => (
            <Box
              key={e.id}
              sx={{
                p: 1, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
                opacity: e.hidden ? 0.45 : 1,
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center">
                <Box sx={{ bgcolor: '#0f0f0f', borderRadius: 1, p: 0.5, display: 'flex' }}>
                  <EmojiImg emoji={e} size={40} animate />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  {editing === e.id ? (
                    <TextField
                      size="small"
                      autoFocus
                      fullWidth
                      defaultValue={e.name}
                      onFocus={(ev) => ev.target.select()}
                      onBlur={(ev) => commitRename(e, ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Escape') renameCancelled.current = true;
                        if (ev.key !== 'Escape' && ev.key !== 'Enter') return;
                        (ev.target as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    <Typography
                      variant="caption"
                      onClick={() => isModerator && setEditing(e.id)}
                      sx={{
                        display: 'block', fontFamily: 'monospace', color: '#ddd',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        cursor: isModerator ? 'text' : 'default',
                      }}
                      title={isModerator ? 'Click to rename' : `:${e.name}:`}
                    >
                      :{e.name}:
                    </Typography>
                  )}
                  <Typography variant="caption" sx={{ color: '#777' }}>
                    {(e.bytes / 1024).toFixed(1)} KB{e.animated ? ' · animated' : ''}
                  </Typography>
                </Box>
              </Stack>

              <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                <Typography variant="caption" sx={{ color: '#666' }}>
                  {e.pack}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {isUgly(e) && (
                  <Tooltip title="Nobody will type this by hand — rename it">
                    <WarningAmberIcon sx={{ fontSize: 16, color: '#888' }} />
                  </Tooltip>
                )}
                {e.opaque && (
                  <Tooltip title="No transparency — a bright brick on the dark feed">
                    <WarningAmberIcon sx={{ fontSize: 16, color: '#e0a458' }} />
                  </Tooltip>
                )}
              </Stack>

              {isModerator && (
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ mt: 0.5 }}>
                  <Tooltip title={e.quick ? 'Remove from the quick row' : 'Add to the quick row'}>
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id}
                        onClick={() => run(e.id, () => updateEmoji(e.id, { quick: !e.quick }))}
                        sx={{ minWidth: 32, px: 0.5 }}
                      >
                        {e.quick
                          ? <StarIcon sx={{ fontSize: 16, color: '#e0a458' }} />
                          : <StarBorderIcon sx={{ fontSize: 16 }} />}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title={e.hidden ? 'Show in the picker' : 'Hide from the picker (old messages keep it)'}>
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id}
                        onClick={() => run(e.id, () => updateEmoji(e.id, { hidden: !e.hidden }))}
                        sx={{ minWidth: 32, px: 0.5 }}
                      >
                        {e.hidden
                          ? <VisibilityOffIcon sx={{ fontSize: 16 }} />
                          : <VisibilityIcon sx={{ fontSize: 16 }} />}
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="Rename">
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id}
                        onClick={() => setEditing(e.id)}
                        sx={{ minWidth: 32, px: 0.5 }}
                      >
                        <EditIcon sx={{ fontSize: 16 }} />
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title={narrowed ? 'Clear the search and filter to reorder' : 'One step earlier'}>
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id || narrowed}
                        onClick={() => move(e.id, 'up')}
                        sx={{ minWidth: 26, px: 0 }}
                      >
                        <ChevronLeftIcon sx={{ fontSize: 16 }} />
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title={narrowed ? 'Clear the search and filter to reorder' : 'One step later'}>
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id || narrowed}
                        onClick={() => move(e.id, 'down')}
                        sx={{ minWidth: 26, px: 0 }}
                      >
                        <ChevronRightIcon sx={{ fontSize: 16 }} />
                      </Button>
                    </span>
                  </Tooltip>
                  <Tooltip title="To the very top of the pack">
                    <span>
                      <Button
                        size="small"
                        disabled={busy === e.id}
                        onClick={() => move(e.id, 'top')}
                        sx={{ minWidth: 26, px: 0 }}
                      >
                        <VerticalAlignTopIcon sx={{ fontSize: 16 }} />
                      </Button>
                    </span>
                  </Tooltip>
                  <Box sx={{ flex: 1 }} />
                  <Tooltip title="Delete for good">
                    <span>
                      <Button
                        size="small"
                        color="error"
                        disabled={busy === e.id}
                        onClick={() => {
                          // Deliberately crude confirmation: the button sits in a grid of a hundred
                          // cells; a misclick must not cost an image.
                          if (window.confirm(`Delete :${e.name}: for good?`)) {
                            void run(e.id, () => deleteEmoji(e.id));
                          }
                        }}
                        sx={{ minWidth: 32, px: 0.5 }}
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                      </Button>
                    </span>
                  </Tooltip>
                </Stack>
              )}
            </Box>
          ))}
        </Box>
      )}
    </>
  );
}
