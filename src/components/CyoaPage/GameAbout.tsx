// "About this game" block at the very bottom of the card, after comments. Without it the card has
// almost no text for search engines (cover + a couple of catalog lines). Most games have
// games.rich_description (hook, setting, who you play, how choices work), generated for semantic
// search; shown here it becomes page content Google counts.
// ⚠️ Collapsed by default but the text is ALWAYS in the DOM (Collapse doesn't unmount). Expandable
// content is indexed normally; permanently hidden text (transparent, offscreen) is penalized. Do
// NOT replace with `{open && ...}`.
// Not in the site footer: Google treats footers as boilerplate. The field is hidden in the schema
// (catalog API doesn't send it), so the text comes via /api/custom/games/<id>/about (seo.go). No
// text — no block.

import { useEffect, useState } from 'react';
import { Box, Collapse, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

// Paragraph labels before a colon ("Hook: …", "Setting and premise: …"): short and capitalized, so
// a sentence that merely contains a colon isn't mistaken for one.
const LABEL_RE = /^([A-Z][^:\n]{1,40}):\s+([\s\S]+)$/;

export default function GameAbout({ gameId }: { gameId: string }) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText('');
    setOpen(false);
    fetch(`/api/custom/games/${gameId}/about`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.text === 'string') setText(data.text);
      })
      .catch(() => {
      // Optional block: network failure → card without it.
      });
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  if (!text) return null;

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  return (
    // Pressed against the footer: mb cancels <main>'s bottom margin (App.tsx, mb: 4).
    <Box component="section" sx={{ mt: 4, mb: -3 }} aria-label="About this game">
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <Box
          component="button"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.25,
            background: 'none',
            border: 0,
            p: 0,
            cursor: 'pointer',
            // Muted to match "All games" below: for those who look, not in everyone's face.
            color: theme.palette.text.secondary,
            '&:hover': { color: theme.palette.primary.main },
          }}
        >
          <Typography variant="body2" component="h2" sx={{ color: 'inherit', fontSize: 14 }}>
            About this game
          </Typography>
          <ExpandMoreIcon
            fontSize="small"
            sx={{
              transition: 'transform 0.2s ease',
              transform: open ? 'none' : 'rotate(-90deg)',
            }}
          />
        </Box>
      </Box>
      <Collapse in={open}>
        <Box
          sx={{
            mt: 1,
            pb: 2,
            px: { xs: 0, md: 2 },
            color: theme.palette.text.primary,
            fontSize: { xs: '0.95rem', md: '1rem' },
            '& p': { mb: 1.5, lineHeight: 1.6 },
          }}
        >
          {paragraphs.map((p, i) => {
            const m = LABEL_RE.exec(p);
            return (
              <p key={i}>
                {m ? (
                  <>
                    <strong>{m[1]}:</strong> {m[2]}
                  </>
                ) : (
                  p
                )}
              </p>
            );
          })}
        </Box>
      </Collapse>
    </Box>
  );
}
