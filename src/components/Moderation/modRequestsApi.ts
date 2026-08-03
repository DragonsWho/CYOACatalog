// Data layer for the moderator ticket queue.
//
// Reads go through the PocketBase SDK (listRule = moderators only). Writes go
// through a Go endpoint that re-checks isModerator and validates the enums, so
// the collection stays write-locked to clients.

import { ListResult } from 'pocketbase';
import {
  ModRequest,
  ModRequestKind,
  ModRequestStatus,
  modRequestsCollection,
  authedFetch,
} from '../../pocketbase/pocketbase';

const EXPAND = 'requester,game,comment,assignee';

/** One page of tickets, newest first, optionally filtered by status. */
export async function fetchModRequests(
  status: ModRequestStatus | 'all',
  page = 1,
  perPage = 30,
): Promise<ListResult<ModRequest>> {
  return modRequestsCollection.getList(page, perPage, {
    filter: status === 'all' ? '' : `status = "${status}"`,
    sort: '-created',
    expand: EXPAND,
  });
}

/**
 * The full actionable queue for a status (open / in_progress). These stay small
 * (tickets get closed), so we fetch them all — otherwise client-side priority
 * sorting (illegal first, most-liked next) could only reorder a single page and
 * an urgent ticket on page 2 would stay hidden. Not for resolved/trash/all,
 * which grow unbounded — those stay paginated via fetchModRequests.
 */
export async function fetchModRequestsFull(
  status: ModRequestStatus,
): Promise<ModRequest[]> {
  return modRequestsCollection.getFullList({
    filter: `status = "${status}"`,
    sort: '-created',
    expand: EXPAND,
  });
}

/** Count of open tickets — feeds the moderator queue badge. */
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
  assignee?: string; // "" clears
  internal_note?: string;
}

/** Patch a ticket (moderators only). Only the provided fields change. */
export async function updateModRequest(id: string, patch: ModRequestPatch): Promise<void> {
  const res = await authedFetch('/api/custom/mod-requests/update', {
    method: 'POST',
    body: JSON.stringify({ id, ...patch }),
  });
  if (!res.ok) throw new Error(`Failed to update ticket (${res.status})`);
}
