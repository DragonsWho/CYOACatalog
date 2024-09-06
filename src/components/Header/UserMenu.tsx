// src/components/Header/UserMenu.tsx
// Version 1.0.0
// Converted to TypeScript

import { useState } from 'react';
import { Button, Menu, MenuItem, Avatar } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import { User } from '../../pocketbase/pocketbase';

export default function UserMenu({ currentUser, onLogout }: { currentUser: User | null; onLogout: () => void }) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();

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
        <MenuItem
          onClick={() => {
            onLogout();
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
