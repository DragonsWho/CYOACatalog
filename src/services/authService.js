// src/services/authService.js
// Version: 1.1.0
// Description: ������ ��� ���������� ��������������� �������������
// �������� ����� getDiscordAuthURL ��� ������ ����� Strapi ������

import axios from 'axios';

axios.defaults.withCredentials = true;
const API_URL = 'http://localhost:1337';

const authService = {
    // ������� ��� ����������� ������ ������������
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

    // ������� ��� ����� ������������
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

    // ������� ��� ������ ������������
    logout: () => {
        localStorage.removeItem('user');
    },

    // ������� ��� ��������� �������� ������������
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

    // ������� ��� ��������, ����������� �� ������������
    isAuthenticated: () => {
        const user = authService.getCurrentUser();
        return !!user && !!user.jwt;
    },

    // ����� ��� ��������� URL ����������� Discord
    getDiscordAuthURL: async () => {
        try {
            const response = await axios.get(`${API_URL}/api/connect/discord`, {
                withCredentials: true
            });
            if (response.data && response.data.url) {
                return response.data.url;
            } else {
                throw new Error('Invalid response from server');
            }
        } catch (error) {
            console.error('Error getting Discord auth URL:', error);
            throw error;
        }
    },

    initiateDiscordLogin: async () => {
        try {
            // �������������� ������������ �� �������� Strapi ��� ��������� OAuth
            window.location.href = `${API_URL}/api/connect/discord`;
        } catch (error) {
            console.error('Error initiating Discord login:', error);
            throw error;
        }
    },

    // ����� ��� ��������� callback �� Discord
    handleDiscordCallback: async (code) => {
        try {
            const response = await axios.get(`${API_URL}/api/auth/discord/callback?code=${code}`);
            if (response.data.jwt) {
                localStorage.setItem('user', JSON.stringify(response.data));
            }
            return response.data;
        } catch (error) {
            console.error('Error handling Discord callback:', error);
            throw error;
        }
    },
};

export default authService;