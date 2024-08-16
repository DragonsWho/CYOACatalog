import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import authService from '../services/authService';

const AuthCallback = () => {
    const navigate = useNavigate();
    const location = useLocation();

    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const token = searchParams.get('token');

        if (token) {
            authService.handleDiscordCallback(token);
            navigate('/'); // ��������������� �� ������� �������� ����� �������� ��������������
        } else {
            navigate('/login'); // ��������������� �� �������� �����, ���� ����� �����������
        }
    }, [navigate, location]);

    return <div>Processing authentication...</div>;
};

export default AuthCallback;