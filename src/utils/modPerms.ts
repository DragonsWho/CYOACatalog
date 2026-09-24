// Moderator permissions (backend mod_perms.go, collection `mod_permissions`). Role used to be
// boolean `isModerator`; now each moderator has a key set, granted at /moderator/access. Types +
// three API calls. IMPORTANT "legacy": no perms row = FULL access, exactly as before — otherwise
// shipping the binary would lock the author out of her own site. Such users are flagged `legacy:
// true`; the access page suggests setting an explicit list.

import { authedFetch } from '../pocketbase/pocketbase';

// Permission keys; must match perm* constants in mod_perms.go.
export type ModPermKey =
  | '*'
  | 'cards'
  | 'comments'
  | 'tickets'
  | 'tags'
  | 'review'
  | 'hosting'
  | 'hosting_purge'
  | 'chat'
  | 'queue'
  | 'roulette'
  | 'stats'
  | 'perms'
  | 'mod_upload';

export interface ModCapability {
  key: ModPermKey;
  label: string;
  note: string;
}

export interface ModPermsRow {
  user_id: string;
  username: string;
  avatar: string;
  perms: ModPermKey[];
  legacy: boolean;
  note: string;
  updated: string;
}

export interface MyModPerms {
  is_moderator: boolean;
  // Expanded list: backend already expanded "*" into concrete keys.
  perms: ModPermKey[];
  capabilities: ModCapability[];
  legacy?: boolean;
}

// Own perms. Never throws: any error → "not a moderator".
export async function fetchMyModPerms(): Promise<MyModPerms> {
  try {
    const res = await authedFetch('/api/custom/mod/perms/me');
    if (!res.ok) return { is_moderator: false, perms: [], capabilities: [] };
    return (await res.json()) as MyModPerms;
  } catch {
    return { is_moderator: false, perms: [], capabilities: [] };
  }
}

// All moderators and their perms. Requires `perms`.
export async function fetchModPerms(): Promise<{
  capabilities: ModCapability[];
  moderators: ModPermsRow[];
}> {
  const res = await authedFetch('/api/custom/mod/perms');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Failed to load permissions (${res.status})`);
  }
  return res.json();
}

// Set one moderator's perms. Requires `perms`.
export async function saveModPerms(
  userId: string,
  perms: ModPermKey[],
  note = '',
): Promise<void> {
  const res = await authedFetch('/api/custom/mod/perms', {
    method: 'POST',
    body: JSON.stringify({ user: userId, perms, note }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.message || `Failed to save permissions (${res.status})`);
  }
}
