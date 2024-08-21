// src/theme.js
// v1.4
// Changes: Added custom values for box shadow and border radius

import { createTheme } from '@mui/material/styles';

const theme = createTheme({
    palette: {
        mode: 'dark',
        primary: {
            main: '#fc3447', 
        },
        secondary: {
            main: '#ff4081',
        },
        background: {
            default: '#121212',
            paper: '#0b0b0b',
        },
        text: {
            primary: '#dcdcdc',
            secondary: 'rgba(255, 255, 255, 0.7)',
        },
    },
    components: {
        MuiCardContent: {
            styleOverrides: {
                root: {
                    '&:last-child': {
                        paddingBottom: 16,
                    },
                },
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    backgroundColor: '#1e1e1e',
                    borderRadius: '8px',
                },
            },
        },
        MuiChip: {
            styleOverrides: {
                root: {
                    borderRadius: '4px',
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    color: '#ffffff',
                    '&:hover': {
                        backgroundColor: 'rgba(255, 255, 255, 0.2)',
                    },
                },
            },
        },
    },
    custom: {
        cardTitle: {
            color: '#fc3447',
            textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
        },
        cardText: {
            color: 'rgba(255,255,255,0.9)',
            textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
        },
        boxShadow: '0 3px 5px 2px rgba(0, 0, 0, .3)',
        borderRadius: '3px',
    },
});

export default theme;