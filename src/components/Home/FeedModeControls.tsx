// Catalog result settings row: order (feed / new / likes / discussed / random), period, format,
// "only my likes". Separate file because it has TWO placements with one logic: `variant="page"`
// (desktop catalog panel) and `variant="panel"` (header search sheet on phones — the catalog page
// shows no panel on phones, so settings must be in the sheet). Never copy-paste this row: the
// direction-colored carousel is the most fragile part; two copies diverge.
// All state lives in the URL (like the whole catalog page), so no state props or callbacks: it
// reads and writes `useSearchParams` itself — hence live application: the header sheet doesn't
// block the page and the feed rebuilds immediately without "apply".

import { useContext } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Chip,
  Divider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  alpha,
  useTheme,
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import NewReleasesIcon from '@mui/icons-material/NewReleases';
import EmojiEventsIcon from '@mui/icons-material/EmojiEvents';
import CommentIcon from '@mui/icons-material/Comment';
import FavoriteIcon from '@mui/icons-material/Favorite';
import ShuffleIcon from '@mui/icons-material/Shuffle';
import AppsIcon from '@mui/icons-material/Apps';
import ImageIcon from '@mui/icons-material/Image';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

import { AuthContext } from '../../pocketbase/pocketbase';
import { PERIOD_SHORT, SORT_TIP, readSeed } from './feedParams';
import type { DirKey, FormatKey, PeriodKey, SortKey } from './feedParams';

interface Props {
  // `page` = row in the catalog panel (desktop), `panel` = in the header sheet (little space; must
  // wrap).
  variant?: 'page' | 'panel';
  onReroll?: () => void;
  randomLoading?: boolean;
}

export default function FeedModeControls({ variant = 'page', onReroll, randomLoading = false }: Props) {
  const theme = useTheme();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useContext(AuthContext);
  const compact = variant === 'panel';

  const sort = (searchParams.get('sort') as SortKey) || 'feed';
  const dir: DirKey = searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const period = (searchParams.get('period') as PeriodKey) || 'all';
  const format = (searchParams.get('format') as FormatKey) || 'all';
  const liked = searchParams.get('liked') === '1';
  const seed = readSeed(searchParams);

  const patchParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    });
    setSearchParams(next, { replace: true });
  };

  const rollRandom = () => {
    if (randomLoading) return;
    if (seed === 'random') onReroll?.();
    else patchParams({ seed: 'random' });
  };

  const toggleGroupSx: SxProps<Theme> = {
    '& .MuiToggleButton-root': {
      borderRadius: '10px',
      px: compact ? 1.1 : 1.5,
      py: 0.5,
      border: 0,
      color: theme.palette.text.secondary,
      textTransform: 'none',
      bgcolor: alpha(theme.palette.primary.main, 0.05),
      '&.Mui-selected': {
        bgcolor: alpha(theme.palette.primary.main, 0.15),
        color: theme.palette.text.primary,
        fontWeight: 600,
      },
      '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
    },
  };

  // The whole order group is colored: active button green when "more and newer on top", red when
  // reversed — same color language as tags (green "with", red "without"), so no label needed. Color
  // lives on the group (its selector is more specific; per-button sx loses). "Random" is neither
  // red nor green: color only means direction, and random has none.
  const orderTone = seed === 'random'
    ? theme.palette.text.primary
    : dir === 'asc' ? theme.palette.error.main : theme.palette.success.main;
  const orderGroupSx: SxProps<Theme> = {
    ...(toggleGroupSx as object),
    '& .MuiToggleButton-root.Mui-selected': {
      color: orderTone,
      bgcolor: alpha(orderTone, 0.18),
      '&:hover': { bgcolor: alpha(orderTone, 0.26) },
    },
  };

  // In the sheet the row wraps and the vertical divider ends up dangling at line ends — groups are
  // separated by a larger gap there; the divider stays for the wide page row only.
  const divider = compact ? null : (
    <Divider
      orientation="vertical"
      flexItem
      sx={{ height: 24, alignSelf: 'center', display: { xs: 'none', sm: 'block' } }}
    />
  );

  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: compact ? 1.25 : 1,
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
      }}
    >
      {seed !== 'semantic' ? (
        <ToggleButtonGroup
          exclusive
          size="small"
          // `feed` = nothing pressed, so no button is highlighted: the bump feed is the rest state.
          value={seed === 'random' ? 'random' : sort === 'feed' ? null : sort}
          // Carousel: click an INACTIVE button → descending; click the active one → reversed; third
          // → back to rest (`feed`, with bumps). MUI passes null on clicking the active button —
          // that is steps two/three.
          onChange={(_, v: string | null) => {
            if (v === 'random') {
              rollRandom();
              return;
            }
            if (v) {
              patchParams({ sort: v, dir: null, seed: null });
              return;
            }
            if (seed === 'random') {
              rollRandom();
              return;
            }
            if (dir === 'desc') patchParams({ dir: 'asc' });
            else patchParams({ sort: null, dir: null });
          }}
          sx={orderGroupSx}
          aria-label="Order"
        >
          {(['fresh', 'top', 'talk'] as Exclude<SortKey, 'feed'>[]).map((key) => {
            const Icon = key === 'fresh' ? NewReleasesIcon : key === 'top' ? EmojiEventsIcon : CommentIcon;
            const flipped = seed === 'none' && sort === key && dir === 'asc';
            const tip = SORT_TIP[key][flipped ? 1 : 0];
            return (
              <Tooltip key={key} title={tip}>
                <ToggleButton value={key} aria-label={tip}>
                  <Icon fontSize="small" />
                </ToggleButton>
              </Tooltip>
            );
          })}
          {/* Locked only while a roll is loading: the feed's first load used to grey it out (visible blink). */}
          <Tooltip title={seed === 'random' ? "Roll again" : "Random picks within the current filters"}>
            <ToggleButton value="random" selected={seed === 'random'} onChange={rollRandom} disabled={randomLoading && seed === 'random'} aria-label={seed === 'random' ? "Roll again" : "Random picks"}>
              <ShuffleIcon fontSize="small" />
            </ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>
      ) : (
        <Chip
          size="small"
          variant="outlined"
          icon={<LockOutlinedIcon />}
          label="Order: by match"
          onDelete={() => patchParams({ sem: null })}
          sx={{ borderRadius: 2 }}
        />
      )}

      {divider}

      {/* Period is a real filter, not a "Top" suffix: applies to any sort and any seed. */}
      <ToggleButtonGroup
        exclusive
        size="small"
        value={period}
        onChange={(_, v: PeriodKey | null) => v && patchParams({ period: v === 'all' ? null : v })}
        sx={toggleGroupSx}
        aria-label="Period"
      >
        {/*
          No week: too few games in 7 days, the slice is almost always empty. Minimum meaningful
          period is a month.
        */}
        <ToggleButton value="month">{PERIOD_SHORT.month}</ToggleButton>
        <ToggleButton value="year">{PERIOD_SHORT.year}</ToggleButton>
        <ToggleButton value="all">{PERIOD_SHORT.all}</ToggleButton>
      </ToggleButtonGroup>

      {divider}

      <ToggleButtonGroup
        exclusive
        size="small"
        value={format}
        onChange={(_, v: FormatKey | null) => v && patchParams({ format: v === 'all' ? null : v })}
        sx={toggleGroupSx}
        aria-label="Format"
      >
        <ToggleButton value="all" aria-label="All formats">
          <Tooltip title="All formats"><AppsIcon fontSize="small" /></Tooltip>
        </ToggleButton>
        <ToggleButton value="img" aria-label="Static">
          <Tooltip title="Static"><ImageIcon fontSize="small" /></Tooltip>
        </ToggleButton>
        <ToggleButton value="link" aria-label="Interactive">
          <Tooltip title="Interactive"><TouchAppIcon fontSize="small" /></Tooltip>
        </ToggleButton>
      </ToggleButtonGroup>

      {user && (
        <Tooltip title="Only what I liked">
          {/*
            A standalone ToggleButton outside a group depends on MUI onChange subtleties — use
            plain onClick for predictable behavior.
          */}
          <ToggleButton
            value="liked"
            size="small"
            selected={liked}
            onClick={() => patchParams({ liked: liked ? null : '1' })}
            sx={{
              borderRadius: '10px',
              px: compact ? 1.1 : 1.5,
              py: 0.5,
              border: 0,
              color: theme.palette.text.secondary,
              bgcolor: alpha(theme.palette.primary.main, 0.05),
              '&.Mui-selected': {
                color: theme.palette.error.main,
                bgcolor: alpha(theme.palette.error.main, 0.16),
                '&:hover': { bgcolor: alpha(theme.palette.error.main, 0.24) },
              },
              '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
            }}
            aria-label="My likes"
          >
            <FavoriteIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
      )}
    </Box>
  );
}
