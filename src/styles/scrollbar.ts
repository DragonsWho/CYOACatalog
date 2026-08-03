import { SxProps, Theme } from '@mui/material/styles';

// Единый стиль тонкой ненавязчивой полосы прокрутки по всему сайту.
// Firefox: overlay-стиль. WebKit: узкий бегунок без стрелок/трека,
// подсвечивается ярче при наведении на контейнер и на сам бегунок.
// Раскладывать через spread в sx: sx={{ ...thinScrollbar, ...остальное }}.
export const thinScrollbar: SxProps<Theme> = {
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(255,255,255,0.12) transparent',
  '&::-webkit-scrollbar': { width: 8 },
  '&::-webkit-scrollbar-track': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 8,
    border: '2px solid transparent',
    backgroundClip: 'padding-box',
    transition: 'background-color 0.2s',
  },
  '&:hover::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.18)' },
  '&::-webkit-scrollbar-thumb:hover': { backgroundColor: 'rgba(255,255,255,0.28)' },
};
