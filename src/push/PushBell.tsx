// Колокольчик веб-пушей: одна кнопка в панели чата + меню с режимом.
//
// Кнопки нет вовсе, если пуши невозможны (сервер без ключей VAPID, браузер без
// PushManager, iOS-сафари вне «на экран Домой»). Показывать мёртвый тумблер
// хуже, чем не показывать никакого: человек ткнёт, ничего не произойдёт и он
// решит, что уведомления сломаны.

import { useCallback, useEffect, useState } from 'react';
import { IconButton, Menu, MenuItem, Tooltip, Divider, Typography, Box } from '@mui/material';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import {
  pushState, pushSubscribe, pushUnsubscribe, pushSetMode, pushTest,
  type PushMode, type PushState,
} from './pushClient';

type Props = {
  /** Гостю пуши не положены: они привязаны к аккаунту, а не к устройству. */
  signedIn: boolean;
  onMessage?: (text: string) => void;
};

export default function PushBell({ signedIn, onMessage }: Props) {
  const [st, setSt] = useState<PushState | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => { pushState().then(setSt); }, []);
  useEffect(() => { refresh(); }, [refresh, signedIn]);

  if (!signedIn || !st?.available) return null;

  const on = st.subscribed && st.permission === 'granted';

  const toggle = async () => {
    setBusy(true);
    try {
      if (on) {
        await pushUnsubscribe();
        onMessage?.('Notifications are off on this device.');
      } else {
        const err = await pushSubscribe(st.mode);
        onMessage?.(err ?? 'Notifications are on for this device.');
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const setMode = async (m: PushMode) => {
    await pushSetMode(m);
    setAnchor(null);
    refresh();
  };

  return (
    <>
      <Tooltip title={on ? 'Push notifications on' : 'Push notifications off'}>
        <span>
          <IconButton
            size="small"
            disabled={busy}
            onClick={toggle}
            // Долгий тап/правый клик открывает настройки: обычному человеку
            // нужен только вкл/выкл, режим — для тех, кто полез искать.
            onContextMenu={(e) => { e.preventDefault(); setAnchor(e.currentTarget); }}
            color={on ? 'primary' : 'default'}
            // Именно «push»: в шапке сайта уже висит свой колокольчик
            // внутрисайтовых уведомлений с aria-label="Notifications".
            aria-label="Push notifications"
          >
            {on ? <NotificationsActiveOutlinedIcon fontSize="small" />
                : <NotificationsOffOutlinedIcon fontSize="small" />}
          </IconButton>
        </span>
      </Tooltip>

      {on && (
        <Tooltip title="Notification settings">
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ cursor: 'pointer', userSelect: 'none' }}
            onClick={(e) => setAnchor(e.currentTarget)}
          >
            {st.mode === 'all' ? 'all' : '@'}
          </Typography>
        </Tooltip>
      )}

      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="caption" color="text.secondary">Notify me when…</Typography>
        </Box>
        <MenuItem selected={st.mode === 'mentions'} onClick={() => setMode('mentions')}>
          someone replies or mentions me
        </MenuItem>
        <MenuItem selected={st.mode === 'all'} onClick={() => setMode('all')}>
          any message is posted
        </MenuItem>
        <Divider />
        <MenuItem
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
        </MenuItem>
      </Menu>
    </>
  );
}
