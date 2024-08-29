// src/components/Header/DiscordCallback.jsx
// Version: 1.1.0
// Description:

import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import authService from '../../services/authService';
import { CircularProgress, Typography } from '@mui/material';

const DiscordCallback = ({ onLoginSuccess }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const handleCallback = async () => {
      const searchParams = new URLSearchParams(location.search);
      const token = searchParams.get('token');
      const error = searchParams.get('error');

      if (error) {
        setError(error);
        setLoading(false);
        return;
      }

      if (token) {
        try {
          const userData = await authService.handleDiscordCallback(token);
          onLoginSuccess(userData);
          navigate('/');
        } catch (error) {
          setError('Failed to authenticate');
        }
      } else {
        setError('No token received');
      }
      setLoading(false);
    };

    handleCallback();
  }, [navigate, location, onLoginSuccess]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <CircularProgress />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Typography color="error">{error}</Typography>
      </div>
    );
  }

  return null;
};

export default DiscordCallback;
