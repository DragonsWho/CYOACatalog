// Click-to-reveal spoiler pill. Blurred and dimmed until clicked; once revealed
// it stays open. Used for Reddit-style >!spoiler!< runs (hidden endings, builds).

import { useState, type ReactNode } from 'react';
import { Box } from '@mui/material';

export default function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <Box
      component="span"
      role="button"
      tabIndex={0}
      aria-label={revealed ? 'Spoiler' : 'Reveal spoiler'}
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setRevealed(true);
        }
      }}
      sx={{
        cursor: revealed ? 'auto' : 'pointer',
        borderRadius: '4px',
        px: 0.5,
        whiteSpace: 'pre-wrap',
        transition: 'filter 120ms, background-color 120ms, color 120ms',
        ...(revealed
          ? { bgcolor: 'rgba(255,255,255,0.06)' }
          : {
              bgcolor: 'rgba(255,255,255,0.12)',
              color: 'transparent',
              filter: 'blur(4px)',
              userSelect: 'none',
            }),
      }}
    >
      {children}
    </Box>
  );
}
