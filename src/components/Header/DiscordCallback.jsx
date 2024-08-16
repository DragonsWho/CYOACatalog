// src/components/Header/DiscordCallback.jsx
// Version: 1.0.0
// Description: Component to handle Discord OAuth callback

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import authService from '../../services/authService';

const DiscordCallback = () => {
    const navigate = useNavigate();

    useEffect(() => {
        const handleCallback = async () => {
            const urlParams = new URLSearchParams(window.location.search);
            const code = urlParams.get('code');

            if (code) {
                try {
                    const user = await authService.handleDiscordCallback(code);
                    // Здесь можно добавить логику для обновления состояния приложения
                    navigate('/'); // Перенаправляем на главную страницу после успешной авторизации
                } catch (error) {
                    console.error('Error during Discord callback:', error);
                    navigate('/login'); // Перенаправляем на страницу входа в случае ошибки
                }
            } else {
                navigate('/login');
            }
        };

        handleCallback();
    }, [navigate]);

    return <div>Processing Discord login...</div>;
};

export default DiscordCallback;