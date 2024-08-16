// src/components/Header/Login.jsx
// Version: 1.5.0
// Description: Login modal component with both email/password and Discord OAuth support

import React, { useState } from 'react';
import { TextField, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Divider } from "@mui/material";
import authService from '../../services/authService';

const Login = ({ open, onClose, onLoginSuccess }) => {
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const user = await authService.login(identifier, password);
            onLoginSuccess(user);
            handleClose();
        } catch (error) {
            console.error('Login error:', error);
            setError(error.response?.data?.error?.message || 'Login error');
        }
    };

    const handleDiscordLogin = () => {
        try {
            authService.initiateDiscordLogin();
        } catch (error) {
            console.error('Discord login error:', error);
            setError('Failed to initiate Discord login');
        }
    };

    const handleClose = () => {
        setIdentifier('');
        setPassword('');
        setError('');
        onClose();
    };

    return (
        <Dialog open={open} onClose={handleClose}>
            <DialogTitle>Login</DialogTitle>
            <DialogContent>
                <form onSubmit={handleLogin}>
                    <TextField
                        label="Email or username"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        fullWidth
                        margin="normal"
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        fullWidth
                        margin="normal"
                    />
                    <Button
                        type="submit"
                        color="primary"
                        variant="contained"
                        fullWidth
                        style={{ marginTop: '20px' }}
                    >
                        Login
                    </Button>
                </form>
                <Divider style={{ margin: '20px 0' }}>
                    <Typography variant="body2" color="textSecondary">
                        OR
                    </Typography>
                </Divider>
                <Button
                    onClick={handleDiscordLogin}
                    color="primary"
                    variant="outlined"
                    fullWidth
                >
                    Login with Discord
                </Button>
                {error && <Typography color="error" style={{ marginTop: '10px' }}>{error}</Typography>}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} color="primary">
                    Cancel
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default Login;