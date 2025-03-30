// src/theme.ts
// v1.8
// Changes: Added variants for Chip component states and CSS generated noise background

import { createTheme, ThemeOptions } from '@mui/material/styles';
import { CSSProperties } from 'react';



declare module '@mui/material/styles' {
  // Расширяем интерфейс Theme
  interface Theme {
    discord: { // Оставляем то, что было
      main: string;
      dark: string;
    };
    custom?: { // Добавляем все используемые кастомные поля
      cardTitle?: CSSProperties;
      cardText?: CSSProperties;
      boxShadow?: string; // Добавлено
      borderRadius?: string; // Добавлено
      comments?: { // Добавлено (структура из SimpleComments/GameDetails)
        backgroundColor?: string;
        borderRadius?: string;
        boxShadow?: string; // Добавим и его, если нужно
        color?: string;
        inputBackground?: string;
        inputBorder?: string;
        buttonBackground?: string;
        buttonHoverBackground?: string;
        replyBackground?: string;
        avatarBorder?: string;
        counterColor?: string;
      };
    };
  }

  // Расширяем интерфейс ThemeOptions (для createTheme)
  interface Palette { // Это уже было
    discord: {
      main: string;
      dark: string;
    };
  }
  interface PaletteOptions { // Это уже было
    discord?: {
      main: string;
      dark: string;
    };
  }
  interface ThemeOptions {
    discord?: { // Это уже было
      main: string;
      dark: string;
    };
    custom?: { // Добавляем все кастомные поля сюда тоже
      cardTitle?: CSSProperties;
      cardText?: CSSProperties;
      boxShadow?: string;
      borderRadius?: string;
      comments?: {
        backgroundColor?: string;
        borderRadius?: string;
        boxShadow?: string;
        color?: string;
        inputBackground?: string;
        inputBorder?: string;
        buttonBackground?: string;
        buttonHoverBackground?: string;
        replyBackground?: string;
        avatarBorder?: string;
        counterColor?: string;
      };
    };
  }
}

// Create SVG noise filter with specified parameters
const generateNoiseFilter = () => {
  // Parameters:
  // - Background: #151515
  // - Noise Color: #474747
  // - Noise Opacity: 13%
  // - Noise Density: 52%
  
  return `
    data:image/svg+xml,
    <svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'>
      <filter id='noise' x='0' y='0'>
        <feTurbulence 
          type='turbulence' 
          baseFrequency='0.322' 
          numOctaves='3' 
          stitchTiles='stitch'/>
        <feBlend mode='darken'/>
      </filter>
      <rect width='100%' height='100%' filter='url(%23noise)' opacity='0.07'/>
    </svg>
  `.replace(/\n\s+/g, '');
};

const themeOptions: ThemeOptions = {
  palette: {
    mode: 'dark',
    primary: {
      main: '#fc3447',
    },
    secondary: {
      main: '#ff4081',
    },
    background: {
      default: '#151515', // Base background color
      paper: '#0b0b0b',
    },
    text: {
      primary: '#dcdcdc',
      secondary: 'rgba(255, 255, 255, 0.7)',
    },
    discord: {
      main: '#5865F2',
      dark: '#4752C4',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#101010',
          backgroundImage: `url("${generateNoiseFilter()}")`,
          backgroundRepeat: 'repeat',
          backgroundSize: '300px 300px',
          backgroundPosition: '0 0',
          position: 'relative',
          '&::after': {
            content: '""',
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            backgroundColor: 'rgba(5, 5, 5, 0.25)',
            zIndex: -1,
          },
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            '& fieldset': {
              borderColor: 'rgba(255, 255, 255, 0.23)',
            },
            '&:hover fieldset': {
              borderColor: '#fc3447',
            },
            '&.Mui-focused fieldset': {
              borderColor: '#fc3447',
            },
          },
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          minHeight: '48px',
        },
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: '48px !important',
          '@media (min-width: 600px)': {
            minHeight: '48px !important',
          },
        },
      },
    },
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
          '&.MuiChip-colorPrimary': {
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            color: '#fc3447',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
            },
          },
          '&.Mui-disabled': {
            opacity: 0.5,
            color: 'rgba(255, 255, 255, 0.5)',
          },
        },
      },
      variants: [
        {
          // @ts-expect-error variant
          props: { variant: 'selected' },
          style: {
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            color: '#fc3447',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.2)',
            },
          },
        },
        {
          // @ts-expect-error variant
          props: { variant: 'inactive' },
          style: {
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            color: 'rgba(255, 255, 255, 0.5)',
            '&:hover': {
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
            },
          },
        },
      ],
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
    boxShadow: '0 3px 5px 2px rgba(0, 0, 0, .3)', // Теперь это известное поле
    borderRadius: '3px',                        // Теперь это известное поле
    comments: { // Теперь это известное поле
      backgroundColor: '#121212',
      borderRadius: '8px',
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
      color: '#e0e0e0',
      inputBackground: '#1e1e1e',
      inputBorder: '1px solid #3c3c3c',
      buttonBackground: '#ff4081',
      buttonHoverBackground: '#f50057',
      replyBackground: '#1a1a1a',
      avatarBorder: '2px solid #fc3447',
      counterColor: '#a0a0a0',
    },
  },
};

const theme = createTheme(themeOptions);

export default theme;