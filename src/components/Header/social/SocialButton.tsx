// src/components/Header/social/SocialButton.tsx
import React from 'react';
import { styled } from '@mui/material/styles';
import { CircularProgress } from '@mui/material';

// 1. Обновляем стилизованную кнопку: добавляем проп fullWidth
const BaseSocialButton = styled('button', {
  // Не передаем fullWidth в DOM-элемент <button>, чтобы React не ругался в консоль
  shouldForwardProp: (prop) => prop !== 'fullWidth',
})<{ fullWidth?: boolean }>(({ fullWidth }) => ({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
  width: '100%',
  // Если fullWidth включен, растягиваем на 100%, иначе ограничиваем 320px
  maxWidth: fullWidth ? '100%' : 320,
  minHeight: 40,
  borderRadius: 4,
  border: '1px solid #3c4043',
  backgroundColor: '#131314',
  color: '#e3e3e3',
  fontSize: 14,
  fontWeight: 500,
  textTransform: 'none',
  cursor: 'pointer',
  transition: 'background-color 0.2s ease, box-shadow 0.2s ease',
  '&:hover': {
    backgroundColor: '#1f1f1f',
    boxShadow: '0px 1px 3px rgba(60, 64, 67, 0.3)',
  },
  '&:focus-visible': {
    outline: '2px solid #8ab4f8',
    outlineOffset: 2,
  },
  '&:disabled': {
    opacity: 0.6,
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
}));

const IconWrapper = styled('span')(() => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
}));

// 2. Добавляем fullWidth в интерфейс пропсов
export interface SocialButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: React.ReactNode;
  loading?: boolean;
  fullWidth?: boolean; // <--- Добавлено
}

export function SocialButton({
  label,
  icon,
  loading = false,
  disabled,
  fullWidth = false, // <--- Значение по умолчанию
  ...props
}: SocialButtonProps) {
  return (
    <BaseSocialButton 
      {...props} 
      disabled={disabled || loading}
      fullWidth={fullWidth} // <--- Передаем в стили
    >
      {loading ? (
        <CircularProgress size={18} sx={{ color: '#e3e3e3' }} />
      ) : (
        <>
          <IconWrapper>{icon}</IconWrapper>
          <span>{label}</span>
        </>
      )}
    </BaseSocialButton>
  );
}

export interface SocialProviderConfig {
  label: string;
  icon: React.ReactNode;
}

const GoogleIcon = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
    <path fill="none" d="M0 0h48v48H0z" />
  </svg>
);

const DiscordIcon = () => (
  <svg 
    viewBox="0 0 127.14 96.36" 
    width="100%" 
    height="100%" 
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'block' }}
  >
    <path
      fill="#5865F2"
      d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.11,77.11,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"
    />
  </svg>
);

const DefaultIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10" stroke="#ffffff" strokeWidth="2" fill="none" />
    <path d="M12 6v6l4 2" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
  </svg>
);

const SOCIAL_PROVIDER_CONFIGS: Record<string, SocialProviderConfig> = {
  google: {
    label: 'Continue with Google',
    icon: <GoogleIcon />,
  },
  discord: {
    label: 'Continue with Discord',
    icon: <DiscordIcon />,
  },
};

const capitalize = (value: string) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

export const getSocialProviderConfig = (provider?: string): SocialProviderConfig => {
  if (!provider) {
    return { label: 'Continue', icon: <DefaultIcon /> };
  }

  const normalized = provider.toLowerCase();
  if (normalized in SOCIAL_PROVIDER_CONFIGS) {
    return SOCIAL_PROVIDER_CONFIGS[normalized];
  }

  return {
    label: `Continue with ${capitalize(normalized)}`,
    icon: <DefaultIcon />,
  };
};