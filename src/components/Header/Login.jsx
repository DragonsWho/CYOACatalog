// src/components/Header/Login.jsx
// Version: 1.9.1
// Description: Enhanced Login modal component with default prop values and prop type checking

import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { TextField, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Divider, CircularProgress } from "@mui/material";
import authService from '../../services/authService';

const Login = ({ open = false, onClose = () => { }, onLoginSuccess = () => { } }) => {
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    const handleLogin = async (e) => {
        e.preventDefault();
        if (!identifier || !password) {
            setError('Please fill in all fields');
            return;
        }
        setIsLoading(true);
        setError('');
        try {
            const userData = await authService.login(identifier, password);
            onLoginSuccess(userData);
            handleClose();
        } catch (error) {
            console.error('Login error:', error);
            setError(error.response?.data?.error?.message || error.message || 'Login failed. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleDiscordLogin = () => {
        setIsLoading(true);
        setError('');
        try {
            authService.initiateDiscordLogin();
        } catch (error) {
            console.error('Discord login error:', error);
            setError('Failed to initiate Discord login. Please try again.');
            setIsLoading(false);
        }
    };

    const handleClose = () => {
        setIdentifier('');
        setPassword('');
        setError('');
        setIsLoading(false);
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
                        disabled={isLoading}
                        required
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        fullWidth
                        margin="normal"
                        disabled={isLoading}
                        required
                    />
                    <Button
                        type="submit"
                        color="primary"
                        variant="contained"
                        fullWidth
                        style={{ marginTop: '20px' }}
                        disabled={isLoading}
                    >
                        {isLoading ? <CircularProgress size={24} /> : 'Login'}
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
                    disabled={isLoading}
                >
                    {isLoading ? <CircularProgress size={24} /> : 'Login with Discord'}
                </Button>
                {error && <Typography color="error" style={{ marginTop: '10px', textAlign: 'center' }}>{error}</Typography>}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} color="primary" disabled={isLoading}>
                    Cancel
                </Button>
            </DialogActions>
        </Dialog>
    );
};

Login.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func,
    onLoginSuccess: PropTypes.func
};

export default Login;