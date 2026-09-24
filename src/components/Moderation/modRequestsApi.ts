// Moderator ticket queue data layer. Reads via PB SDK (listRule = moderators only). Writes via a Go
// endpoint that re-checks isModerator and validates enums; the collection stays write-locked to
// clients.

import { ListResult } from 'pocketbase';
import {
  ModRequest,
  ModRequestKind,
  ModRequestStatus,
  modRequestsCollection,
  authedFetch,
} from '../../pocketbase/pocketbase';

const EXPAND = 'requester,game,comment,assignee,resolved_by';

// Archive sort keys. resolved_* are set by Go on resolve (backfilled from mod_actions).
export type ModRequestSort =
  | '-resolved_at'
  | 'resolved_at'
  | '-created'
  | 'created'
  | 'resolved_by.username'
  | 'assignee.username'
  | 'kind';

// moderator: user id matched against resolved_by OR assignee; '' = neither set; undefined = any.
export async function fetchModRequests(
  status: ModRequestStatus | 'all',
  page = 1,
  perPage = 30,
  sort: ModRequestSort = '-created',
  moderator?: string,
): Promise<ListResult<ModRequest>> {
  const parts: string[] = [];
  if (status !== 'all') parts.push(`status = "${status}"`);
  if (moderator !== undefined) {
    const id = moderator.replace(/"/g, '');
    parts.push(id ? `(resolved_by = "${id}" || assignee = "${id}")` : 'resolved_by = "" && assignee = ""');
  }
  return modRequestsCollection.getList(page, perPage, {
    filter: parts.join(' && '),
    // Tie-break so equal keys (same moderator/kind) keep newest-first.
    sort: sort === '-created' ? sort : `${sort},-created`,
    expand: EXPAND,
  });
}

// Moderators that resolved or claimed tickets in a status bucket, for the archive filter dropdown.
// Tickets are low volume, so one light full-list read is fine.
export async function fetchTicketModerators(
  status: ModRequestStatus | 'all',
): Promise<{ id: string; username: string }[]> {
  const any = '(resolved_by != "" || assignee != "")';
  const rows = await modRequestsCollection.getFullList({
    filter: status === 'all' ? any : `status = "${status}" && ${any}`,
    fields: 'expand.assignee.id,expand.assignee.username,expand.resolved_by.id,expand.resolved_by.username',
    expand: 'assignee,resolved_by',
  });
  const map = new Map<string, string>();
  for (const r of rows) {
    for (const u of [r.expand?.assignee, r.expand?.resolved_by]) {
      if (u) map.set(u.id, u.username);
    }
  }
  return [...map].map(([id, username]) => ({ id, username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// Full actionable queue for open/in_progress (small: tickets get closed), so client-side priority
// sort isn't limited to one page (an urgent ticket on page 2 would stay hidden). Not for
// resolved/trash/all, which grow unbounded — paginated via fetchModRequests.
export async function fetchModRequestsFull(
  status: ModRequestStatus,
): Promise<ModRequest[]> {
  return modRequestsCollection.getFullList({
    filter: `status = "${status}"`,
    sort: '-created',
    expand: EXPAND,
  });
}

export async function openTicketCount(): Promise<number> {
  const res = await modRequestsCollection.getList(1, 1, {
    filter: 'status = "open"',
    fields: 'id',
  });
  return res.totalItems;
}

export interface ModRequestPatch {
  status?: ModRequestStatus;
  kind?: ModRequestKind;
  assignee?: string;
  internal_note?: string;
}

// Patch a ticket (moderators only); only provided fields change.
export async function updateModRequest(id: string, patch: ModRequestPatch): Promise<void> {
  const res = await authedFetch('/api/custom/mod-requests/update', {
    method: 'POST',
    body: JSON.stringify({ id, ...patch }),
  });
  if (!res.ok) throw new Error(`Failed to update ticket (${res.status})`);
}
