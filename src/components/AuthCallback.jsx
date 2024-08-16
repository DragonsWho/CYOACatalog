// src/components/AuthCallback.jsx
import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import authService from '../services/authService';

const AuthCallback = ({ onLoginSuccess }) => {
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        const handleCallback = async () => {
            const searchParams = new URLSearchParams(location.search);
            const token = searchParams.get('token');

            if (token) {
                try {
                    const userData = await authService.handleDiscordCallback(token);
                    onLoginSuccess(userData);
                    navigate('/');
                } catch (error) {
                    console.error('Error handling Discord callback:', error);
                    navigate('/login');
                }
            } else {
                navigate('/login');
            }
        };

        handleCallback();
    }, [navigate, location, onLoginSuccess]);

    return <div>Processing authentication...</div>;
};

export default AuthCallback;