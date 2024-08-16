// src/services/authService.js
// Version: 1.2.0
// Description: ������ ��� ���������� ��������������� �������������
// �������� ����� handleDiscordCallback ��� ��������� ���������� � ������������

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
        localStorage.removeItem('token');
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

    handleDiscordCallback: async (token) => {
        if (token) {
            localStorage.setItem('token', token);

            try {
                const response = await axios.get(`${API_URL}/api/users/me`, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                });

                const user = response.data;
                const userData = { user, jwt: token };
                localStorage.setItem('user', JSON.stringify(userData));
                return userData;
            } catch (error) {
                console.error('Error fetching user data:', error);
                throw error;
            }
        } else {
            throw new Error('No token provided');
        }
    },

    // ����� ����� ��� ��������� ������
    getToken: () => {
        return localStorage.getItem('token');
    },
};

export default authService;