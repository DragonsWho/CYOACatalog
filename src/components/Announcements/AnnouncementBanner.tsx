// Thin dismissible strip on the homepage announcing the latest site update.
// Shows the single newest `announcements` record; dismissing it stores its id
// in localStorage so it stays hidden until a *newer* announcement is posted.

import { useEffect, useState } from 'react';
import { Box, IconButton, Typography, Link as MuiLink } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { Link as RouterLink } from 'react-router-dom';
import { Announcement, announcementsCollectionPublic } from '../../pocketbase/pocketbase';

const DISMISSED_KEY = 'dismissed_announcement_id';

export default function AnnouncementBanner() {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await announcementsCollectionPublic.getList(1, 1, {
          sort: '-created',
          fields: 'id,title,body',
        });
        const latest = res.items[0] ?? null;
        if (mounted && latest && localStorage.getItem(DISMISSED_KEY) !== latest.id) {
          setAnnouncement(latest);
        }
      } catch {
        // No collection yet / offline — banner just doesn't show.
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
      {/* Close button pinned top-right so the title can center across the full width. */}
      <IconButton
        size="small"
        onClick={handleDismiss}
        aria-label="Dismiss announcement"
        sx={{ position: 'absolute', top: 4, right: 4 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>

      {/* Title on its own line, centered. Padded so long titles don't collide with the ✕. */}
      <Typography
        variant="subtitle2"
        sx={{ px: 4, textAlign: 'center', fontWeight: 700, color: 'text.primary' }}
      >
        {announcement.title}
      </Typography>

      {/* Row 2: body across the full width, centered, honoring manual line breaks. */}
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
