// src/components/AddGame/AddGamePage.tsx
//
// The reworked "Add a game" page. Lives on the hidden /add-next route while in
// testing; replaces /create when approved. Mobile-first: three accordion paths
// (suggest a link / host files / build a card) + a creator-resources strip.

import { lazy, Suspense, useState } from 'react';
import {
  Box, Typography, Accordion, AccordionSummary, AccordionDetails,
  CircularProgress, Paper, Stack, Link, Chip,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LinkIcon from '@mui/icons-material/Link';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import EditNoteIcon from '@mui/icons-material/EditNote';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import SuggestLink from './SuggestLink';
import ManualCreate from './ManualCreate';

const Hosting = lazy(() => import('../Hosting/Hosting'));

type SectionId = 'suggest' | 'host' | 'manual';

const RESOURCES: { title: string; url: string; blurb: React.ReactNode }[] = [
  {
    title: 'ICC+2 – Interactive CYOA Creator',
    url: 'https://hikawasisters.neocities.org/ICCPlus2/',
    blurb: 'Build interactive CYOAs right in your browser. No coding needed – most games in the catalog are made with it.',
  },
  {
    title: 'Brew – static → interactive converter',
    url: 'https://brew.cyoa.cafe/',
    blurb: (
      <>
        Turn a static (image) CYOA into an interactive one, fast.{' '}
        <Link href="https://youtu.be/HKLyF1No9E0" target="_blank" rel="noopener">
          Video walkthrough
        </Link>
        .
      </>
    ),
  },
  {
    title: "Beginner's guide to making CYOAs",
    url: 'https://imgchest.com/p/ej7mkx9qydl',
    blurb: 'Design basics for first-time CYOA makers: structure, balance, layout.',
  },
  {
    title: 'AVIF image compressor',
    url: 'https://avif-cyoa-compressor.neocities.org/',
    blurb: 'Shrink all your images to AVIF in one go – smaller games load faster and fit upload limits.',
  },
];

const Section = ({
  id, expanded, onToggle, icon, title, subtitle, chip, children,
}: {
  id: SectionId;
  expanded: SectionId | null;
  onToggle: (id: SectionId) => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  chip?: string;
  children: React.ReactNode;
}) => (
  <Accordion
    expanded={expanded === id}
    onChange={() => onToggle(id)}
    disableGutters
    sx={{ '&:before': { display: 'none' }, borderRadius: 1, overflow: 'hidden' }}
  >
    <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 64 }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ pr: 1, minWidth: 0 }}>
        <Box sx={{ color: 'primary.main', display: 'flex', flexShrink: 0 }}>{icon}</Box>
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography sx={{ fontWeight: 600 }}>{title}</Typography>
            {chip && <Chip label={chip} size="small" color="primary" sx={{ height: 20 }} />}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        </Box>
      </Stack>
    </AccordionSummary>
    <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
  </Accordion>
);

export default function AddGamePage() {
  const [expanded, setExpanded] = useState<SectionId | null>('suggest');
  const toggle = (id: SectionId) => setExpanded((cur) => (cur === id ? null : id));

  return (
    <Box sx={{ maxWidth: 760, mx: 'auto', width: '100%', px: { xs: 0, sm: 1 } }}>
      <Typography variant="h4" component="h1" sx={{ fontSize: { xs: '1.6rem', sm: '2.1rem' }, mb: 0.5 }}>
        Add a game
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Three ways to get a CYOA into the catalog – pick whichever fits.
      </Typography>

      <Stack spacing={1.5}>
        <Section
          id="suggest"
          expanded={expanded}
          onToggle={toggle}
          icon={<LinkIcon />}
          title="Suggest a link"
          subtitle="Easiest – paste a link to a game you found, we handle the rest."
          chip="new"
        >
          <SuggestLink />
        </Section>

        <Section
          id="host"
          expanded={expanded}
          onToggle={toggle}
          icon={<CloudUploadIcon />}
          title="Host your game files"
          subtitle="Made a game with ICC or similar? Upload a ZIP and get your-name.cyoa.cafe."
        >
          <Suspense
            fallback={
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress />
              </Box>
            }
          >
            <Hosting embedded />
          </Suspense>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Once your game is hosted, add it to the catalog with the form below –
            use your hosting link as the “playable link”.
          </Typography>
        </Section>

        <Section
          id="manual"
          expanded={expanded}
          onToggle={toggle}
          icon={<EditNoteIcon />}
          title="Create a catalog card"
          subtitle="Full control: upload the CYOA as images, or link a playable version."
        >
          <ManualCreate />
        </Section>
      </Stack>

      <Typography variant="h6" sx={{ mt: 4, mb: 0.5 }}>
        Making your own CYOA?
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        Everything you need – free, in your browser:
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
          gap: 1.5,
        }}
      >
        {RESOURCES.map((r) => (
          <Paper
            key={r.url}
            variant="outlined"
            component="a"
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            sx={{
              p: 1.75,
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              transition: 'border-color 0.15s, background-color 0.15s',
              '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
            }}
          >
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {r.title}
              </Typography>
              <OpenInNewIcon sx={{ fontSize: 14, color: 'text.secondary', flexShrink: 0 }} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {r.blurb}
            </Typography>
          </Paper>
        ))}
      </Box>
    </Box>
  );
}
