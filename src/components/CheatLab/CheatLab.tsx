// Hidden page: /cheat-lab
// Host for testing the built-in cheat companion. Loads a hosted game with
// ?__cheat=1 (which makes the Go backend inject cheat_shim.js into that game's
// index.html). All cheat UI is rendered by the shim *inside* the iframe (shadow
// DOM) — floating plates in the CYOA itself, mobile-friendly. This page is just
// a URL box + a full-size iframe. Nothing here touches prod: the injection only
// fires for the flagged URL.
import { useMemo, useState } from 'react';
import { Box, TextField, Button, Typography, Stack } from '@mui/material';
import GameIframeStage from './GameIframeStage';
import { withCheatFlag } from '../../utils/cheat';

export default function CheatLab() {
  const [input, setInput] = useState('');
  const [loadedUrl, setLoadedUrl] = useState('');

  const src = useMemo(() => withCheatFlag(loadedUrl), [loadedUrl]);

  return (
    <Box sx={{ p: 2, height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Typography variant="h5" gutterBottom>
        Cheat Lab{' '}
        <Typography component="span" variant="caption" sx={{ color: '#888' }}>
          (hidden · ICC+2)
        </Typography>
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="https://author.cyoa.cafe/game-slug/"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setLoadedUrl(input.trim())}
        />
        <Button variant="contained" onClick={() => setLoadedUrl(input.trim())}>
          Load
        </Button>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid #333' }}>
        {src ? (
          <GameIframeStage key={src} src={src} title="CYOA cheat lab" />
        ) : (
          <Box sx={{ p: 4, color: '#777' }}>
            Paste a hosted game URL (author.cyoa.cafe/slug) and press Load. Use
            the Fullscreen button (bottom-right) for a real window size; the cheat
            controls (🎲 button) appear inside the game.
          </Box>
        )}
      </Box>
    </Box>
  );
}
