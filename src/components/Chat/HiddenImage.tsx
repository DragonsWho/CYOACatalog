import { useState, type MouseEvent } from 'react';
import { Box } from '@mui/material';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import type { SxProps, Theme } from '@mui/material/styles';
import { useChatPrefs } from './chatPrefs';

// Reveals survive a collapsed header/list rerender for the lifetime of the tab.
const revealed = new Set<string>();

type Props = {
  src: string;
  alt?: string;
  revealKey: string;
  sx?: SxProps<Theme>;
  onClick?: () => void;
  loading?: 'lazy' | 'eager';
  // Loads the image but blurs until a deliberate click. For NSFW media in SFW mode; independent of
  // hideImages.
  blurUntilClicked?: boolean;
};

// An image which honours "Hide images until clicked" without even assigning a network URL before
// the reader explicitly reveals it.
export default function HiddenImage({
  src, alt = '', revealKey, sx, onClick, loading = 'lazy', blurUntilClicked = false,
}: Props) {
  const { hideImages } = useChatPrefs();
  const local = src.startsWith('blob:') || src.startsWith('data:');
  const [shown, setShown] = useState(() => revealed.has(revealKey));
  const veiled = hideImages && !local && !shown;
  const blurred = blurUntilClicked && !local && !shown;

  if (veiled) {
    const reveal = (e: MouseEvent<HTMLButtonElement>) => {
      // A thumbnail is often inside a link to its thread. Revealing media must not also navigate
      // away from the list.
      e.preventDefault();
      e.stopPropagation();
      revealed.add(revealKey);
      setShown(true);
    };
    return (
      <Box
        component="button"
        type="button"
        title="Images are hidden — click to show this one"
        aria-label="Show image"
        onClick={reveal}
        sx={[
          {
            border: 1,
            borderColor: 'divider',
            bgcolor: 'rgba(255,255,255,0.035)',
            color: 'text.secondary',
            fontFamily: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            '&:hover': { bgcolor: 'rgba(255,255,255,0.07)', color: 'text.primary' },
          },
          ...(Array.isArray(sx) ? sx : [sx]),
          { display: 'flex', objectFit: undefined },
        ]}
      >
        <ImageOutlinedIcon sx={{ fontSize: 16 }} />
        <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>Show image</Box>
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading={loading}
      title={blurred ? 'NSFW image — click to reveal' : undefined}
      onClick={blurred ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        revealed.add(revealKey);
        setShown(true);
      } : onClick}
      sx={[
        ...(Array.isArray(sx) ? sx : [sx]),
        blurred ? {
          filter: 'blur(7px)',
          transform: 'scale(1.02)',
          cursor: 'pointer',
        } : {},
      ]}
    />
  );
}
