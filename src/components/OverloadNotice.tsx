// App-wide "site is busy" snackbar. The backend caps concurrent API requests (overload.go) and
// answers 503 to the overflow instead of letting them pile up until the droplet swaps into a coma.
// Without this the 503 is a silent failure or a never-resolving spinner. The event is raised in
// pocketbase/pocketbase.ts (SDK afterSend and authedFetch), rate-limited there to one per 30s.

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
