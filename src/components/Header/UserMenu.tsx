import React, { useState, useContext, useEffect } from 'react';
import { Button, Divider, Menu, MenuItem, Avatar, Box, Chip, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import { pb, User, AuthContext } from '../../pocketbase/pocketbase';
import { openTicketCount } from '../Moderation/modRequestsApi';
import { FORUM_SSO_URL, DISCORD_INVITE_URL } from './externalLinks';

interface UserMenuProps {
  currentUser: User | null;
  isMobile?: boolean;
  isBelow400px?: boolean;
}

const UserMenu: React.FC<UserMenuProps> = ({ currentUser, isMobile, isBelow400px }) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator } = useContext(AuthContext);
  const theme = useTheme();
  const [openTickets, setOpenTickets] = useState(0);

  // Open-ticket count drives the badge on the "Mod tickets" menu item — the
  // moderator queue is the mod's notification surface.
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
    
    // Перезагружаем страницу, чтобы сбросить все стейты React
    navigate('/');
    window.location.reload();
  };

  const userInitial = currentUser?.username?.charAt(0).toUpperCase();
  const userAvatarUrl = currentUser?.avatar ? pb.files.getURL(currentUser, currentUser.avatar, { thumb: '50x50' }) : undefined;

  const avatarSize = isMobile ? (isBelow400px ? 20 : 22) : 24;
  const buttonPaddingValue = isMobile ? (isBelow400px ? '4px' : '5px') : '6px';

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
        {/* Выпадающее меню — дом для «интересного» помимо шапки; пока только рулетка. */}
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/roulette'); }}>🎲 Bump roulette</MenuItem>
        {/* External community links — they left the header nav row (header redesign),
            this menu is their home for signed-in users; guests get them in the
            header's ⋮ menu. */}
        <MenuItem
          component="a"
          href={FORUM_SSO_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setAnchorEl(null)}
        >
          Forum ↗
        </MenuItem>
        <MenuItem
          component="a"
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setAnchorEl(null)}
        >
          Discord ↗
        </MenuItem>
        <Divider />
        {isModerator && (
          <>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator'); }}>Moderator Panel</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/tickets'); }}>
              Mod tickets
              {openTickets > 0 && (
                <Chip size="small" color="warning" label={openTickets} sx={{ ml: 1, height: 18 }} />
              )}
            </MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/suggestions'); }}>Suggested links</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/review'); }}>Review queue</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/queue'); }}>Publication queue</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/stats'); }}>View stats</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator/roulette'); }}>Bump roulette</MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/vector-search'); }}>Vector Search</MenuItem>
          </>
        )}
        <MenuItem onClick={handleLogout}>Logout</MenuItem>
      </Menu>
    </>
  );
};

export default UserMenu;