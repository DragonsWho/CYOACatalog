// Chat composer: text, image, anonymity, @mention autocomplete, state strips above the field
// (reply, edit, attached image).
// Separate component because typed text is the most frequently changing state: while it lived in
// ChatView every keystroke re-rendered the whole screen incl. the feed (memoized, but React still
// diffs props of hundreds of rows per KEYSTROKE). Everything only the field needs lives here.
// Exposes exactly three things (ComposerHandle): insert @name, take focus, ask whether there's
// something to send.

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import {
  Avatar, Box, Chip, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import CloseIcon from '@mui/icons-material/Close';
import ReplyOutlinedIcon from '@mui/icons-material/ReplyOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import EmojiEmotionsOutlinedIcon from '@mui/icons-material/EmojiEmotionsOutlined';
import TextFormatIcon from '@mui/icons-material/TextFormat';
import AnonMaskIcon from './AnonMaskIcon';
import MarkdownBar from './MarkdownBar';
import { setChatPref, useChatPrefs } from './chatPrefs';
import EmojiPicker from '../Emoji/EmojiPicker';
import { useEmojiPack } from '../Emoji/registry';
import { anonIdentity } from '../Shoutbox/anonIdentity';
import { useAnonMask } from '../Shoutbox/anonMask';
import { useChatNotes } from '../Shoutbox/chatNotes';
import AnonMaskDialog from './AnonMaskDialog';
import { TOUCH_ONLY } from '../Shoutbox/touchDevice';
import { useReloadHold } from '../../utils/appReload';
import {
  MentionUser, ShoutMessage, avatarUrlOf, searchMentionUsers,
} from '../Shoutbox/shoutboxApi';

// Length cap: guest 300, logged-in 1500; the same numbers live on the server (shoutLenLimit in
// shoutbox.go) and in the text field schema. They must not diverge: the browser would silently
// truncate or the server would refuse.
export const MAX_LEN = 300;
export const MAX_LEN_USER = 1500;
// Paired with shoutImageMaxBytes (shoutbox_v2.go) and maxSize of the PB image field. All three must
// match, or the user learns of a refusal after losing the typed text, or gets "Failed to save
// message" instead of a reason.
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
// Accepted clipboard/drag types — same list as the schema image field and shoutImageMIME on the
// server.
const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const MENTION_TAIL = /@([A-Za-z0-9_]{1,30})$/;

// The anonymous mask survives reload: turned on once means "about me", not one message. Per
// browser, not account — syncing across devices would unmask where not asked.
const ANON_KEY = 'shoutbox_anon';
const DRAFT_PREFIX = 'cyoa.chat.messageDraft.v1:';

type MessageDraft = {
  text: string;
  reply: ShoutMessage | null;
  ts: number;
};

// Files cannot survive a reload, but they can and should survive moving to the thread list or
// another room in the same tab.
const draftImages = new Map<string, File>();

function loadMessageDraft(key: string): MessageDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as MessageDraft;
    return draft && typeof draft.text === 'string' ? draft : null;
  } catch {
    return null;
  }
}

function saveMessageDraft(key: string, text: string, reply: ShoutMessage | null, image: File | null) {
  if (image) draftImages.set(key, image); else draftImages.delete(key);
  try {
    if (!text && !reply) localStorage.removeItem(DRAFT_PREFIX + key);
    else localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text, reply, ts: Date.now() }));
  } catch { }
}


// One look for all three strips above the field (reply, edit, image): inconsistency over the same
// field reads as broken.
const STRIP_SX = {
  mb: 0.5,
  px: 1,
  py: 0.5,
  borderRadius: 2,
  bgcolor: 'rgba(255,255,255,0.04)',
} as const;

const WRAP_SX = {
  flexShrink: 0,
  px: { xs: 0.75, sm: 1.25 },
  pt: 0.75,
  pb: 1,
  borderTop: 1,
  borderColor: 'divider',
  bgcolor: 'background.default',
} as const;

// The pill has two looks built from ONE set of elements rearranged via flex `order`, not two markup
// branches: expansion happens on focus, and moving the field in the React tree remounts the
// textarea — focus lost right as typing starts.
// read: [mask][image][emoji][ field ][send]
// write: [ markdown bar ] [ field ] [mask][image][emoji][Aa] [send]
// In read mode icons ate a third of the field width on phones.
const PILL_SX = {
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
  '&[data-open="1"]': {
    flexWrap: 'wrap',
    alignItems: 'center',
    px: 0.75,
    py: 0.5,
    '& .cmp-md': { order: -2, width: '100%' },
    '& .cmp-field': { order: -1, width: '100%' },
    // Send sits at the right edge: it ends the action, not one of the icons.
    '& .cmp-send': { ml: 'auto', mb: 0 },
    '& .cmp-count': { alignSelf: 'center', mb: 0 },
  },
} as const;

const STRIP_ICON_SX = { fontSize: 15, color: 'text.secondary' } as const;
const EDIT_ICON_SX = { fontSize: 15, color: 'warning.main' } as const;
const CLOSE_BTN_SX = { p: 0.25 } as const;
const CLOSE_ICON_SX = { fontSize: 15 } as const;
const STRIP_TEXT_SX = { flex: 1 } as const;
const THUMB_SX = { width: 36, height: 36, objectFit: 'cover', borderRadius: 1.5 } as const;
const MENTIONS_SX = { mb: 0.5, flexWrap: 'wrap', gap: 0.5 } as const;
const FIELD_SX = {
  // 16px is not aesthetics but iOS: with a smaller font Safari zooms the page on field focus and
  // the chat slides off-screen.
  '& .MuiInputBase-root': { fontSize: 16, px: 0.75, py: 0.75 },
} as const;
// enterKeyHint on touch screens shows "newline", not "send" — otherwise the key promises one thing
// and does another.
const FIELD_SLOTS = {
  input: { disableUnderline: true },
  htmlInput: TOUCH_ONLY ? { enterKeyHint: 'enter' as const } : undefined,
} as const;
const FOOTNOTE_SX = {
  display: 'block', mt: 0.5, px: 1, fontSize: 11, opacity: 0.8,
} as const;

export type ComposerHandle = {
  focus(): void;
  insertMention(username: string): void;
  // Attach an image dropped on the feed (the screen catches the drag). Same checks as the file
  // button — they live in one place, not three.
  attachImage(file: File): void;
};

export type ComposerProps = {
  signedIn: boolean;
  anonKey: string;
  // Private room or DM → mask hidden: nothing to hide among few visible members, and in a DM
  // "anonymous" is just your peer. The server refuses the mask there anyway (shoutApplyV2Fields);
  // the button just doesn't lie.
  privateChannel?: boolean;
  // Account/guest + channel. A draft must never silently move to another recipient just because
  // this component stayed mounted.
  draftKey: string;
  placeholder: string;
  replyTo: ShoutMessage | null;
  editing: ShoutMessage | null;
  onCancelReply: () => void;
  onRestoreReply: (message: ShoutMessage | null) => void;
  onCancelEdit: () => void;
  onSubmit: (text: string, opts: { image: File | null; anon: boolean }) => Promise<boolean>;
  onError: (msg: string) => void;
  // Field grew/shrank (focus expansion, reply strip). The feed doesn't know — it just gets shorter,
  // and a bottom-pinned reader loses the last line right when about to reply.
  onResize?: () => void;
  // Up-arrow edit: which message is "last own" and whether it's editable is known by the feed, so
  // the screen decides.
  onEditLast?: () => void;
};

function Composer({
  signedIn, anonKey, privateChannel, draftKey, placeholder, replyTo, editing,
  onCancelReply, onRestoreReply, onCancelEdit, onSubmit, onError, onEditLast, onResize,
}: ComposerProps, ref: React.Ref<ComposerHandle>) {
  // One variable for the limit: counter, input truncation and @name insertion truncation must use
  // the same number.
  const maxLen = signedIn ? MAX_LEN_USER : MAX_LEN;
  // Anonymous signature lives in the browser; subscribed so "Posting as …" updates right after
  // saving.
  const mask = useAnonMask();
  // Reader-assigned names: "Replying to …" must name the person like the feed (MessageRow) does.
  const { notes } = useChatNotes();
  const [text, setText] = useState('');
  // An unsent message survives a deploy: while the field has text, the tab won't auto-reload
  // (utils/appReload.ts).
  useReloadHold('chat-draft', text.trim().length > 0);
  const [anon, setAnon] = useState(() => {
    try { return localStorage.getItem(ANON_KEY) === '1'; } catch { return false; }
  });
  const [image, setImage] = useState<File | null>(null);
  const [maskOpen, setMaskOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [mentionQ, setMentionQ] = useState('');
  const [mentionOpts, setMentionOpts] = useState<MentionUser[]>([]);

  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiPack = useEmojiPack();
  // Field stays expanded while being WORKED on, not while focused: users leave to pick
  // emoji/image/another window, and a collapsing field would look like a lost draft. Collapse only
  // when focus left AND nothing to send.
  const [focused, setFocused] = useState(false);
  const { mdBarOpen } = useChatPrefs();

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Latest committed draft values. Updated in an effect so the cleanup for an old draftKey still
  // sees the old room's reply prop during a room switch.
  const draftSnapshotRef = useRef<{ text: string; reply: ShoutMessage | null; image: File | null }>({
    text: '', reply: null, image: null,
  });
  useEffect(() => {
    if (!editing) draftSnapshotRef.current = { text, reply: replyTo, image };
  }, [text, replyTo, image, editing]);

  // Load only this room's draft. Cleanup is the synchronous final write which also covers an
  // immediate jump to the thread list.
  useEffect(() => {
    const saved = loadMessageDraft(draftKey);
    const restoredText = saved?.text ?? '';
    const restoredReply = saved?.reply ?? null;
    const restoredImage = draftImages.get(draftKey) ?? null;
    draftSnapshotRef.current = { text: restoredText, reply: restoredReply, image: restoredImage };
    setText(restoredText);
    setImage(restoredImage);
    onRestoreReply(restoredReply);
    return () => {
      const d = draftSnapshotRef.current;
      saveMessageDraft(draftKey, d.text, d.reply, d.image);
    };
  }, [draftKey, onRestoreReply]);

  // A hidden/closed page may not unmount React. Persist the latest snapshot at the browser
  // lifecycle boundary as well.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') {
        const d = draftSnapshotRef.current;
        saveMessageDraft(draftKey, d.text, d.reply, d.image);
      }
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [draftKey]);

  // Caret position after an insertion reaches the field. Can't set it immediately (`value` still
  // old, the browser moves the caret by its own rules) — set in an effect on `text`.
  const caretRef = useRef<number | null>(null);
  useEffect(() => {
    const pos = caretRef.current;
    if (pos === null) return;
    caretRef.current = null;
    const el = inputRef.current;
    if (el) el.setSelectionRange(pos, pos);
  }, [text]);

  // Emoji and @name insertions go at the CARET, not the end: returning the cursor mid-text used to
  // send the insertion to the end.
  const caretPos = (cur: string) => {
    const el = inputRef.current;
    const p = el?.selectionStart;
    return typeof p === 'number' && p <= cur.length ? p : cur.length;
  };

  const insertMention = useCallback((username: string) => {
    setText((cur) => {
      const pos = caretPos(cur);
      const head = cur.slice(0, pos);
      const tail = cur.slice(pos);
      const base = MENTION_TAIL.test(head) ? head.replace(MENTION_TAIL, '') : head;
      const sep = base && !base.endsWith(' ') ? ' ' : '';
      const ins = `${sep}@${username} `;
      const next = `${base}${ins}${tail}`.slice(0, maxLen);
      caretRef.current = Math.min((base + ins).length, next.length);
      return next;
    });
    setMentionQ('');
    inputRef.current?.focus();
  }, [maxLen]);

  // Emoji inserted as shortcode text: the field shows exactly what goes to the server. Trailing
  // space so two picks don't glue into ":fire::eyes:".
  const insertEmoji = useCallback((name: string) => {
    setText((cur) => {
      const pos = caretPos(cur);
      const head = cur.slice(0, pos);
      const tail = cur.slice(pos);
      const sep = head && !head.endsWith(' ') ? ' ' : '';
      const ins = `${sep}:${name}: `;
      const next = `${head}${ins}${tail}`.slice(0, maxLen);
      caretRef.current = Math.min((head + ins).length, next.length);
      return next;
    });
    inputRef.current?.focus();
  }, [maxLen]);

  // Edit is started from outside (row button) but text lives here, so entering/leaving edit flows
  // into the field from here. Skip the first run: focusing on chat open means a popped-up phone
  // keyboard and a jumped feed.
  const mounted = useRef(false);
  // Text typed BEFORE entering edit. Edit uses the same field and leaving it used to clear it
  // (typed → ✏ on an old message → Esc → typed text gone). Now the draft waits and returns.
  const draftRef = useRef('');
  const textRef = useRef(text);
  textRef.current = text;
  const wasEditingRef = useRef(false);
  useEffect(() => {
    const nowEditing = !!editing;
    const wasEditing = wasEditingRef.current;
    wasEditingRef.current = nowEditing;
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (nowEditing) {
      // Only on entering edit (switching between own messages: field already holds edit text,
      // nothing to stash).
      if (!wasEditing) draftRef.current = textRef.current;
      setText(editing.text);
    } else {
      setText(draftRef.current);
      draftRef.current = '';
    }
    setMentionQ('');
    inputRef.current?.focus();
  }, [editing]);

  // @mention autocomplete debounced: typing outruns server search, each letter would be a request.
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

  const changeText = useCallback((v: string) => {
    const next = v.slice(0, maxLen);
    setText(next);
    setMentionQ(MENTION_TAIL.exec(next)?.[1] ?? '');
  }, [maxLen]);

  const pickImage = useCallback((f: File | null) => {
    if (!f) {
      setImage(null);
      return;
    }
    // Check type here, not just via `accept`: clipboard/drag bring anything (even pdf); otherwise
    // the refusal comes from the server after losing the typed text.
    if (!IMAGE_MIME.includes(f.type)) {
      onError('Only JPEG, PNG, GIF or WebP images.');
      return;
    }
    if (f.size > IMAGE_MAX_BYTES) {
      onError('Image is over 8 MB. Shrink it or link it instead.');
      return;
    }
    setImage(f);
  }, [onError]);

  // Clipboard/drop image: same signedIn gate as the file button — the server refuses anon images
  // (shoutReadPostInput); a silently eaten Ctrl+V reads as broken.
  const takeImage = useCallback((f: File) => {
    if (!signedIn) {
      onError('Images are for logged-in users.');
      return;
    }
    pickImage(f);
  }, [signedIn, onError, pickImage]);

  // Imperative handle declared AFTER takeImage on purpose: declaration order is execution order;
  // referencing a not-yet-created const crashes on first render.
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    insertMention,
    attachImage: takeImage,
  }), [insertMention, takeImage]);

  // Edit doesn't touch the image, so empty text on an image message is valid (caption removed,
  // image stays).
  const canSubmit = !sending && (Boolean(text.trim()) || Boolean(image) || Boolean(editing?.image));

  const submit = useCallback(async () => {
    if (sending) return;
    const t = text.trim();
    if (!t && !image && !editing?.image) return;
    // What exactly was sent. The field isn't locked while sending (seconds on slow networks), so by
    // the response it may hold the next message — clear exactly what was sent, nothing more.
    const sentText = text;
    const sentImage = image;
    setSending(true);
    try {
      // In a private channel the mask is not just hidden but removed: the toggle is chat-wide and
      // would follow into a DM.
      if (await onSubmit(t, { image: sentImage, anon: anon && !privateChannel })) {
        // Unconditional setText('') ate the next message typed while the first was in flight.
        if (textRef.current === sentText) {
          draftSnapshotRef.current = { text: '', reply: null, image: null };
          saveMessageDraft(draftKey, '', null, null);
          setText('');
          setMentionQ('');
        }
        setImage((cur) => (cur === sentImage ? null : cur));
        if (fileRef.current && fileRef.current.files?.[0] === sentImage) fileRef.current.value = '';
      }
    } finally {
      setSending(false);
    }
  }, [sending, text, image, anon, privateChannel, editing, onSubmit, draftKey]);

  // Preview blob URL lives as long as the file; building it in JSX leaks one per render (a render
  // per keystroke here).
  const [imageUrl, setImageUrl] = useState('');
  useEffect(() => {
    if (!image) {
      setImageUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  // Expansion, reply/edit strips, textarea growth all change field height and the feed shrinks by
  // the same amount. A ResizeObserver beats enumerating causes (six already).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onResize || typeof ResizeObserver === 'undefined') return undefined;
    let last = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h === last) return;
      last = h;
      onResize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);

  // Empty field, no attachment, no focus = read mode (narrow row, inline icons). A draft keeps it
  // expanded. The emoji popover steals focus (portal with autofocus) but the field under it must
  // not collapse. With a mouse the field is ALWAYS expanded: the collapsed row was for phones; on
  // desktop it caused a layout jump right at click time.
  const expanded = !TOUCH_ONLY
    || focused || emojiOpen || text.length > 0 || Boolean(image);
  return (
    <Box sx={WRAP_SX} ref={wrapRef}>
      {replyTo && (
        <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
          <ReplyOutlinedIcon sx={STRIP_ICON_SX} />
          <Typography variant="caption" color="text.secondary" noWrap sx={STRIP_TEXT_SX}>
            Replying to {replyTo.expand?.user
              ? (notes[replyTo.expand.user.id]?.a
                || replyTo.expand.user.name || replyTo.expand.user.username || 'User')
              : (replyTo.anon_key ? anonIdentity(replyTo.anon_key, replyTo.anon_mask).name : 'Anonymous')}
            : {replyTo.text?.slice(0, 60) || 'image'}
          </Typography>
          <IconButton size="small" sx={CLOSE_BTN_SX} onClick={onCancelReply}>
            <CloseIcon sx={CLOSE_ICON_SX} />
          </IconButton>
        </Stack>
      )}

      {editing && (
        <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
          <EditOutlinedIcon sx={EDIT_ICON_SX} />
          <Typography variant="caption" color="warning.main" noWrap sx={STRIP_TEXT_SX}>
            Editing your message — Esc to cancel
          </Typography>
          <IconButton size="small" sx={CLOSE_BTN_SX} onClick={onCancelEdit}>
            <CloseIcon sx={CLOSE_ICON_SX} />
          </IconButton>
        </Stack>
      )}

      {image && (
        <Stack direction="row" alignItems="center" spacing={1} sx={STRIP_SX}>
          <Box component="img" src={imageUrl} alt="" sx={THUMB_SX} />
          <Typography variant="caption" color="text.secondary" noWrap sx={STRIP_TEXT_SX}>
            {image.name}
          </Typography>
          <IconButton size="small" sx={CLOSE_BTN_SX} onClick={() => pickImage(null)}>
            <CloseIcon sx={CLOSE_ICON_SX} />
          </IconButton>
        </Stack>
      )}

      {mentionOpts.length > 0 && (
        <Stack direction="row" spacing={1} sx={MENTIONS_SX}>
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

      {/*
        Composer is one pill: anonymity + image left, send right. The separate toggle/counter row
        was removed (ate feed height on phones).
      */}
      <Box
        sx={PILL_SX}
        data-open={expanded ? '1' : undefined}
        // Pill buttons must not steal focus from the field: with an empty field focus loss
        // collapses the pill, the button vanishes between mousedown and click and the press never
        // lands. The field itself is excluded, or you couldn't place the cursor with a mouse.
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        {/* Markdown bar ON TOP like every text editor. Only in write mode and via its own button. */}
        {expanded && mdBarOpen && (
          <Box className="cmp-md" sx={{ mb: 0.5 }}>
            <MarkdownBar areaRef={inputRef} value={text} onChange={changeText} max={maxLen} disabled={sending} />
          </Box>
        )}
        {signedIn && !privateChannel && (
          <Tooltip title={anon ? `Posting as ${anonIdentity(anonKey, mask).name} — tap to sign it` : 'Post anonymously'}>
            <IconButton
              size="small"
              onClick={() => setAnon((v) => {
                try { localStorage.setItem(ANON_KEY, v ? '0' : '1'); } catch { }
                return !v;
              })}
              sx={{ color: anon ? 'primary.main' : 'text.secondary', mb: 0.25 }}
            >
              <AnonMaskIcon fontSize="small" />
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
        {emojiPack.ready && emojiPack.all.length > 0 && (
          <Tooltip title="Emoji">
            <IconButton
              size="small"
              ref={emojiBtnRef}
              onClick={() => setEmojiOpen(true)}
              sx={{ color: emojiOpen ? 'primary.main' : 'text.secondary', mb: 0.25 }}
            >
              <EmojiEmotionsOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        {expanded && (
          <Tooltip title={mdBarOpen ? 'Hide formatting' : 'Formatting'}>
            <IconButton
              size="small"
              onClick={() => setChatPref('mdBarOpen', !mdBarOpen)}
              sx={{ color: mdBarOpen ? 'primary.main' : 'text.secondary' }}
            >
              <TextFormatIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <EmojiPicker
          open={emojiOpen}
          anchorEl={emojiBtnRef.current}
          onClose={() => setEmojiOpen(false)}
          emoji={emojiPack.all}
          quick={emojiPack.quick}
          onPick={(e) => insertEmoji(e.name)}
          // From the composer emoji are often picked in bulk, so the popover stays open (unlike
          // reactions: exactly one pick).
          keepOpen
        />
        <TextField
          fullWidth
          multiline
          // Two rows on desktop: a one-row field grew on the first wrap anyway and jerked the feed
          // under a started thought.
          minRows={TOUCH_ONLY ? 1 : 2}
          maxRows={5}
          variant="standard"
          className="cmp-field"
          inputRef={inputRef}
          placeholder={placeholder}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => changeText(e.target.value)}
          onKeyDown={(e) => {
            // isComposing = IME input (Japanese/Chinese/Korean): Enter confirms the candidate, not
            // sends. Without this check such users can't finish a word.
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              // Ctrl/⌘+Enter sends EVERYWHERE (mail habit; the only keyboard way on a phone with an
              // external keyboard).
              const withMod = e.ctrlKey || e.metaKey;
              // Plain Enter sends with a mouse (Discord/Telegram/Slack), Shift+Enter = newline. On
              // touch the reverse: Enter = newline, send via button.
              const plainSends = !TOUCH_ONLY && !e.shiftKey && !e.altKey && !withMod;
              if (withMod || plainSends) {
                e.preventDefault();
                void submit();
              }
            }
            if (e.key === 'Escape' && editing) {
              e.preventDefault();
              onCancelEdit();
            }
            // Up-arrow only in an EMPTY field: in a non-empty one it must move the cursor.
            if (e.key === 'ArrowUp' && !text && !editing && onEditLast) {
              e.preventDefault();
              onEditLast();
            }
          }}
          // Intercept paste ONLY when the clipboard has an image file; plain text paste stays
          // native.
          onPaste={(e) => {
            const items = Array.from(e.clipboardData?.items ?? []);
            const it = items.find((x) => x.kind === 'file' && x.type.startsWith('image/'));
            if (!it) return;
            const f = it.getAsFile();
            if (!f) return;
            e.preventDefault();
            takeImage(f);
          }}
          slotProps={FIELD_SLOTS}
          sx={FIELD_SX}
        />
        {/* Counter only near the limit: permanent "0/300" is noise; "20 left" saves a thought. */}
        {text.length > maxLen - 60 && (
          <Typography
            className="cmp-count"
            variant="caption"
            sx={{ alignSelf: 'flex-end', mb: 1, mr: 0.5, fontSize: 11, color: text.length >= maxLen ? 'error.main' : 'text.secondary' }}
          >
            {maxLen - text.length}
          </Typography>
        )}
        {/*
          Send is always shown, even empty/grey: hiding it shifts layout on the first letter under
          the cursor. On touch it's the only way to send (Enter = newline, see FIELD_SLOTS).
        */}
        <IconButton
          className="cmp-send"
          onClick={submit}
          disabled={!canSubmit}
          sx={{
            width: 34, height: 34, mb: 0.25,
            transition: 'background-color .15s',
            ...(canSubmit
              ? {
                bgcolor: 'primary.main',
                color: '#fff',
                '&:hover': { bgcolor: 'primary.dark' },
              }
              : { color: 'text.disabled' }),
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

      {/*
        "Posting as": guests always (nowhere else to read it); logged-in only when anonymity is on.
        The name is changed right here — no separate "change mask" button, people look for it where
        the name is.
      */}
      {(!signedIn || (anon && !privateChannel)) && (
        <Typography variant="caption" color="text.secondary" sx={FOOTNOTE_SX}>
          Posting as{' '}
          <Box
            component="span"
            role="button"
            tabIndex={0}
            onClick={() => setMaskOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMaskOpen(true); }}
            sx={{
              cursor: 'pointer', textDecorationLine: 'underline',
              textDecorationStyle: 'dotted', textUnderlineOffset: '2px',
              color: 'text.primary', '&:hover': { color: 'primary.main' },
            }}
          >
            {anonIdentity(anonKey, mask).name}
          </Box>
          {!signedIn && ' — you can delete your own message.'}
        </Typography>
      )}
      <AnonMaskDialog open={maskOpen} onClose={() => setMaskOpen(false)} />
    </Box>
  );
}

export default forwardRef(Composer);
