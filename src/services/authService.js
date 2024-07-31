// src/services/authService.js
// Version: 1.0.1
// Description: ������ ��� ���������� ��������������� �������������
// ��������� ��������� ������������ ������ � getCurrentUser

import axios from 'axios';

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
};

export default authService;