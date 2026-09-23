// Chat drawer sliding in from the right, BELOW the site header. Not MUI Drawer: its root and
// backdrop cover the header, forcing a close ✕ row. Now the header stays live (logo, search,
// profile work over open chat); close by click-outside, Back or Esc. Top = the header's measured
// bottom edge (height varies by viewport and page).

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, CircularProgress } from '@mui/material';

const ChatView = lazy(() => import('./ChatView'));
import type { ChatJumpTarget } from './ChatView';
import type { CommunityRating } from './communityApi';
export type { ChatJumpTarget };

// Matches the transition; also when the drawer is unmounted so a closed one holds no
// nodes/subscriptions.
const ANIM_MS = 220;

const HEADER_FALLBACK = 54;

function headerBottom(): number {
  const el = document.querySelector('header.MuiAppBar-root') as HTMLElement | null;
  if (!el) return HEADER_FALLBACK;
  // bottom, not height: some pages have a second row under the sticky header.
  return Math.max(0, Math.round(el.getBoundingClientRect().bottom));
}

type Props = {
  open: boolean;
  onClose: () => void;
  maxWidth?: number;
  jumpTarget?: ChatJumpTarget | null;
  rating?: CommunityRating;
};

export default function ChatDrawer({ open, onClose, maxWidth = 460, jumpTarget, rating = 'all' }: Props) {
  // mounted vs shown: the close animation must finish before unmount.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [top, setTop] = useState(HEADER_FALLBACK);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (open) {
      setTop(headerBottom());
      setMounted(true);
      // Set "shown" on the next frame: in the mount frame the browser sees no transform change and
      // skips the slide.
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = window.setTimeout(() => setMounted(false), ANIM_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onResize = () => setTop(headerBottom());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  // Esc on document: the drawer holds no focus trap (header below is live, a trap would lie).
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Lock page scroll under the drawer: on phones "scrolled chat to the end, catalog moved" reads as
  // broken.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // System Back closes chat instead of leaving the page (same ladder as the rest of mobile UI).
  // Manual close leaves its history entry; one idle entry is reused.
  useEffect(() => {
    if (!open) return undefined;
    if (!(window.history.state && window.history.state.chatSummon)) {
      window.history.pushState({ ...window.history.state, chatSummon: true }, '');
    }
    const onPop = () => closeRef.current();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  const clickAway = useCallback(() => closeRef.current(), []);

  if (!mounted) return null;

  // Portal to body is REQUIRED: the chat icon lives in the header (MUI AppBar, sticky + z-index
  // 1100 = its own stacking context). Inside it the drawer exits as one 1100 layer whatever its
  // zIndex — that's how CyoaCompanionDrawer on game pages covered open chat. In body, 1199/1200
  // work as written; the header stays clickable by geometry (backdrop and panel start at its
  // bottom).
  return createPortal(
    (
      <>
      {/*
        Backdrop starts below the header too: covering it would turn a logo click (the main way
        out) into a close.
      */}
      <Box
        onClick={clickAway}
        sx={{
          position: 'fixed',
          top,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1199,
          bgcolor: 'rgba(0,0,0,0.5)',
          opacity: shown ? 1 : 0,
          transition: `opacity ${ANIM_MS}ms ease`,
        }}
      />
      <Box
        role="dialog"
        aria-label="Chat"
        sx={{
          position: 'fixed',
          top,
          right: 0,
          bottom: 0,
          zIndex: 1200,
          width: '100%',
          maxWidth,
          display: 'flex',
          flexDirection: 'column',
          // Same background as the page, so chat looks identical on its route and in the drawer
          // (MUI dark `background.paper` lightens by elevation).
          bgcolor: '#101010',
          backgroundImage: 'none',
          borderLeft: 1,
          borderColor: 'divider',
          boxShadow: '-8px 0 24px rgba(0,0,0,0.45)',
          transform: shown ? 'translateX(0)' : 'translateX(100%)',
          transition: `transform ${ANIM_MS}ms cubic-bezier(.2,.7,.3,1)`,
          overflow: 'hidden',
        }}
      >
        {/* ChatView is flex:1 — the parent sets its height. */}
        <Suspense fallback={(
          <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <CircularProgress size={24} />
          </Box>
        )}>
          <ChatView community startThreads rating={rating} jumpTarget={jumpTarget} />
        </Suspense>
      </Box>
      </>
    ),
    document.body,
  );
}
