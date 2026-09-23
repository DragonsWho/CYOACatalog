// "Create topic" is a full screen in place of the feed, not a modal (the old xs modal had a 3-row
// field, half a page of tags, the button somewhere below; an OP is up to 4000 chars and written
// LONG). Takes the center on wide screens, full screen on phones.
// 1. Space: the field grows to all free height; tags compressed into one chip row.
// 2. Markup: MarkdownBar + Preview tab (the custom markup was undiscoverable).
// 3. Draft: users swipe to another room mid-writing, so the draft survives unmount — in
// localStorage, not React state. Images are NOT in the draft (File can't go to localStorage;
// pretending is worse); [imgN] markers in text are kept.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, IconButton, InputAdornment,
  Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import MarkdownBar from './MarkdownBar';
import AnonMaskIcon from './AnonMaskIcon';
import AnonMaskDialog from './AnonMaskDialog';
import { OP_TEXT_MAX } from './OpPostField';
import OpBody from './OpBody';
import OpImageRow, { useOpSlotUrls } from './OpImageRow';
import {
  COMMUNITY_TITLE_MAX, createCommunityRoom, type CommunityRoom, type OpImageSlot,
} from './communityApi';
import { AuthContext } from '../../pocketbase/pocketbase';
import { anonIdentity } from '../Shoutbox/anonIdentity';
import { useAnonMask } from '../Shoutbox/anonMask';
import {
  EXTRA_TAGS, RATING_TAGS, TAG_INFO, type CommunityTag,
} from './communityTags';

// Caps mirror the server (shoutbox_community.go).
const TITLE_MIN = 3;
const TITLE_MAX = COMMUNITY_TITLE_MAX;
// Up to two "topic" tags: the content-rating tag takes the third of the three the schema allows
// (maxSelect 3).
const EXTRA_MAX = 2;

const DRAFT_KEY = 'cyoa.chat.threadDraft.v2';
// Drafts older than a week are garbage.
const DRAFT_TTL = 7 * 24 * 3600 * 1000;

type Draft = {
  title: string;
  op: string;
  rating: CommunityTag | null;
  extra: CommunityTag[];
  anon: boolean;
  ts: number;
};

function draftKey(identity: string) { return `${DRAFT_KEY}:${identity}`; }

function loadDraft(key: string): Draft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (!d || typeof d.title !== 'string' || Date.now() - (d.ts || 0) > DRAFT_TTL) return null;
    return d;
  } catch {
    return null;
  }
}

function clearDraft(key: string) {
  try { localStorage.removeItem(key); } catch { }
}

function saveDraft(key: string, draft: Draft) {
  try {
    if (!draft.title && !draft.op && !draft.rating && draft.extra.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(draft));
    }
  } catch { }
}

type Props = {
  onCancel: () => void;
  onDone: (room: CommunityRoom) => void;
};

// Tag chip exported for the moderation dialog (same choice of five; avoid fixing two copies).
export function TagChip({ tag, on, disabled, onClick }: {
  tag: CommunityTag;
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const info = TAG_INFO[tag];
  return (
    <Tooltip title={info.hint} disableInteractive>
      <Box
        component="button"
        type="button"
        aria-pressed={on}
        disabled={disabled && !on}
        onClick={onClick}
        sx={{
          px: 1.1,
          py: 0.3,
          borderRadius: 999,
          border: 1,
          borderColor: on ? info.color : 'divider',
          bgcolor: on ? info.color : 'transparent',
          color: on ? '#111' : 'text.secondary',
          opacity: disabled && !on ? 0.4 : 1,
          fontFamily: 'inherit',
          fontSize: 11.5,
          fontWeight: 800,
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
          cursor: disabled && !on ? 'default' : 'pointer',
          transition: 'background-color .12s, border-color .12s, color .12s',
          '&:hover': disabled && !on ? {} : { borderColor: info.color, color: on ? '#111' : 'text.primary' },
        }}
      >
        {info.label}
      </Box>
    </Tooltip>
  );
}

export default function ThreadComposer({ onCancel, onDone }: Props) {
  const { user } = useContext(AuthContext);
  const storageKey = draftKey(user?.id || 'guest');
  const saved = useRef<Draft | null>(loadDraft(storageKey));
  const [title, setTitle] = useState(saved.current?.title ?? '');
  const [op, setOp] = useState(saved.current?.op ?? '');
  const [rating, setRating] = useState<CommunityTag | null>(saved.current?.rating ?? null);
  const [extra, setExtra] = useState<CommunityTag[]>(saved.current?.extra ?? []);
  const [images, setImages] = useState<OpImageSlot[]>([]);
  const [preview, setPreview] = useState(false);
  // Anonymity defaults to self and is NOT remembered between topics: it's a per-conversation
  // decision; remembering could anonymously post a topic someone meant to sign.
  const [anon, setAnon] = useState(saved.current?.anon ?? !user);
  const [maskOpen, setMaskOpen] = useState(false);
  // Long-press on the mask = change name. Timer and flag in refs (nothing to re-render); the flag
  // prevents the finger release after a long press from also toggling the mask.
  const holdRef = useRef<number | null>(null);
  const heldRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restored = Boolean(saved.current && (saved.current.title || saved.current.op));

  const loadedKeyRef = useRef(storageKey);
  useEffect(() => {
    if (loadedKeyRef.current === storageKey) return;
    loadedKeyRef.current = storageKey;
    const next = loadDraft(storageKey);
    saved.current = next;
    setTitle(next?.title ?? '');
    setOp(next?.op ?? '');
    setRating(next?.rating ?? null);
    setExtra(next?.extra ?? []);
    setAnon(next?.anon ?? !user);
    setImages([]);
  }, [storageKey, user]);

  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const imgUrls = useOpSlotUrls(images);

  const draftRef = useRef<Draft>({ title, op, rating, extra, anon, ts: Date.now() });
  draftRef.current = { title, op, rating, extra, anon, ts: Date.now() };

  // Debounced draft write: localStorage on every letter = disk write in the input handler = laggy
  // typing on phones.
  useEffect(() => {
    const t = setTimeout(() => {
      saveDraft(storageKey, draftRef.current);
    }, 400);
    return () => clearTimeout(t);
  }, [title, op, rating, extra, anon, storageKey]);

  // The debounced write may still be pending when the user instantly leaves.
  useEffect(() => {
    const flush = () => saveDraft(storageKey, draftRef.current);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [storageKey]);

  // Insert the image marker at the cursor, not the end (unmarked images go to the end anyway).
  const insertToken = (n: number) => {
    const el = areaRef.current;
    const token = `[img${n}]`;
    const at = el?.selectionStart ?? op.length;
    const end = el?.selectionEnd ?? at;
    // Marker is a block: newlines around it avoid an image glued mid-sentence.
    const before = op.slice(0, at).replace(/\s+$/, '');
    const after = op.slice(end).replace(/^\s+/, '');
    const next = `${before}${before ? '\n\n' : ''}${token}${after ? '\n\n' : ''}${after}`;
    if (next.length > OP_TEXT_MAX) return;
    // Remove an existing marker with the same number: otherwise the image appears twice in text
    // while splitOpText shows it once — the text would lie.
    setOp(next);
    requestAnimationFrame(() => {
      const a = areaRef.current;
      if (!a) return;
      const caret = before.length + (before ? 2 : 0) + token.length;
      a.focus();
      a.setSelectionRange(caret, caret);
    });
  };

  const hasToken = (n: number) => new RegExp(`\\[img${n}\\]`).test(op);

  // Preview = same chunks and positions the reader will see (same OpBody). No sizes needed: files
  // are local and render instantly.
  const previewImages = images.map((_, i) => ({ url: imgUrls[i] || '' })).filter((v) => v.url);

  const mask = useAnonMask();
  const myName = user?.name || user?.username || 'me';
  const anonName = anonIdentity('', mask).name;

  const trimmed = title.trim();
  const ready = trimmed.length >= TITLE_MIN && trimmed.length <= TITLE_MAX && rating !== null;

  const toggleExtra = (t: CommunityTag) => {
    setExtra((cur) => (cur.includes(t)
      ? cur.filter((x) => x !== t)
      : cur.length >= EXTRA_MAX ? cur : [...cur, t]));
  };

  const submit = useCallback(async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const room = await createCommunityRoom({
        title: trimmed,
        opText: op.trim(),
        tags: [rating as CommunityTag, ...extra],
        images,
        anon: anon || !user,
        mask: anon || !user ? mask : undefined,
      });
      clearDraft(storageKey);
      draftRef.current = { title: '', op: '', rating: null, extra: [], anon: !user, ts: Date.now() };
      onDone(room);
    } catch (e) {
      // Daily quota and other refusals come as human text from the server — show as is.
      const msg = (e as { response?: { message?: string }; message?: string });
      setError(msg.response?.message || msg.message || 'Failed to create the thread.');
      setBusy(false);
    }
  }, [ready, busy, trimmed, op, rating, extra, images, anon, mask, user, storageKey, onDone]);

  // Ctrl/⌘+Enter submits from anywhere on the screen; Esc leaves (draft stays).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void submit(); }
    if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel(); }
  };

  const counter = `${op.trim().length}/${OP_TEXT_MAX}`;

  return (
    <Box
      onKeyDown={onKeyDown}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >

      {/*
        No own header on purpose: back arrow and "New thread" are in the chat bar above
        (ChatView.channelBar). Daily topic limit moved to the footer next to "Create thread".
      */}
      {/*
        The whole body scrolls: on phones with the keyboard up, tags and button are otherwise
        unreachable.
      */}
      <Box sx={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        px: { xs: 1, sm: 2 },
        py: 1.5,
      }}>
        {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

        {restored && (
          <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
            Picked up your saved draft.
            {' '}
            <Box
              component="button"
              type="button"
              onClick={() => {
                clearDraft(storageKey);
                setTitle(''); setOp(''); setRating(null); setExtra([]);
                setAnon(!user);
                saved.current = null;
              }}
              sx={{
                border: 0, bgcolor: 'transparent', p: 0, color: 'primary.light',
                fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              Start over
            </Box>
          </Typography>
        )}

        <TextField
          autoFocus
          fullWidth
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
          disabled={busy}
          placeholder="What is this thread about?"
          inputProps={{ 'aria-label': 'Thread title' }}
          sx={{ '& .MuiInputBase-input': { fontSize: 19, fontWeight: 700, py: 1.25 } }}
          // Counter inline at the right, only when something is typed; no caption line under the
          // field.
          InputProps={{
            endAdornment: trimmed.length ? (
              <InputAdornment position="end">
                <Box component="span" sx={{
                  fontSize: 11,
                  color: trimmed.length > TITLE_MAX - 8 ? 'warning.light' : 'text.disabled',
                }}>
                  {`${trimmed.length}/${TITLE_MAX}`}
                </Box>
              </InputAdornment>
            ) : undefined,
          }}
        />

        {/* Tags in one row: two groups, divider, small labels (choice of five chips). */}
        <Stack
          direction="row"
          alignItems="center"
          sx={{ flexWrap: 'wrap', gap: 0.75, rowGap: 0.75 }}
        >
          <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: 'text.disabled', letterSpacing: 0.6 }}>
            RATING
          </Typography>
          {RATING_TAGS.map((t) => (
            <TagChip
              key={t}
              tag={t}
              on={rating === t}
              onClick={() => setRating(rating === t ? null : t)}
            />
          ))}
          <Box sx={{ width: '1px', height: 16, bgcolor: 'divider', mx: 0.5, flexShrink: 0 }} />
          <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: 'text.disabled', letterSpacing: 0.6 }}>
            TOPIC
          </Typography>
          {EXTRA_TAGS.map((t) => (
            <TagChip
              key={t}
              tag={t}
              on={extra.includes(t)}
              disabled={extra.length >= EXTRA_MAX}
              onClick={() => toggleExtra(t)}
            />
          ))}
          {!rating && (
            <Typography sx={{ fontSize: 11, color: 'warning.light' }}>
              pick SFW or NSFW
            </Typography>
          )}
        </Stack>

        {/* One frame for markdown bar, field and footer: a "sheet", not three parts. */}
        <Box sx={{
          flex: 1,
          minHeight: { xs: 220, sm: 260 },
          display: 'flex',
          flexDirection: 'column',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1.5,
          overflow: 'hidden',
          bgcolor: 'rgba(255,255,255,0.02)',
        }}>
          <Box sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            borderBottom: 1,
            borderColor: 'divider',
            bgcolor: 'rgba(255,255,255,0.03)',
          }}>
            {/*
              In preview mode markdown buttons are meaningless, but the bar stays to keep sheet
              height stable.
            */}
            <Box sx={{ minWidth: 0, flex: 1, opacity: preview ? 0.35 : 1, pointerEvents: preview ? 'none' : 'auto' }}>
              <MarkdownBar areaRef={areaRef} value={op} onChange={setOp} max={OP_TEXT_MAX} disabled={busy} />
            </Box>
            <Box
              component="button"
              type="button"
              onClick={() => setPreview((v) => !v)}
              sx={{
                flexShrink: 0,
                mr: 0.5,
                px: 1,
                py: 0.3,
                border: 1,
                borderColor: preview ? 'primary.main' : 'divider',
                borderRadius: 1,
                bgcolor: preview ? 'rgba(252,52,71,0.16)' : 'transparent',
                color: preview ? 'text.primary' : 'text.secondary',
                fontFamily: 'inherit',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {preview ? 'Write' : 'Preview'}
            </Box>
          </Box>

          {preview ? (
            <Box sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              px: 1.5,
              py: 1.25,
              fontSize: 15,
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {op.trim() || previewImages.length
                ? <OpBody text={op} images={previewImages} />
                : <Box sx={{ opacity: 0.5 }}>Nothing to preview yet.</Box>}
            </Box>
          ) : (
            <Box
              component="textarea"
              ref={areaRef}
              value={op}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setOp(e.target.value.slice(0, OP_TEXT_MAX))}
              disabled={busy}
              // An invitation, not instructions (grey instructions on phones read as rules and get
              // skipped). The list matches the TOPIC chips above.
              placeholder="Anything goes here — a question, a rant, a WIP you want eyes on. Just mark it NSFW if things get spicy."
              aria-label="Opening post"
              sx={{
                flex: 1,
                minHeight: 0,
                width: '100%',
                resize: 'none',
                border: 0,
                outline: 'none',
                bgcolor: 'transparent',
                color: 'text.primary',
                fontFamily: 'inherit',
                fontSize: 15,
                lineHeight: 1.55,
                px: 1.5,
                py: 1.25,
                '&::placeholder': { color: 'text.disabled', opacity: 1 },
              }}
            />
          )}

          <Box sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 1,
            py: 0.5,
            borderTop: 1,
            borderColor: 'divider',
          }}>
            {/*
              Images as a strip UNDER the sheet, not a footer button: up to five, numbered and
              ordered.
            */}
            <Typography sx={{ fontSize: 11, color: 'text.disabled', display: { xs: 'none', sm: 'block' } }}>
              {images.length
                ? 'pictures below — place them with the ⤶ button'
                : 'markup: **bold**, *italic*, ||spoiler||, > quote'}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Typography sx={{
              flexShrink: 0,
              fontSize: 11,
              color: op.trim().length > OP_TEXT_MAX - 200 ? 'warning.light' : 'text.disabled',
            }}>
              {counter}
            </Typography>
          </Box>
        </Box>

        <OpImageRow
          slots={images}
          onSlots={setImages}
          urls={imgUrls}
          onInsert={insertToken}
          hasToken={hasToken}
          disabled={busy || !user}
        />
        <Typography sx={{ mt: -0.75, fontSize: 10.5, color: 'text.disabled' }}>
          {user
            ? "Images aren't included when this draft is restored."
            : 'Sign in to attach images; guests can publish text threads anonymously.'}
        </Typography>

      </Box>

      {/* Footer: "Create" at the bottom edge where phone users look; doesn't scroll away. */}
      <Box sx={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: { xs: 1, sm: 2 },
        py: 1,
        borderTop: 1,
        borderColor: 'divider',
        bgcolor: 'rgba(255,255,255,0.02)',
      }}>
        {/*
          Anonymous toggle as one icon next to "Create" (the last thing checked before posting).
          Mask name choice under long-press (also in chat settings): changed monthly vs toggled per
          topic — don't make the frequent action pay for the rare one.
        */}
        <Tooltip title={anon
          ? `Posting as ${anonName}${user ? ' — hold to rename, tap to use your name' : ' — hold to rename'}`
          : `Posting as ${myName} — tap to post behind an anon mask`}>
          <Box component="span" sx={{ flexShrink: 0, display: 'inline-flex' }}>
            <IconButton
              size="small"
              disabled={busy}
              aria-label={anon ? `Posting as ${anonName}` : 'Post behind an anon mask'}
              aria-pressed={anon}
              onClick={() => {
                if (heldRef.current) { heldRef.current = false; return; }
                if (!user) { setMaskOpen(true); return; }
                setAnon((v) => !v);
              }}
              onPointerDown={() => {
                heldRef.current = false;
                holdRef.current = window.setTimeout(() => {
                  heldRef.current = true;
                  holdRef.current = null;
                  setAnon(true);
                  setMaskOpen(true);
                }, 500);
              }}
              onPointerUp={() => { if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; } }}
              onPointerLeave={() => { if (holdRef.current) { clearTimeout(holdRef.current); holdRef.current = null; } }}
              // Right click = the same for mouse users; no browser menu needed here.
              onContextMenu={(e: React.MouseEvent) => { e.preventDefault(); setAnon(true); setMaskOpen(true); }}
              sx={{
                color: anon ? 'primary.main' : 'text.disabled',
                bgcolor: anon ? 'rgba(144,202,249,0.12)' : 'transparent',
                '&:hover': { bgcolor: anon ? 'rgba(144,202,249,0.2)' : 'rgba(255,255,255,0.06)' },
              }}
            >
              <AnonMaskIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
        </Tooltip>
        <AnonMaskDialog open={maskOpen} onClose={() => setMaskOpen(false)} />
        <Typography sx={{ fontSize: 11, color: 'text.disabled', minWidth: 0 }}>
          {`Posting as ${anon || !user ? anonName : myName}.`}
          {images.length ? ' Attached images are not restored with the saved draft.' : ''}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{
          flexShrink: 0, fontSize: 11, color: 'text.disabled',
          display: { xs: 'none', sm: 'block' }, mr: 0.5,
        }}>
          ten threads per day
        </Typography>
        <Button size="small" onClick={onCancel} disabled={busy} sx={{ flexShrink: 0 }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => void submit()}
          disabled={!ready || busy}
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}
          sx={{ flexShrink: 0, fontWeight: 800, px: 2.5 }}
        >
          Create thread
        </Button>
      </Box>
    </Box>
  );
}
