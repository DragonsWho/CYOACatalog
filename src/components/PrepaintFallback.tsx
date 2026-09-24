import { Box, CircularProgress } from '@mui/material';

// Route Suspense fallback. On the first home load React mounts before the lazy HomePage chunk, which
// used to swap the pre-paint (src/prepaint) for a spinner: panel and cards vanished for a moment.
// The pre-paint left its home markup on window; showing it here keeps the frame identical until
// HomePage renders the same seeded cards. Any other route/state: plain spinner.
export default function PrepaintFallback() {
  const pre = (window as unknown as { __PREPAINT__?: { css: string; home: string } }).__PREPAINT__;
  if (pre && window.location.pathname === '/' && !window.location.search) {
    return <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<style>${pre.css}</style>${pre.home}` }} />;
  }
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <CircularProgress />
    </Box>
  );
}
