// Per-user notification feed data layer (header bell). Reads via PB SDK (listRule scopes to the
// recipient). Writes (mark-as-read) via a Go endpoint so one call clears many and the collection
// stays write-locked (createRule/updateRule = null).

import { ListResult } from 'pocketbase';
import {
  Notification,
  NotificationType,
  notificationsCollection,
  authedFetch,
} from '../../pocketbase/pocketbase';

// shout_channel expand for the room name (and topic owner) in the row. Optional: if not expanded
// the row says "in chat" as before.
const EXPAND = 'actor,game,shout_channel';

export async function fetchNotifications(
  page = 1,
  perPage = 20,
): Promise<ListResult<Notification>> {
  return notificationsCollection.getList(page, perPage, {
    sort: '-created',
    expand: EXPAND,
  });
}

export async function markRead(items: Notification[]): Promise<string[]> {
  if (!items.length) return [];
  // The tray renders only the newest page. Sending just those ids strands older unread rows forever
  // (every reopen fetches the same newest records while the badge counts the hidden old ones). Use
  // the newest fetched record as a boundary and let the backend clear every unread row at or before
  // it. A notification created during the request is newer and stays unread. `messages` also
  // protects coalesced chat rows whose target message changed without changing id.
  const through = items.reduce(
    (latest, n) => (!latest || n.created > latest ? n.created : latest),
    '',
  );
  const res = await authedFetch('/api/custom/notifications/read', {
    method: 'POST',
    body: JSON.stringify({
      through,
      messages: Object.fromEntries(
        items.filter((n) => n.shout_message).map((n) => [n.id, n.shout_message]),
      ),
    }),
  });
  if (!res.ok) throw new Error(`Failed to mark notifications read (${res.status})`);
  return (await res.json()).ids ?? [];
}

// meId is needed for one line: a reply in YOUR OWN topic must read differently without opening it.
// The server sends it as a plain `shout_reply` (a new value in the `notifications.type` select
// would require a prod schema change for the same event), so "my topic" is decided here from the
// expanded channel's owner.
export function notificationText(n: Notification, meId?: string): string {
  const actor = n.expand?.actor?.name || n.expand?.actor?.username || 'Someone';
  const game = n.expand?.game?.title;
  const onGame = game ? ` on “${game}”` : '';
  const ch = n.expand?.shout_channel;
  const room = ch?.title ? ` in “${ch.title}”` : ' in chat';
  const myThread = Boolean(meId && ch?.owner && ch.owner === meId);
  const messages: Record<NotificationType, string> = {
    comment_on_game: `${actor} commented on your game${game ? ` “${game}”` : ''}`,
    reply: `${actor} replied to your comment${onGame}`,
    mention: `${actor} mentioned you${onGame}`,
    mod_reply: `A moderator responded${onGame}`,
    shout_reply: myThread
      ? `${actor} replied in your thread${ch?.title ? ` “${ch.title}”` : ''}`
      : `${actor} replied to you${room}`,
    shout_mention: `${actor} mentioned you${room}`,
    // In a DM "replied"/"mentioned" say nothing (only one peer). The row is per conversation, not
    // per message (shoutDMQuiet in shoutbox.go), so it reads as an invitation.
    shout_dm: `${actor} sent you a message`,
  };
  return messages[n.type] ?? `${actor} interacted with you${onGame}`;
}

export function isShoutNotification(n: Notification): boolean {
  return n.type === 'shout_reply' || n.type === 'shout_mention' || n.type === 'shout_dm';
}

// Target link: game page anchored to the comment. Chat notifications have no route (drawer) → ''.
export function notificationLink(n: Notification): string {
  if (isShoutNotification(n)) return '';
  if (!n.game) return '/';
  return n.comment ? `/game/${n.game}#comment-${n.comment}` : `/game/${n.game}`;
}
