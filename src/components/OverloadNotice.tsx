// src/components/OverloadNotice.tsx
// App-wide "the site is busy" snackbar.
//
// The backend caps concurrent API requests (overload.go) and answers 503 to the
// overflow rather than letting them pile up until the droplet swaps itself into
// a coma. Without this component that 503 reaches the user as a silent failure
// or a generic error — a spinner that never resolves. One honest notice with a
// clear "try again in a minute" is the whole point of shedding load.
//
// The event is raised in pocketbase/pocketbase.ts (both the SDK's afterSend and
// authedFetch) and is already rate-limited to one per 30s there.
import { useEffect, useState } from 'react';
import { Snackbar, Alert } from '@mui/material';
import { OVERLOAD_EVENT } from '../pocketbase/pocketbase';

export default function OverloadNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const onOverload = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      setMessage(detail || 'The site is under heavy load. Please try again in a minute.');
    };
    window.addEventListener(OVERLOAD_EVENT, onOverload);
    return () => window.removeEventListener(OVERLOAD_EVENT, onOverload);
  }, []);

  return (
    <Snackbar
      open={message !== null}
      autoHideDuration={8000}
      onClose={() => setMessage(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity="warning"
        variant="filled"
        onClose={() => setMessage(null)}
        sx={{ width: '100%' }}
      >
        {message}
      </Alert>
    </Snackbar>
  );
}
