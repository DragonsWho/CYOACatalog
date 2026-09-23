// Staff distinction in chat: which red names are the site owner vs invited moderators. A red name
// used to mean "some staff" and the author was indistinguishable from moderators. The message
// record has only `isModerator` and adding a schema field on live prod for a color isn't allowed.
// The admin list comes from one endpoint (`/api/custom/shoutbox/staff`, shoutbox_staff.go) and is
// module-level: feed, members list, profile card and pin strip must see one answer fetched once.

import { useEffect, useState } from 'react';
import { fetchChatAdmins } from '../Shoutbox/shoutboxApi';

// Moderator blue (owner keeps red, error.main). Lighter than the intended #2e4ce3: on the
// near-black feed that was ~3:1 contrast and read as dimmed; this is ~7:1, still the same blue.
export const MOD_NICK_COLOR = '#5b8cff';

const EMPTY: ReadonlySet<string> = new Set<string>();

let cache: ReadonlySet<string> = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<(s: ReadonlySet<string>) => void>();

function load(): Promise<void> {
  if (loading) return loading;
  loading = fetchChatAdmins()
    .then((ids) => {
      cache = new Set(ids);
      listeners.forEach((fn) => fn(cache));
    })
    // Fetch failed → empty list: all staff render blue. Worse than truth, better than an empty
    // screen.
    .catch(() => { });
  return loading;
}

export function useChatAdmins(): ReadonlySet<string> {
  const [admins, setAdmins] = useState<ReadonlySet<string>>(cache);
  useEffect(() => {
    listeners.add(setAdmins);
    void load();
    // Loaded between render and subscribe — take it immediately.
    if (cache !== admins) setAdmins(cache);
    return () => { listeners.delete(setAdmins); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return admins;
}

// Name color for places that set it as a value, not a class. `undefined` = regular user (nickColor
// by id).
export function staffNickColor(
  id: string, isMod: boolean | undefined, admins: ReadonlySet<string>,
): string | undefined {
  if (!isMod) return undefined;
  return admins.has(id) ? 'error.main' : MOD_NICK_COLOR;
}
