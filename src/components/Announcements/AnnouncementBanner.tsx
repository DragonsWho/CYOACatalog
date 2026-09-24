// Dismissible homepage strip for the newest `announcements` record; dismissal stores its id in
// localStorage until a newer one is posted.

import { useEffect, useState } from 'react';
import { Box, IconButton, Typography, Link as MuiLink } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { Link as RouterLink } from 'react-router-dom';
import { Announcement, announcementsCollectionPublic } from '../../pocketbase/pocketbase';

const DISMISSED_KEY = 'dismissed_announcement_id';

// Go inlines the newest announcement into the catalog HTML (main.go buildCatalogScriptTag) so the
// banner is there on first paint instead of pushing the grid down when a request returns.
function inlineAnnouncement(): Announcement | null {
  const a = (window as unknown as { __ANNOUNCEMENT__?: Announcement | null }).__ANNOUNCEMENT__;
  try {
    return a && localStorage.getItem(DISMISSED_KEY) !== a.id ? a : null;
  } catch {
    return a ?? null;
  }
}

export default function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(inlineAnnouncement);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await announcementsCollectionPublic.getList(1, 1, {
          sort: '-created',
          fields: 'id,title,body',
        });
        const latest = res.items[0] ?? null;
        if (!mounted) return;
        setAnnouncement(latest && localStorage.getItem(DISMISSED_KEY) !== latest.id ? latest : null);
      } catch {
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!announcement) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISSED_KEY, announcement.id);
    setAnnouncement(null);
  };

  return (
    <Box
      sx={{
        position: 'relative',
        px: { xs: 1.25, sm: 2 },
        py: 1,
        mb: 2,
        border: '1px solid',
        borderColor: 'primary.main',
        borderRadius: '10px',
        backgroundColor: (theme) => `${theme.palette.primary.main}14`,
      }}
    >
      <IconButton
        size="small"
        onClick={handleDismiss}
        aria-label="Dismiss announcement"
        sx={{ position: 'absolute', top: 4, right: 4 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>

      <Typography
        variant="subtitle2"
        sx={{ px: 4, textAlign: 'center', fontWeight: 700, color: 'text.primary' }}
      >
        {announcement.title}
      </Typography>

      <Typography
        variant="body2"
        sx={{ mt: 0.5, textAlign: 'center', color: 'text.primary', whiteSpace: 'pre-line' }}
      >
        {announcement.body ? `${announcement.body}\n` : ''}
        <MuiLink component={RouterLink} to="/log" underline="hover" sx={{ whiteSpace: 'nowrap' }}>
          See all updates
        </MuiLink>
      </Typography>
    </Box>
  );
}
