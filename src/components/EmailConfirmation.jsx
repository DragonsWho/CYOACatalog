// src/components/EmailConfirmation.jsx
// Version: 1.0.0
// Description: Component for handling email confirmation

import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Typography, Container, CircularProgress } from '@mui/material';
import authService from '../services/authService';

const EmailConfirmation = () => {
    const [status, setStatus] = useState('confirming');
    const location = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        const confirmEmail = async () => {
            const searchParams = new URLSearchParams(location.search);
            const confirmationToken = searchParams.get('confirmation');

            if (!confirmationToken) {
                setStatus('error');
                return;
            }

            try {
                await authService.confirmEmail(confirmationToken);
                setStatus('success');
                setTimeout(() => navigate('/'), 3000); // Redirect to home page after 3 seconds
            } catch (error) {
                console.error('Email confirmation error:', error);
                setStatus('error');
            }
        };

        confirmEmail();
    }, [location, navigate]);

    return (
        <Container maxWidth="sm" style={{ textAlign: 'center', marginTop: '50px' }}>
            {status === 'confirming' && (
                <>
                    <CircularProgress />
                    <Typography variant="h6" style={{ marginTop: '20px' }}>
                        Confirming your email...
                    </Typography>
                </>
            )}
            {status === 'success' && (
                <Typography variant="h6" color="primary">
                    Your email has been confirmed successfully. You will be redirected to the home page shortly.
                </Typography>
            )}
            {status === 'error' && (
                <Typography variant="h6" color="error">
                    There was an error confirming your email. Please try again or contact support.
                </Typography>
            )}
        </Container>
    );
};

export default EmailConfirmation;