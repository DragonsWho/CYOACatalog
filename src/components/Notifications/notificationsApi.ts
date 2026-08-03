// Data layer for the per-user notification feed (header bell).
//
// Reads go through the PocketBase SDK (listRule scopes everything to the
// authenticated recipient). Writes (mark-as-read) go through a Go endpoint so a
// single call can clear many notifications and the collection stays write-locked
// to the client (createRule/updateRule = null).

import { ListResult } from 'pocketbase';
import {
  Notification,
  NotificationType,
  notificationsCollection,
  authedFetch,
} from '../../pocketbase/pocketbase';

const EXPAND = 'actor,game';

/** Most recent notifications for the current user (newest first). */
export async function fetchNotifications(
  page = 1,
  perPage = 20,
): Promise<ListResult<Notification>> {
  return notificationsCollection.getList(page, perPage, {
    sort: '-created',
    expand: EXPAND,
  });
}

/** Number of unread notifications (cheap: asks for one item, reads totalItems). */
export async function unreadCount(): Promise<number> {
  const res = await notificationsCollection.getList(1, 1, {
    filter: 'read = false',
    fields: 'id',
  });
  return res.totalItems;
}

/** Mark notifications read. Omit `ids` to mark every unread one read. */
export async function markRead(ids?: string[]): Promise<void> {
  const res = await authedFetch('/api/custom/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ ids: ids ?? [] }),
  });
  if (!res.ok) throw new Error(`Failed to mark notifications read (${res.status})`);
}

/** Human-readable line for a notification, given the resolved actor name. */
export function notificationText(n: Notification): string {
  const actor = n.expand?.actor?.name || n.expand?.actor?.username || 'Someone';
  const game = n.expand?.game?.title;
  const onGame = game ? ` on “${game}”` : '';
  const messages: Record<NotificationType, string> = {
    comment_on_game: `${actor} commented on your game${game ? ` “${game}”` : ''}`,
    reply: `${actor} replied to your comment${onGame}`,
    mention: `${actor} mentioned you${onGame}`,
    mod_reply: `A moderator responded${onGame}`,
    shout_reply: `${actor} replied to you in chat`,
    shout_mention: `${actor} mentioned you in chat`,
  };
  return messages[n.type] ?? `${actor} interacted with you${onGame}`;
}

/** Chat notifications open the shoutbox drawer, not a route. */
export function isShoutNotification(n: Notification): boolean {
  return n.type === 'shout_reply' || n.type === 'shout_mention';
}

/** Target link for a notification — the game page, anchored to the comment.
 *  Chat notifications have no route (handled via the drawer) → return ''. */
export function notificationLink(n: Notification): string {
  if (isShoutNotification(n)) return '';
  if (!n.game) return '/';
  return n.comment ? `/game/${n.game}#comment-${n.comment}` : `/game/${n.game}`;
}
