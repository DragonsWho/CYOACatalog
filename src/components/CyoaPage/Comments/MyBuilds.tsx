// The viewer's PRIVATE builds for this game, pinned above the comment wall.
// Public builds live in the wall itself (as red-framed comments); private ones
// exist only as `builds` records, visible to their owner alone — this strip is
// the one place they render. From here a build can be loaded into the game,
// published into the thread, or deleted.
import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import BuildCard from './BuildCard';
import { Build } from '../../../pocketbase/pocketbase';
import { deleteBuild, publishBuild } from './buildsApi';

const ACCENT = '#d25353';

export default function MyBuilds({
  builds,
  onChanged,
}: {
  builds: Build[];
  onChanged: () => void; // refetch thread + strip after publish/delete
}) {
  const priv = builds.filter((b) => !b.public);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (priv.length === 0) return null;

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  };

  const actionSx = {
    minWidth: 0,
    py: 0,
    px: 0.75,
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'none',
    color: 'text.secondary',
    '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
  } as const;

  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography sx={{ fontWeight: 700, fontSize: '0.9rem', color: 'text.primary' }}>
          My private builds
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          only you can see these
        </Typography>
      </Stack>
      {error && (
        <Typography variant="caption" sx={{ color: 'error.main' }}>
          {error}
        </Typography>
      )}
      {priv.map((b) => (
        <Box key={b.id}>
          <BuildCard build={{ code: b.code, summary: b.summary }} loadable mine />
          <Stack direction="row" spacing={1} sx={{ mt: -0.5, mb: 1, ml: 0.5 }}>
            <Button
              size="small"
              disabled={busyId === b.id}
              onClick={() => void run(b.id, () => publishBuild(b))}
              sx={{ ...actionSx, color: ACCENT, '&:hover': { color: ACCENT, bgcolor: 'rgba(210,83,83,0.08)' } }}
            >
              Post publicly
            </Button>
            {confirmId === b.id ? (
              <>
                <Button
                  size="small"
                  disabled={busyId === b.id}
                  onClick={() => void run(b.id, () => deleteBuild(b))}
                  sx={{ ...actionSx, color: 'error.main', '&:hover': { color: 'error.main', bgcolor: 'transparent' } }}
                >
                  Confirm delete
                </Button>
                <Button size="small" onClick={() => setConfirmId(null)} sx={actionSx}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="small" onClick={() => setConfirmId(b.id)} sx={actionSx}>
                Delete
              </Button>
            )}
          </Stack>
        </Box>
      ))}
    </Box>
  );
}
