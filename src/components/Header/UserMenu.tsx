// src/components/Header/UserMenu.tsx
import { useState, useContext } from 'react';
import { Button, Menu, MenuItem, Avatar } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import { pb, User } from '../../pocketbase/pocketbase';
import { AuthContext } from '../../pocketbase/pocketbase';

export default function UserMenu({ currentUser }: { currentUser: User | null }) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator } = useContext(AuthContext); // Получаем флаг модератора

  return (
    <>
      <Button
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{
          width: '100%',
          justifyContent: 'center',
          '& .MuiButton-startIcon': {
            marginRight: '8px',
            marginLeft: 0,
          },
        }}
        startIcon={<Avatar sx={{ width: 24, height: 24 }}>{currentUser?.username.charAt(0)}</Avatar>}
      >
        Account
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        <MenuItem onClick={() => setAnchorEl(null)} component={Link} to="/profile">
          Profile
        </MenuItem>
        {isModerator && (
          <MenuItem onClick={() => setAnchorEl(null)} component={Link} to="/moderator">
            Moderator Panel
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            pb.authStore.clear();
            setAnchorEl(null);
            navigate('/');
          }}
        >
          Logout
        </MenuItem>
      </Menu>
    </>
  );
}