// Full history of site announcements — linked from the dismissible homepage
// banner ("See all updates") so old news isn't lost once a banner is closed.

import { useEffect, useState } from 'react';
import { Box, Container, Typography, Paper, CircularProgress } from '@mui/material';
import { Announcement, announcementsCollectionPublic } from '../../pocketbase/pocketbase';

export default function AnnouncementsLog() {
  const [items, setItems] = useState<Announcement[] | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await announcementsCollectionPublic.getFullList({
          sort: '-created',
          fields: 'id,title,body,created',
        });
        if (mounted) setItems(res);
      } catch {
        if (mounted) setItems([]);
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

      {items?.length === 0 && (
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
