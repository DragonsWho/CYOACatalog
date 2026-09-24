import React, { useState, useContext, useEffect } from 'react';
import { Button, Divider, Menu, MenuItem, Avatar, Box, Chip, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import { pb, User, AuthContext } from '../../pocketbase/pocketbase';
import { openTicketCount } from '../Moderation/modRequestsApi';
import { FORUM_SSO_URL} from './externalLinks';

interface UserMenuProps {
  currentUser: User | null;
  isMobile?: boolean;
  isBelow400px?: boolean;
}

const UserMenu: React.FC<UserMenuProps> = ({ currentUser, isMobile, isBelow400px }) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator, hasModPerm } = useContext(AuthContext);
  const theme = useTheme();
  const [openTickets, setOpenTickets] = useState(0);

  // Open-ticket count drives the "Mod tickets" badge (the queue is the moderator's notification
  // surface).
  useEffect(() => {
    if (!isModerator) return;
    let alive = true;
    const tick = () => openTicketCount().then((n) => alive && setOpenTickets(n)).catch(() => {});
    tick();
    const h = window.setInterval(tick, 60_000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [isModerator]);

  const handleLogout = async () => {
    setAnchorEl(null);
    pb.authStore.clear();
    Cookies.remove('flarum_token', { domain: '.cyoa.cafe', path: '/' });
    Cookies.remove('flarum_remember', { domain: '.cyoa.cafe', path: '/' });
    
    // Reload the page to reset all React state.
    navigate('/');
    window.location.reload();
  };

  const userInitial = currentUser?.username?.charAt(0).toUpperCase();
  const userAvatarUrl = currentUser?.avatar ? pb.files.getURL(currentUser, currentUser.avatar, { thumb: '50x50' }) : undefined;

  // Button box = the header's icon buttons (38px, 32px below 400px). Mirrored in src/prepaint.
  const avatarSize = isBelow400px ? 24 : 28;
  const buttonPaddingValue = isBelow400px ? '4px' : '5px';

  return (
    <>
      <Button
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{
          textTransform: 'none',
          minWidth: 'auto',
          padding: isMobile ? buttonPaddingValue : `${buttonPaddingValue} ${theme.spacing(1)}`,
          '& .MuiButton-startIcon': {
            marginRight: (isMobile || !currentUser?.username) ? 0 : theme.spacing(1),
          },
        }}
        startIcon={
          (userAvatarUrl || userInitial) ? (
            userAvatarUrl ? (
              <Avatar src={userAvatarUrl} alt={currentUser?.username || 'User Avatar'} sx={{ width: avatarSize, height: avatarSize }} />
            ) : (
              <Avatar sx={{ width: avatarSize, height: avatarSize, fontSize: isBelow400px ? '0.7rem' : '0.8rem' }}>
                {userInitial || '?'}
              </Avatar>
            )
          ) : null
        }
      >
        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' }, fontSize: '0.875rem', lineHeight: 1.5 }}>
          {currentUser?.username}
        </Box>
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/profile'); }}>Profile</MenuItem>
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/hosting'); }}>Hosting</MenuItem>
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/roulette'); }}>🎲 Bump roulette</MenuItem>
        {/*
          External community links: out of the header nav row; this menu is their home for
          signed-in users, guests use the header ⋮ menu.
        */}
        <MenuItem
          component="a"
          href={FORUM_SSO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setAnchorEl(null)}
        >
          Forum ↗
        </MenuItem> 
        <Divider />
        {isModerator && (
          <>
            {hasModPerm('comments') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/comments'); }}>Comment moderation</MenuItem>
            )}
            {hasModPerm('tickets') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/tickets'); }}>
                Mod tickets
                {openTickets > 0 && (
                  <Chip size="small" color="warning" label={openTickets} sx={{ ml: 1, height: 18 }} />
                )}
              </MenuItem>
            )}
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/suggestions'); }}>Suggested links</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/screenshots'); }}>Screenshot studio</MenuItem>
            {/*
              Items gated by permissions (mod_perms.go) are hidden when unavailable; the real
              enforcement is in Go handlers.
            */}
            {hasModPerm('review') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/review'); }}>Review queue</MenuItem>
            )}
            {hasModPerm('mod_upload') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/mod-tools'); }}>Mod Tools: add games</MenuItem>
            )}
            {hasModPerm('queue') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/queue'); }}>Publication queue</MenuItem>
            )}
            {hasModPerm('stats') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/stats'); }}>View stats</MenuItem>
            )}
            {hasModPerm('roulette') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/roulette'); }}>Bump roulette</MenuItem>
            )}
            {hasModPerm('perms') && (
              <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/access'); }}>Moderator access</MenuItem>
            )}
          </>
        )}
        <MenuItem onClick={handleLogout}>Logout</MenuItem>
      </Menu>
    </>
  );
};

export default UserMenu;