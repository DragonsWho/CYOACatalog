// src/services/authService.js
// Version: 1.0.1
// Description: Модуль для управления аутентификацией пользователей
// Обновлена структура возвращаемых данных в getCurrentUser

import axios from 'axios';

const API_URL = 'http://localhost:1337';

const authService = {
    // Функция для регистрации нового пользователя
    register: async (username, email, password) => {
        try {
            const response = await axios.post(`${API_URL}/api/auth/local/register`, {
                username,
                email,
                password,
            });
            if (response.data.jwt) {
                localStorage.setItem('user', JSON.stringify(response.data));
            }
            return response.data;
        } catch (error) {
            throw error;
        }
    },

    // Функция для входа пользователя
    login: async (identifier, password) => {
        try {
            const response = await axios.post(`${API_URL}/api/auth/local`, {
                identifier,
                password,
            });
            if (response.data.jwt) {
                localStorage.setItem('user', JSON.stringify(response.data));
            }
            return response.data;
        } catch (error) {
            console.error('Auth service login error:', error.response || error);
            throw error;
        }
    },

    // Функция для выхода пользователя
    logout: () => {
        localStorage.removeItem('user');
    },

    // Функция для получения текущего пользователя
    getCurrentUser: () => {
        const userStr = localStorage.getItem('user');
        if (userStr) {
            try {
                return JSON.parse(userStr);
            } catch (e) {
                console.error('Error parsing user data:', e);
                return null;
            }
        }
        return null;
    },

    // Функция для проверки, авторизован ли пользователь
    isAuthenticated: () => {
        const user = authService.getCurrentUser();
        return !!user && !!user.jwt;
    },
};

export default authService;