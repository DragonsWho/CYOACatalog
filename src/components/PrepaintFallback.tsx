import { Box, CircularProgress } from '@mui/material';

// Route Suspense fallback. On the first home load React mounts before the lazy HomePage chunk, which
// used to swap the pre-paint (src/prepaint) for a spinner: panel and cards vanished for a moment.
// The pre-paint left its home markup on window; showing it here keeps the frame identical until
// HomePage renders the same seeded cards (or
// GameDetails the same title/cover). Any other route/state: plain spinner.
export default function PrepaintFallback() {
  const pre = (window as unknown as { __PREPAINT__?: { css: string; home?: string; game?: string } }).__PREPAINT__;
  const { pathname, search } = window.location;
  // The game mock was built for this exact URL only if pre.game is set (prepaint.ts gamePage).
  const html = !pre || search ? '' : pathname === '/' ? pre.home : pathname.startsWith('/game/') ? pre.game : '';
  if (pre && html) {
    return <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<style>${pre.css}</style>${html}` }} />;
  }
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  );
}
