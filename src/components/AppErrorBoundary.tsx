// Before this, any render throw = blank page. Most common cause is a deploy: `//go:embed dist`
// drops the previous build's chunks and a lazy import in an open tab 404s. Old assets now survive
// restarts (assets_store, initAssetsStore in main.go), so this is a second-level safety net (flaky
// network, CF garbage, tab older than store retention).

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { isChunkLoadError, reloadOnce } from '../utils/appReload';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
  chunk: boolean;
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, chunk: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, chunk: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[AppErrorBoundary]', error, info.componentStack);
    // Chunk load failures are fixed by a reload; reloadOnce prevents loops.
    if (isChunkLoadError(error) && reloadOnce('chunk load failed')) return;
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 2,
          minHeight: '50vh',
          textAlign: 'center',
          px: 2,
        }}
      >
        <Typography variant="h6">
          {this.state.chunk ? 'Could not load the page' : 'Something went wrong'}
        </Typography>
        <Typography variant="body2" sx={{ opacity: 0.7, maxWidth: 420 }}>
          {this.state.chunk
            ? 'The site was probably updated while this tab was open. Please reload.'
            : 'Please reload the page. If it happens again, tell us in the chat.'}
        </Typography>
        <Button variant="contained" onClick={() => location.reload()}>
          Reload page
        </Button>
      </Box>
    );
  }
}
