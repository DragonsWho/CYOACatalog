// Full-page chat with its own URL. A wrapper rather than ChatView in the route: chat lives in three
// places (page, drawer, lab stand) and only this one has a URL — all router knowledge is here;
// ChatView gets a slug and reports what opened.
// URLs: /chat (last open), /chat/r/<slug> room, /chat/t/<slug> user topic, /chat/threads index. DMs
// get no URL on purpose (slug must not land in browser history).
// The route is decided HERE from location, not via props from App: all four routes render the same
// element so switching doesn't remount chat (otherwise the feed reloaded and the topics section
// vanished via /chat/r/ — wiki/log.md 2026-09-15).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import ChatView, { type ChatJumpTarget } from './ChatView';
import { CHAT_THREADS_PATH, type CommunityRating } from './communityApi';

type Props = {
  rating?: CommunityRating;
};

export default function ChatPage({ rating = 'all' }: Props) {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();

  // /chat stays the URL for DMs and private rooms (no slug).
  const startThreads = pathname === CHAT_THREADS_PATH;

  // Chat notification click from the bell. On the chat page we must NOT open the drawer on top (a
  // SECOND live ChatView in one tab: two SSE subscriptions, two presence pings, two writers to one
  // localStorage). ShoutboxButton ignores the event on /chat*; the mounted chat takes the jump
  // here.
  const [jumpTarget, setJumpTarget] = useState<ChatJumpTarget | null>(null);
  // Token grows even for a repeat click on the same notification, or ChatView sees no prop change
  // and doesn't jump again.
  const jumpTokenRef = useRef(0);
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ messageId?: string; channelId?: string }>).detail;
      if (!detail?.messageId) return;
      jumpTokenRef.current += 1;
      setJumpTarget({
        messageId: detail.messageId,
        channelId: detail.channelId,
        token: jumpTokenRef.current,
      });
    };
    window.addEventListener('shoutbox:open', onOpen);
    return () => window.removeEventListener('shoutbox:open', onOpen);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const channelId = params.get('channel');
    if (!channelId) return;
    setJumpTarget({ channelId, messageId: params.get('message') ?? '', token: ++jumpTokenRef.current });
    navigate(location.pathname, { replace: true });
  }, [location.search, location.pathname, navigate]);

  const onRouteChange = useCallback((path: string, opts?: { push?: boolean; back?: boolean }) => {
    if (window.location.pathname === path) return;
    if (opts?.back) {
      if ((location.state as { fromThreads?: boolean } | null)?.fromThreads) navigate(-1);
      else navigate(CHAT_THREADS_PATH);
      return;
    }
    if (opts?.push) {
      navigate(path, { state: { fromThreads: true } });
      return;
    }
    // replace, not push: switching rooms isn't site navigation; otherwise Back after an evening in
    // chat rewinds forty rooms.
    navigate(path, { replace: true });
  }, [navigate, location.state]);

  return (
    <ChatView
      community
      startThreads={startThreads}
      rating={rating}
      routeSlug={slug}
      onRouteChange={onRouteChange}
      jumpTarget={jumpTarget}
    />
  );
}
