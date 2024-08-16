// src/components/Header/Login.jsx
// Version: 1.2.0
// Description: Combined Login and Register component with simplified interface

import React, { useState } from 'react';
import { TextField, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions } from "@mui/material";
import authService from '../../services/authService';

const Login = ({ open, onClose, onLoginSuccess }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const user = await authService.login(email, password);
            onLoginSuccess(user);
            handleClose();
        } catch (error) {
            console.error('Login error:', error);
            setError('Invalid email or password');
        }
    };

    const handleRegister = async () => {
        try {
            const user = await authService.register("New User", email, password);
            onLoginSuccess(user);
            handleClose();
        } catch (error) {
            console.error('Registration error:', error);
            if (error.response && error.response.status === 500) {
                setError('This email is already registered or invalid. Please try a different email.');
            } else {
                setError('Registration failed. Please try again.');
            }
        }
    };

    const handleClose = () => {
        setEmail('');
        setPassword('');
        setError('');
        onClose();
    };

    return (
        <Dialog open={open} onClose={handleClose}>
            <DialogTitle>Login or Register</DialogTitle>
            <DialogContent>
                <form onSubmit={handleLogin}>
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        fullWidth
                        margin="normal"
                        required
                    />
                    <TextField
                        label="Password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        fullWidth
                        margin="normal"
                        required
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
                <Button onClick={handleRegister} color="primary" variant="outlined">
                    Register
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default Login;