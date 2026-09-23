import { SxProps, Theme } from '@mui/material/styles';

// Site-wide thin unobtrusive scrollbar. Firefox: overlay style. WebKit: narrow thumb, no
// arrows/track, brighter on container/thumb hover. Spread into sx: sx={{ ...thinScrollbar, ...rest
// }}.
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
