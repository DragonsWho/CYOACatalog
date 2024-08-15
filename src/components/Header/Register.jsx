// src/components/Header/Register.jsx
// Version: 1.0.0
// Description: Register modal component with Google authentication

import React, { useState } from 'react';
import { TextField, Button, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Divider } from "@mui/material";
import GoogleIcon from '@mui/icons-material/Google';
import authService from '../../services/authService';

const Register = ({ open, onClose, onRegisterSuccess }) => {
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleRegister = async (e) => {
        e.preventDefault();
        try {
            const user = await authService.register(username, email, password);
            onRegisterSuccess(user);
            handleClose();
        } catch (error) {
            console.error('Register error:', error);
            setError(error.response?.data?.error?.message || 'Registration failed');
        }
    };

    const handleGoogleRegister = async () => {
        try {
            const user = await authService.googleLogin(); // This will register if the user doesn't exist
            onRegisterSuccess(user);
            handleClose();
        } catch (error) {
            console.error('Google register error:', error);
            setError('Google registration failed');
        }
    };

    const handleClose = () => {
        setUsername('');
        setEmail('');
        setPassword('');
        setError('');
        onClose();
    };

    return (
        <Dialog open={open} onClose={handleClose}>
            <DialogTitle>Register</DialogTitle>
            <DialogContent>
                <form onSubmit={handleRegister}>
                    <TextField
                        label="Username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        fullWidth
                        margin="normal"
                    />
                    <TextField
                        label="Email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
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
                <Divider style={{ margin: '20px 0' }}>or</Divider>
                <Button
                    startIcon={<GoogleIcon />}
                    variant="outlined"
                    fullWidth
                    onClick={handleGoogleRegister}
                >
                    Register with Google
                </Button>
            </DialogContent>
            <DialogActions>
                <Button onClick={handleClose} color="primary">
                    Cancel
                </Button>
                <Button onClick={handleRegister} color="primary" variant="contained">
                    Register
                </Button>
            </DialogActions>
        </Dialog>
    );
};

export default Register;