// src/components/Header/UserMenu.tsx
// Version 1.0.0
// Converted to TypeScript

import React, { useState } from 'react'
import { Button, Menu, MenuItem, Avatar } from '@mui/material'
import { Link, useNavigate } from 'react-router-dom'

interface UserMenuProps {
    currentUser: {
        username: string
    }
    onLogout: () => void
}

const UserMenu: React.FC<UserMenuProps> = ({ currentUser, onLogout }) => {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null)
    const navigate = useNavigate()

    const handleMenuOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget)
    }

    const handleMenuClose = () => {
        setAnchorEl(null)
    }

    const handleLogout = () => {
        onLogout()
        handleMenuClose()
        navigate('/')
    }

    return (
        <>
            <Button
                color="inherit"
                onClick={handleMenuOpen}
                sx={{
                    width: '100%',
                    justifyContent: 'center',
                    '& .MuiButton-startIcon': {
                        marginRight: '8px',
                        marginLeft: 0,
                    },
                }}
                startIcon={<Avatar sx={{ width: 24, height: 24 }}>{currentUser.username.charAt(0)}</Avatar>}
            >
                Account
            </Button>
            <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
                <MenuItem onClick={handleMenuClose} component={Link} to="/profile">
                    Profile
                </MenuItem>
                <MenuItem onClick={handleLogout}>Logout</MenuItem>
            </Menu>
        </>
    )
}

export default UserMenu
