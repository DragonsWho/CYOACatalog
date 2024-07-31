// src/components/Login.jsx
// Version: 1.0.0
// Description: ��������� ����� �����

import React, { useState } from 'react';
import { TextField, Button, Typography } from "@mui/material";
import authService from '../services/authService';

const Login = () => {
    const [identifier, setIdentifier] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            await authService.login(identifier, password);
            // �������� ����� ��������� �����
            window.location.href = '/';  // ��� ����������� navigate �� react-router
        } catch (error) {
            console.error('Login error:', error);
            setError(error.response?.data?.error?.message || '��������� ������ ��� �����');
        }
    };

    return (
        <form onSubmit={handleLogin}>
            <Typography variant="h5">����</Typography>
            <TextField
                label="Email or name"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                fullWidth
                margin="normal"
            />
            <TextField
                label="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                fullWidth
                margin="normal"
            />
            <Button type="submit" variant="contained" color="primary">
                Login
            </Button>
            {error && <Typography color="error">{error}</Typography>}
        </form>
    );
};

export default Login;