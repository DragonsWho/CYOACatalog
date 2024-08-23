// src/services/authService.js
// Version: 1.9.0
// Description:

import axios from 'axios';

axios.defaults.withCredentials = true;
const API_URL = process.env.REACT_APP_API_URL || 'https://cyoa.cafe';

const authService = {
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
            console.error('Registration error:', error.response?.data || error);
            throw error;
        }
    },

    login: async (identifier, password) => {
        try {
            console.log('Attempting login with identifier:', identifier);
            const response = await axios.post(`${API_URL}/api/auth/local`, {
                identifier,
                password,
            });

            console.log('Login response:', response.data);

            if (response.data.jwt) {
                const userData = {
                    user: response.data.user,
                    jwt: response.data.jwt
                };
                localStorage.setItem('user', JSON.stringify(userData));
                localStorage.setItem('token', response.data.jwt);
                console.log('User data saved to localStorage');
            } else {
                console.warn('JWT not found in response');
            }
            return response.data;
        } catch (error) {
            console.error('Auth service login error:', error.response?.data || error);
            throw error.response?.data?.error || error;
        }
    },

    logout: () => {
        localStorage.removeItem('user');
        localStorage.removeItem('token');
    },

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

    isAuthenticated: () => {
        const user = authService.getCurrentUser();
        return !!user && !!user.jwt;
    },

    initiateDiscordLogin: () => {
        window.location.href = `${API_URL}/api/connect/discord`;
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

                const userData = {
                    user: response.data,
                    jwt: token
                };
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

    getToken: () => {
        const user = authService.getCurrentUser();
        return user ? user.jwt : null;
    },
};

export default authService;