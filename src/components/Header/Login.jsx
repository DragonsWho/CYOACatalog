// src/components/Header/Login.jsx
// Version: 1.2.0
// Description: Login modal component

import React, { useState } from 'react';
import { TextField, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions } from "@mui/material";
import authService from '../../services/authService';

const Login = ({ open, onClose, onLoginSuccess }) => {
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const user = await authService.login(identifier, password);
            onLoginSuccess(user); // Вызываем функцию обратного вызова с данными пользователя
            handleClose();
        } catch (error) {
            console.error('Login error:', error);
            setError(error.response?.data?.error?.message || 'Login error');
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
                    {error && <Typography color="error">{error}</Typography>}
                </form>
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} color="primary">
                    Cancel
                </Button>
                <Button onClick={handleLogin} color="primary" variant="contained">
                    Login
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default Login;