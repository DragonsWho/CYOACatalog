// src/components/Header/UserMenu.tsx
import { useState, useContext } from 'react';
import { Button, Menu, MenuItem, Avatar, Box, useTheme, useMediaQuery } from '@mui/material'; // Import Box
import { useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import { pb, User } from '../../pocketbase/pocketbase';
import { AuthContext } from '../../pocketbase/pocketbase';

export default function UserMenu({ currentUser }: { currentUser: User | null }) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator } = useContext(AuthContext);

  // Alternative using useMediaQuery hook (more explicit control)
  // const theme = useTheme();
  // const isMobile = useMediaQuery(theme.breakpoints.down('sm')); // 'sm' is default breakpoint for 600px

  const handleLogout = () => {
    pb.authStore.clear();
    console.log('UserMenu: PocketBase session cleared.');
    Cookies.remove('flarum_token', { domain: '.cyoa.cafe', path: '/' });
    Cookies.remove('flarum_remember', { domain: '.cyoa.cafe', path: '/' });
    console.log('UserMenu: Flarum cookies removed.');
    setAnchorEl(null);
    navigate('/');
  };

  const userInitial = currentUser?.username?.charAt(0).toUpperCase();
  const userAvatarUrl = currentUser?.avatar ? pb.getFileUrl(currentUser, currentUser.avatar, { thumb: '50x50' }) : undefined;

  return (
    <>
      <Button
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{
          textTransform: 'none',
          // Adjust padding for icon-only state on mobile
          // Default Button padding is '6px 16px'. For an icon, '8px' or '6px' might be better.
          padding: { xs: '8px', sm: '6px 16px' }, // Example: more square padding on mobile
          minWidth: { xs: 'auto', sm: '64px' },    // Allow button to shrink to icon size on mobile

          '& .MuiButton-startIcon': {
            // No margin for icon on mobile, 8px on larger screens
            marginRight: { xs: 0, sm: '8px' },
            // Ensure icon is not affected by button's internal padding differently
            // marginLeft: 0, // Usually default
          },
        }}
        startIcon={
          userAvatarUrl ? (
            <Avatar
              src={userAvatarUrl}
              alt={currentUser?.username || 'User Avatar'} // Provide a fallback alt text
              sx={{ width: 24, height: 24 }}
            />
          ) : (
            <Avatar sx={{ width: 24, height: 24, fontSize: '0.8rem' }}>
              {userInitial || '?'} {/* Fallback if no username */}
            </Avatar>
          )
        }
      >
        {/* Text part: Show only on 'sm' breakpoint and up */}
        <Box
          component="span" // Render as a span
          sx={{
            display: { xs: 'none', sm: 'inline' }, // Hide on xs, show on sm and up
            // marginLeft: { xs: 0, sm: 0.5 } // Optional: if you want a slight gap handled by the text itself
          }}
        >
          {currentUser?.username || 'Account'}
        </Box>
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/profile'); }}>
          Profile
        </MenuItem>
        {isModerator && (
          <>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator'); }}>
              Moderator Panel
            </MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/vector-search'); }}>
              Vector Search
            </MenuItem>
          </>
        )}
        <MenuItem onClick={handleLogout}>
          Logout
        </MenuItem>
      </Menu>
    </>
  );
}