// Renders a build posted as a comment (fenced ```cyoa-build block extracted by splitBuildComment):
// point totals, chosen cards, compact id string, copy button, and on a real posted comment a "Load"
// button that reproduces the build in the game.

import { useState } from 'react';
import { Box, Chip, Stack, Tooltip, IconButton, Button } from '@mui/material';
import AssignmentTurnedInIcon from '@mui/icons-material/AssignmentTurnedIn';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import type { BuildChoice, CheatBuild } from './buildComment';
import { groupBuildChoices } from './buildComment';
import { requestLoadBuild } from '../../../utils/cheat';

const ACCENT = '#d25353';

// Section cap before "+N more": keeps a 40-section monster from taking over the wall.
const VISIBLE_GROUPS = 8;

// Score chip cap (~one row): some games track 70+ counters.
const VISIBLE_POINTS = 6;

// Multi-pick cards read "Agility ×5" — without the count the line claims a weaker build. Text-field
// cards carry what the player typed (usually a character name the engine substitutes throughout):
// "Name: Origin “Kira”".
function choiceLabel(c: BuildChoice): string {
  const name = c.title || c.id;
  const withCount = c.n && c.n !== 1 ? `${name} ×${c.n}` : name;
  return c.w ? `${withCount} “${c.w}”` : withCount;
}

const linkSx = {
  all: 'unset',
  cursor: 'pointer',
  fontSize: '0.78rem',
  fontWeight: 600,
  color: 'rgba(255,255,255,0.72)',
  '&:hover': { color: 'rgba(255,255,255,0.95)' },
} as const;

// Plain public builds have no frame/background (same weight as a text comment). `mine` adds the red
// brand frame so "my build" is findable. Load/Copy sit inline after the label to keep the row
// compact.
export default function BuildCard({ build, loadable, mine }: { build: CheatBuild; loadable?: boolean; mine?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showAllPoints, setShowAllPoints] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const { summary, code } = build;
  const choices = summary.choices ?? [];
  const points = summary.points ?? [];
  const groups = groupBuildChoices(summary);
  // Card pictures shown as a strip (the at-a-glance part; inline would break the sheet rhythm).
  // Only hosted links are rendered — pre-hosting builds may carry raw data URLs, which we refuse to
  // put in the wall.
  const pictures = choices.filter((c) => c.img && !c.img.startsWith('data:'));
  const visibleGroups = showAll ? groups : groups.slice(0, VISIBLE_GROUPS);
  const visiblePoints = showAllPoints ? points : points.slice(0, VISIBLE_POINTS);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
    }
  };

  return (
    <Box
      sx={{
        my: 1,
        ...(mine && {
          p: 1.25,
          borderRadius: '8px',
          border: '1px solid',
          borderColor: 'rgba(210,83,83,0.45)',
          bgcolor: 'rgba(210,83,83,0.06)',
        }),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: points.length ? 1 : 0 }}>
        <Box sx={{ display: 'flex', color: ACCENT }}><AssignmentTurnedInIcon sx={{ fontSize: 18 }} /></Box>
        <Box component="span" sx={{ fontWeight: 700, fontSize: '0.9rem', color: 'text.primary' }}>
          Build
        </Box>
        <Box component="span" sx={{ fontSize: '0.8rem', color: 'text.secondary' }}>
          · {summary.count} {summary.count === 1 ? 'card' : 'cards'}
        </Box>
        {loadable && code && (
          <Tooltip title="Load this build into the game" arrow>
            <Button
              onClick={() => requestLoadBuild(code)}
              size="small"
              startIcon={<PlayCircleOutlineIcon sx={{ fontSize: 18 }} />}
              sx={{
                minWidth: 0,
                py: 0.15,
                px: 1,
                fontSize: '0.75rem',
                fontWeight: 600,
                textTransform: 'none',
                color: ACCENT,
                '&:hover': { bgcolor: 'rgba(210,83,83,0.12)' },
              }}
            >
              Load
            </Button>
          </Tooltip>
        )}
        {code && (
          <Tooltip title={copied ? 'Copied!' : 'Copy build string'} arrow>
            <IconButton size="small" onClick={copyCode} sx={{ color: copied ? 'success.light' : 'text.secondary' }}>
              {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {pictures.length > 0 && (
        <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.75 }}>
          {pictures.map((c, i) => (
            <Box
              key={i}
              component="img"
              src={c.img}
              alt={c.title || c.id}
              title={c.title || c.id}
              loading="lazy"
              sx={{
                height: 92,
                width: 'auto',
                maxWidth: '100%',
                borderRadius: 1,
                border: '1px solid rgba(255,255,255,0.10)',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          ))}
        </Stack>
      )}

      {points.length > 0 && (
        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
          {visiblePoints.map((p, i) => (
            <Chip
              key={i}
              size="small"
              label={`${p.name}: ${p.value}`}
              sx={{
                bgcolor: 'rgba(255,255,255,0.06)',
                color: 'text.primary',
                fontSize: '0.75rem',
                height: 22,
              }}
            />
          ))}
          {points.length > VISIBLE_POINTS && (
            <Box component="button" onClick={() => setShowAllPoints((s) => !s)} sx={linkSx}>
              {showAllPoints ? '▲ Less' : `▼ ${points.length - VISIBLE_POINTS} more`}
            </Box>
          )}
        </Stack>
      )}

      {choices.length > 0 && (
        <Box sx={{ mt: 1 }}>
          {/*
            Read like a character sheet: one line per section, bold name, picked cards after, game
            order. Legacy builds (no sections) fall into one unnamed group and render as before.
          */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.35 }}>
            {visibleGroups.map((g, i) => (
              <Box key={i} sx={{ fontSize: '0.85rem', lineHeight: 1.45 }}>
                {g.name && (
                  <Box component="span" sx={{ fontWeight: 700, color: 'text.primary', mr: 0.75 }}>
                    {g.name}:
                  </Box>
                )}
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {g.choices.map((c) => choiceLabel(c)).join(', ')}
                </Box>
              </Box>
            ))}
          </Box>

          <Stack direction="row" spacing={1.5} sx={{ mt: 0.75, flexWrap: 'wrap' }}>
            {groups.length > VISIBLE_GROUPS && (
              <Box component="button" onClick={() => setShowAll((s) => !s)} sx={linkSx}>
                {showAll ? '▲ Show less' : `▼ ${groups.length - VISIBLE_GROUPS} more sections`}
              </Box>
            )}
            {code && (
              <Box component="button" onClick={() => setShowCode((s) => !s)} sx={linkSx}>
                {showCode ? '▲ Hide build string' : '▼ Build string'}
              </Box>
            )}
          </Stack>

          {showCode && code && (
            <Box
              component="code"
              sx={{
                display: 'block',
                mt: 0.75,
                p: 0.75,
                borderRadius: '4px',
                bgcolor: 'rgba(0,0,0,0.35)',
                color: 'rgba(255,255,255,0.55)',
                fontFamily: 'monospace',
                fontSize: '0.72rem',
                lineHeight: 1.4,
                wordBreak: 'break-all',
                userSelect: 'all',
              }}
            >
              {code}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
