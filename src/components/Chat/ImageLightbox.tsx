// Full-screen chat image (click preview opens, click/Esc closes). Previews used to be links to a
// new tab — on phones that left chat and lost the feed position. MUI Dialog, not a custom layer: it
// handles Esc, focus trap/return and scroll lock.

import { useEffect, useState } from 'react';
import { Box, Dialog, IconButton } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { ShoutMessage, localImageUrl, messageImageUrl } from '../Shoutbox/shoutboxApi';

type Props = {
  m: ShoutMessage | null;
  onClose: () => void;
};

export default function ImageLightbox({ m, onClose }: Props) {
  // The full image is much heavier; the thumbnail is already cached — show it stretched, full image
  // fades in over it.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [m?.id]);

  const full = (m && (localImageUrl(m.id) || messageImageUrl(m))) || undefined;
  const thumb = (m && messageImageUrl(m, '360x0')) || undefined;

  return (
    <Dialog
      open={Boolean(m && full)}
      onClose={onClose}
      fullScreen
      slotProps={{
        paper: { sx: { bgcolor: 'transparent', boxShadow: 'none', position: 'relative', overflow: 'hidden' } },
        backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.9)' } },
      }}
    >
      <Box
        onClick={onClose}
        sx={{
          position: 'absolute', inset: 0, p: { xs: 1, sm: 3 },
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'zoom-out',
        }}
      >
        {thumb && !ready && (
          <Box
            component="img"
            src={thumb}
            alt=""
            sx={{
              maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
              // Stretched thumbnail is a placeholder: blur honestly says "not it yet".
              filter: 'blur(8px)', transform: 'scale(1.02)',
            }}
          />
        )}
        <Box
          component="img"
          src={full}
          alt=""
          onLoad={() => setReady(true)}
          sx={{
            maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
            // Full image sits invisible over the placeholder until loaded: nothing jumps at the
            // swap.
            position: ready ? 'static' : 'absolute',
            opacity: ready ? 1 : 0,
            transition: 'opacity 120ms ease-out',
          }}
        />
      </Box>

      {/* Buttons over the image: clicks must not close the dialog. */}
      <IconButton
        onClick={onClose}
        aria-label="Close"
        sx={{ position: 'absolute', top: 8, right: 8, color: 'common.white', bgcolor: 'rgba(0,0,0,0.4)' }}
      >
        <CloseIcon />
      </IconButton>
      {full && (
        <IconButton
          component="a"
          href={full}
          target="_blank"
          rel="noreferrer"
          aria-label="Open the original in a new tab"
          sx={{ position: 'absolute', top: 8, right: 56, color: 'common.white', bgcolor: 'rgba(0,0,0,0.4)' }}
        >
          <OpenInNewIcon />
        </IconButton>
      )}
    </Dialog>
  );
}
