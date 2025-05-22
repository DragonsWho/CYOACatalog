import React, { useState, useContext } from 'react'; // Добавлен React для FC
import { Button, Menu, MenuItem, Avatar, Box, useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie';
import { pb, User, AuthContext } from '../../pocketbase/pocketbase';

interface UserMenuProps {
  currentUser: User | null;
  isMobile?: boolean;
  isBelow400px?: boolean;
  // buttonBasePadding?: string | number; // Опционально, если нужна внешняя синхронизация padding
}

const UserMenu: React.FC<UserMenuProps> = ({ currentUser, isMobile, isBelow400px }) => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator } = useContext(AuthContext);
  const theme = useTheme();

  const handleLogout = () => {
    pb.authStore.clear();
    Cookies.remove('flarum_token', { domain: '.cyoa.cafe', path: '/' });
    Cookies.remove('flarum_remember', { domain: '.cyoa.cafe', path: '/' });
    setAnchorEl(null);
    navigate('/');
  };

  const userInitial = currentUser?.username?.charAt(0).toUpperCase();
  const userAvatarUrl = currentUser?.avatar ? pb.getFileUrl(currentUser, currentUser.avatar, { thumb: '50x50' }) : undefined;

  // Адаптивные размеры для аватара и отступов кнопки
  const avatarSize = isMobile ? (isBelow400px ? 20 : 22) : 24;
  const buttonPaddingValue = isMobile
    ? (isBelow400px ? '4px' : '5px') // Используем те же значения, что и в Header для иконок
    : '6px'; // Базовый отступ для десктопа (вертикальный)

  return (
    <>
      <Button
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{
          textTransform: 'none',
          minWidth: 'auto',
          padding: isMobile
            ? buttonPaddingValue // Квадратный padding для иконки на мобильных
            : `${buttonPaddingValue} ${theme.spacing(1)}`, // Вертикальный padding как у иконки, горизонтальный больше для текста
          '& .MuiButton-startIcon': {
            // Отступ между иконкой и текстом только на десктопе и если есть текст
            marginRight: (isMobile || !currentUser?.username) ? 0 : theme.spacing(1),
          },
        }}
        startIcon={ // Отображаем иконку, только если есть аватар или инициалы
          (userAvatarUrl || userInitial) ? (
            userAvatarUrl ? (
              <Avatar
                src={userAvatarUrl}
                alt={currentUser?.username || 'User Avatar'}
                sx={{ width: avatarSize, height: avatarSize }}
              />
            ) : (
              <Avatar sx={{ width: avatarSize, height: avatarSize, fontSize: isBelow400px ? '0.7rem' : '0.8rem' }}>
                {userInitial || '?'}
              </Avatar>
            )
          ) : null
        }
      >
        {/* Имя пользователя, отображается только на десктопе (sm и выше) */}
        <Box
          component="span"
          sx={{
            display: { xs: 'none', sm: 'inline' },
            fontSize: '0.875rem', // Стандартный размер текста кнопки
            lineHeight: 1.5,      // Для лучшего вертикального выравнивания с иконкой
          }}
        >
          {currentUser?.username}
        </Box>
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/profile'); }}>
          Profile
        </MenuItem>
        {isModerator && (
          <>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/moderator'); }}>
              Moderator Panel
            </MenuItem>
            <MenuItem onClick={() => { setAnchorEl(null); navigate('/vector-search'); }}>
              Vector Search
            </MenuItem>
          </>
        )}
        <MenuItem onClick={handleLogout}>
          Logout
        </MenuItem>
      </Menu>
    </>
  );
};

export default UserMenu;