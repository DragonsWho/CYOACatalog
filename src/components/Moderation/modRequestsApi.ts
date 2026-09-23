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

const EXPAND = 'requester,game,comment,assignee';

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
