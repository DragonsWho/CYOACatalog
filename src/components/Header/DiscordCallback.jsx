// src/components/Header/DiscordCallback.jsx
import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import authService from '../../services/authService';

const DiscordCallback = () => {
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        const handleCallback = async () => {
            const searchParams = new URLSearchParams(location.search);
            const token = searchParams.get('token');
            const error = searchParams.get('error');

            if (error) {
                console.error('Authentication error:', error);
                navigate('/login', { state: { error } });
                return;
            }

            if (token) {
                try {
                    // Сохранение токена и получение информации о пользователе
                    await authService.handleDiscordCallback(token);
                    navigate('/');
                } catch (error) {
                    console.error('Error handling Discord callback:', error);
                    navigate('/login', { state: { error: 'Failed to authenticate' } });
                }
            } else {
                navigate('/login', { state: { error: 'No token received' } });
            }
        };

        handleCallback();
    }, [navigate, location]);

    return <div>Processing Discord login...</div>;
};

export default DiscordCallback;