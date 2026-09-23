// Full announcements history (linked from the banner's "See all updates").

import { useEffect, useState } from 'react';
import { Box, Container, Typography, Paper, CircularProgress } from '@mui/material';
import { Announcement, announcementsCollectionPublic } from '../../pocketbase/pocketbase';

export default function AnnouncementsLog() {
  const [items, setItems] = useState<Announcement[] | null>(null);
  // Separate from items: [] is a legitimate "no announcements"; without this flag a Cloudflare
  // timeout/502 rendered the same "Nothing here yet.".
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await announcementsCollectionPublic.getFullList({
          sort: '-created',
          fields: 'id,title,body,created',
        });
        if (mounted) {
          setItems(res);
          setLoadFailed(false);
        }
      } catch {
        if (mounted) {
          setItems([]);
          setLoadFailed(true);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <Container maxWidth="sm" sx={{ py: 4 }}>
      <Typography variant="h5" sx={{ mb: 3, fontWeight: 700 }}>
        Updates
      </Typography>

      {items === null && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      )}

      {loadFailed && (
        <Typography variant="body2" color="error">
          Couldn't load updates. Please try again later.
        </Typography>
      )}

      {!loadFailed && items?.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing here yet.
        </Typography>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {items?.map((a) => (
          <Paper key={a.id} elevation={0} sx={{ p: 2, borderRadius: '10px' }}>
            <Typography variant="caption" color="text.secondary">
              {new Date(a.created).toLocaleDateString()}
            </Typography>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mt: 0.5 }}>
              {a.title}
            </Typography>
            {a.body && (
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                {a.body}
              </Typography>
            )}
          </Paper>
        ))}
      </Box>
    </Container>
  );
}
