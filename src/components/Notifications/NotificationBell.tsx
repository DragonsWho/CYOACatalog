import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  Badge,
  Box,
  CircularProgress,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import { useNavigate } from 'react-router-dom';
import { AuthContext, Notification } from '../../pocketbase/pocketbase';
import { relativeTime } from '../CyoaPage/Comments/relativeTime';
import {
  fetchNotifications,
  isShoutNotification,
  markRead,
  notificationLink,
  notificationText,
  unreadCount,
} from './notificationsApi';
import { thinScrollbar } from '../../styles/scrollbar';

const POLL_MS = 60_000;

interface NotificationBellProps {
  iconFontSize?: string;
  padding?: string;
}

const NotificationBell: React.FC<NotificationBellProps> = ({ iconFontSize, padding }) => {
  const { signedIn } = useContext(AuthContext);
  const theme = useTheme();
  const navigate = useNavigate();

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const open = Boolean(anchorEl);

  const refreshCount = useCallback(async () => {
    try {
      setUnread(await unreadCount());
    } catch {
      /* offline / not ready — leave the badge as-is */
    }
  }, []);

  // Poll the unread count while signed in.
  useEffect(() => {
    if (!signedIn) {
      setUnread(0);
      setItems([]);
      return;
    }
    refreshCount();
    const id = window.setInterval(refreshCount, POLL_MS);
    return () => window.clearInterval(id);
  }, [signedIn, refreshCount]);

  const handleOpen = async (e: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(e.currentTarget);
    setLoading(true);
    try {
      const res = await fetchNotifications();
      setItems(res.items);
      // Opening the tray clears the badge; the rows already loaded keep their
      // "unread" styling for this view so the user can still see what's new.
      if (res.items.some((n) => !n.read)) {
        await markRead();
        setUnread(0);
      }
    } catch {
      /* leave whatever we had */
    } finally {
      setLoading(false);
    }
  };

  const handleClick = (n: Notification) => {
    setAnchorEl(null);
    // Chat notifications open the shoutbox drawer (ShoutboxButton listens),
    // everything else navigates to the game/comment.
    if (isShoutNotification(n)) {
      window.dispatchEvent(new CustomEvent('shoutbox:open'));
      return;
    }
    navigate(notificationLink(n));
  };

  if (!signedIn) return null;

  return (
    <>
      <Tooltip title="Notifications" arrow>
        <IconButton
          color="inherit"
          onClick={handleOpen}
          sx={{ padding }}
          aria-label="Notifications"
        >
          <Badge badgeContent={unread} color="error" max={99}>
            <NotificationsNoneIcon sx={{ fontSize: iconFontSize }} />
          </Badge>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { width: 340, maxWidth: '92vw', maxHeight: 440, ...thinScrollbar } },
        }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Notifications
          </Typography>
        </Box>
        <Divider />

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={22} />
          </Box>
        )}

        {!loading && items.length === 0 && (
          <Box sx={{ px: 2, py: 3 }}>
            <Typography variant="body2" color="text.secondary">
              Nothing here yet.
            </Typography>
          </Box>
        )}

        {!loading &&
          items.map((n) => (
            <MenuItem
              key={n.id}
              onClick={() => handleClick(n)}
              sx={{
                display: 'block',
                whiteSpace: 'normal',
                py: 1,
                borderLeft: '3px solid',
                borderLeftColor: n.read ? 'transparent' : theme.palette.primary.main,
                bgcolor: n.read ? 'transparent' : 'rgba(255,255,255,0.04)',
              }}
            >
              <Typography variant="body2" sx={{ lineHeight: 1.35 }}>
                {notificationText(n)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {relativeTime(n.created)}
              </Typography>
            </MenuItem>
          ))}
      </Menu>
    </>
  );
};

export default NotificationBell;
