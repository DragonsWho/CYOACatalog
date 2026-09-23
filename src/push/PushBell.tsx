// Web-push bell in the chat bar; click opens a menu with three modes. Not rendered at all when push
// is impossible (no VAPID keys on server, no PushManager, iOS Safari not installed to Home Screen)
// — a dead toggle makes people think notifications are broken. Formerly click toggled on/off and
// the mode lived behind right-click/long-press — nobody found it. Now exactly three states in one
// menu; "off" is just another item.

import { useCallback, useEffect, useState } from 'react';
import { IconButton, Menu, MenuItem, Tooltip, Divider, Typography, Box } from '@mui/material';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import {
  pushState, pushSubscribe, pushUnsubscribe, pushSetMode, pushTest,
  roomPushPrefs, roomPushSetMode,
  type PushMode, type PushState, type RoomPushMode, type RoomPushSet,
} from './pushClient';

type Props = {
  // Guests get no push: subscriptions are per account, not device.
  signedIn: boolean;
  onMessage?: (text: string) => void;
  // Current room, for the per-room override section. Without it the second half of the menu is
  // absent.
  roomId?: string;
  roomName?: string;
  // Prefs just changed — the chat screen uses them to decide whether to ring and must learn without
  // reload.
  onRoomPrefs?: (prefs: Record<string, RoomPushMode>) => void;
};

export default function PushBell({
  signedIn, onMessage, roomId, roomName, onRoomPrefs,
}: Props) {
  const [st, setSt] = useState<PushState | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  // null = not fetched yet. Fetched once per session on first menu open (see roomPushPrefs on
  // economy).
  const [rooms, setRooms] = useState<Record<string, RoomPushMode> | null>(null);

  const refresh = useCallback(() => { pushState().then(setSt); }, []);
  useEffect(() => { refresh(); }, [refresh, signedIn]);

  if (!signedIn || !st?.available) return null;

  const on = st.subscribed && st.permission === 'granted';
  const blocked = st.permission === 'denied';

  // Picking a mode also subscribes the device if needed: one gesture "I want these notifications",
  // not two.
  const choose = async (m: PushMode) => {
    setAnchor(null);
    setBusy(true);
    try {
      if (on) {
        const err = await pushSetMode(m);
        onMessage?.(err ?? (m === 'all'
          ? 'Notifications: any new message.'
          : 'Notifications: replies and mentions only.'));
      } else {
        // pushSubscribe asks browser permission, which must see a direct click response — no
        // preparatory await before it.
        const err = await pushSubscribe(m);
        onMessage?.(err ?? 'Notifications are on for this device.');
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  // Current room's mode. Empty = "as device" (no server row).
  const roomMode: RoomPushMode = (roomId && rooms?.[roomId]) || '';

  // Room prefs are per account, not device: "this room doesn't interest me" is not a phone
  // property.
  const chooseRoom = async (m: RoomPushSet) => {
    if (!roomId) return;
    setAnchor(null);
    setBusy(true);
    try {
      await roomPushSetMode(roomId, m);
      // Server stores a timed mute as a plain mute with an expiry — the menu must show it as plain
      // mute, otherwise after "until morning" the checkmark lands elsewhere.
      const stored: RoomPushMode = m === 'mute1h' || m === 'mute24h' ? 'mute' : m;
      const next = { ...(rooms ?? {}), [roomId]: stored };
      setRooms(next);
      onRoomPrefs?.(next);
      const where = roomName || 'this room';
      onMessage?.(
        m === 'all' ? `${where}: any new message.`
          : m === 'mentions' ? `${where}: replies and mentions only.`
            : m === 'mute1h' ? `${where}: muted for an hour.`
              : m === 'mute24h' ? `${where}: muted until tomorrow.`
                : m === 'mute' ? `${where}: muted.`
                  : `${where}: same as this device.`,
      );
    } catch {
      onMessage?.('Could not save the room setting.');
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setAnchor(null);
    setBusy(true);
    try {
      const ok = await pushUnsubscribe();
      onMessage?.(ok
        ? 'Notifications are off on this device.'
        : 'Turned off in this browser, but the server did not confirm — a few pushes may still arrive.');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const title = blocked
    ? 'Notifications are blocked in the browser'
    : !on
      ? 'Notifications: off — click to choose'
      : st.mode === 'all'
        ? 'Notifications: any new message'
        : 'Notifications: replies and mentions only';

  return (
    <>
      <Tooltip title={title}>
        <span>
          <IconButton
            size="small"
            disabled={busy}
            onClick={(e) => {
              setAnchor(e.currentTarget);
              // Room prefs fetched only when about to be shown, once per session.
              if (rooms === null && roomId) {
                roomPushPrefs().then((p) => { setRooms(p); onRoomPrefs?.(p); });
              }
            }}
            color={on ? 'primary' : 'default'}
            // Label says "push" deliberately: the site header already has an in-site notifications
            // bell with aria-label="Notifications".
            aria-label="Push notifications"
          >
            {on ? <NotificationsActiveOutlinedIcon fontSize="small" />
                : <NotificationsOffOutlinedIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>

      {/* Mode shown as a word next to the icon, so you don't have to open the menu to remember. */}
      {on && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ userSelect: 'none', pointerEvents: 'none' }}
        >
          {st.mode === 'all' ? 'rooms' : '@'}
        </Typography>
      )}

      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Notify me on this device…
          </Typography>
        </Box>

        {/*
          Permission revoked in the browser itself can't be restored from the page — say so
          honestly instead of items that silently fail.
        */}
        {blocked ? (
          <Box sx={{ px: 2, pb: 1.5, maxWidth: 260 }}>
            <Typography variant="body2" color="text.secondary">
              Notifications are blocked for this site. Turn them back on in the
              browser’s site settings — a page cannot ask again once refused.
            </Typography>
          </Box>
        ) : (
          <>
            <MenuItem
              selected={on && st.mode === 'mentions'}
              disabled={busy}
              onClick={() => choose('mentions')}
            >
              only replies and mentions
            </MenuItem>
            <MenuItem
              selected={on && st.mode === 'all'}
              disabled={busy}
              onClick={() => choose('all')}
            >
              any new message in the rooms
            </MenuItem>
            {/*
              "In rooms" is the whole point: user threads are deliberately excluded from "all" —
              dozens are created daily and the phone would never stop ringing. In threads only
              personally addressed events ring (reply to your thread/message, mention); the rest is
              opt-in per thread below.
            */}
            <Box sx={{ px: 2, pb: 1, maxWidth: 280 }}>
              <Typography variant="caption" color="text.secondary">
                Threads are not included — there you only hear about replies to
                you and to your own thread.
              </Typography>
            </Box>
            <MenuItem selected={!on} disabled={busy} onClick={turnOff}>
              nothing — notifications off
            </MenuItem>
          </>
        )}

        {/*
          Second half = per-ROOM setting. One setting for the whole chat forces a choice between
          "rings constantly" (General) and "misses what matters" (your private room). Room setting
          overrides device setting in both directions.
        */}
        {on && roomId && [
          <Divider key="rd" />,
          <Box key="rc" sx={{ px: 2, py: 1 }}>
            <Typography variant="caption" color="text.secondary">
              In {roomName || 'this room'}…
            </Typography>
          </Box>,
          <MenuItem
            key="r0"
            selected={roomMode === ''}
            disabled={busy}
            onClick={() => chooseRoom('')}
          >
            same as above
          </MenuItem>,
          <MenuItem
            key="r1"
            selected={roomMode === 'all'}
            disabled={busy}
            onClick={() => chooseRoom('all')}
          >
            any new message
          </MenuItem>,
          <MenuItem
            key="r2"
            selected={roomMode === 'mentions'}
            disabled={busy}
            onClick={() => chooseRoom('mentions')}
          >
            only replies and mentions
          </MenuItem>,
          <MenuItem
            key="r3"
            selected={roomMode === 'mute'}
            disabled={busy}
            onClick={() => chooseRoom('mute')}
          >
            mute this room
          </MenuItem>,
          <MenuItem key="r4" disabled={busy} onClick={() => chooseRoom('mute1h')}>
            mute for an hour
          </MenuItem>,
          <MenuItem key="r5" disabled={busy} onClick={() => chooseRoom('mute24h')}>
            mute for a day
          </MenuItem>,
        ]}

        {on && [
          <Divider key="d" />,
          <MenuItem
            key="t"
            onClick={async () => {
              setAnchor(null);
              try {
                await pushTest();
                onMessage?.('Test notification sent.');
              } catch {
                onMessage?.('Could not send the test notification.');
              }
            }}
          >
            Send a test notification
          </MenuItem>,
        ]}
      </Menu>
    </>
  );
}
