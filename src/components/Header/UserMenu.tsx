// src/components/Header/UserMenu.tsx
import { useState, useContext } from 'react';
import { Button, Menu, MenuItem, Avatar } from '@mui/material';
import { Link, useNavigate } from 'react-router-dom';
import Cookies from 'js-cookie'; // <<< НАШ НОВЫЙ ИМПОРТ
import { pb, User } from '../../pocketbase/pocketbase'; // Убедитесь, что User импортируется, если он нужен для currentUser типа
import { AuthContext } from '../../pocketbase/pocketbase';

export default function UserMenu({ currentUser }: { currentUser: User | null }) {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { isModerator } = useContext(AuthContext);  

  const handleLogout = () => {
    // 1. Очистить сессию PocketBase
    pb.authStore.clear();
    console.log('UserMenu: PocketBase session cleared.');

    // --- НАЧАЛО: SSO Интеграция - Очистка Flarum Cookies ---
    Cookies.remove('flarum_token', { domain: '.cyoa.cafe', path: '/' });
    Cookies.remove('flarum_remember', { domain: '.cyoa.cafe', path: '/' }); // На всякий случай
    console.log('UserMenu: Flarum cookies removed.');
    // --- КОНЕЦ: SSO Интеграция ---

    setAnchorEl(null);
    navigate('/'); // Перенаправляем на главную страницу
  };

  return (
    <>
      <Button
        color="inherit"
        onClick={(e) => setAnchorEl(e.currentTarget)}
        sx={{
          textTransform: 'none', // Чтобы "Account" не было капсом, если не хотите
          // width: '100%', // Возможно, это не нужно, если кнопка в AppBar
          // justifyContent: 'center',
          '& .MuiButton-startIcon': {
            marginRight: '8px',
            // marginLeft: 0, // По умолчанию и так 0
          },
        }}
        startIcon={
          currentUser?.avatar ? ( // Если есть URL аватара у пользователя
            <Avatar 
              src={currentUser.avatar ? pb.getFileUrl(currentUser, currentUser.avatar, { thumb: '50x50' }) : undefined} 
              alt={currentUser.username}
              sx={{ width: 24, height: 24 }}
            />
          ) : ( // Если нет URL аватара, показываем первую букву имени
            <Avatar sx={{ width: 24, height: 24, fontSize: '0.8rem' /* можно настроить размер шрифта */ }}>
              {currentUser?.username?.charAt(0).toUpperCase()}
            </Avatar>
          )
        }
      >
        {/* Можно отображать имя пользователя вместо "Account" */}
        {currentUser?.username || 'Account'} 
      </Button>
      <Menu 
        anchorEl={anchorEl} 
        open={Boolean(anchorEl)} 
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ // Опционально: для лучшего позиционирования меню
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={() => { setAnchorEl(null); navigate('/profile'); }}> {/* Используем navigate для Link-подобного поведения */}
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
        <MenuItem onClick={handleLogout}> {/* Используем новую функцию handleLogout */}
          Logout
        </MenuItem>
      </Menu>
    </>
  );
}