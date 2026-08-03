// Renders comment markdown safely.
//
// react-markdown does NOT parse raw HTML (no rehype-raw plugin), so user input
// cannot inject markup — `<script>` etc. is shown as literal text. We allow a
// Reddit-like subset (bold/italic/strikethrough/links/lists/quotes/code/tables)
// and explicitly drop images to avoid hotlink abuse.
//   - remark-gfm    : strikethrough, tables, task lists, autolinked URLs
//   - remark-breaks : a single newline becomes a line break (Reddit behaviour)

import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Link } from '@mui/material';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkSpoiler, { protectSpoilers } from './remarkSpoiler';
import remarkMention from './remarkMention';
import Spoiler from './Spoiler';
import BuildCard from './BuildCard';
import { splitBuildComment } from './buildComment';

// Muted accent for in-comment links and @mentions — the bright primary blue is
// too loud on the dark thread for this non-critical info.
const ACCENT = '#d25353';

// Wall-of-text guard: comments taller than ~13 lines start clamped with a
// fade-out and an "expand" toggle, so one huge post can't push the whole
// thread off screen. Height is in em (of this component's own font-size)
// so it tracks the 0.95rem/1.55 line-height set below.
const COLLAPSE_HEIGHT_EM = 13 * 1.55;

// The fade covers ~2 text lines (0.95rem * 1.55 line-height ≈ 23.5px each) so
// the clamp reads clearly as "hidden content", not a hard cut.
const FADE_PX = 48;

const ALLOWED_ELEMENTS = [
  'p', 'br', 'strong', 'em', 'del', 'a', 'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'hr', 'span', 'input',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'spoiler', 'mention',
];

export default function CommentBody({ content, loadable, mine }: { content: string; loadable?: boolean; mine?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // A build posted from the cheat menu rides inside the comment as a fenced
  // ```cyoa-build block — pull it out and render it as a card above whatever
  // note (if any) the author typed. `rest` is the remaining markdown text.
  const { build, rest } = splitBuildComment(content);

  // scrollHeight reflects the full unclamped content even while overflow is
  // hidden, so this detects "does this comment need a fade + toggle" without
  // rendering it twice.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [rest]);

  const clamped = overflowing && !expanded;

  return (
    <Box>
      {build && <BuildCard build={build} loadable={loadable} mine={mine} />}
      {rest && (
      <>
      <Box
        ref={contentRef}
        sx={{
          color: 'text.primary',
          fontSize: '0.95rem',
          lineHeight: 1.55,
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          '& p': { m: 0, mb: 1 },
          '& p:last-child': { mb: 0 },
          '& ul, & ol': { my: 0.5, pl: 3 },
          '& a': { color: ACCENT },
          '& blockquote': {
            m: 0,
            my: 1,
            pl: 1.5,
            borderLeft: '3px solid',
            borderColor: 'divider',
            color: 'text.secondary',
          },
          '& code': {
            fontFamily: 'monospace',
            fontSize: '0.85em',
            bgcolor: 'rgba(255,255,255,0.08)',
            px: 0.5,
            py: 0.1,
            borderRadius: '4px',
          },
          '& pre': {
            bgcolor: 'rgba(0,0,0,0.4)',
            p: 1.5,
            borderRadius: '6px',
            overflowX: 'auto',
          },
          '& pre code': { bgcolor: 'transparent', p: 0 },
          '& table': { borderCollapse: 'collapse', my: 1 },
          '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 },
          maxHeight: expanded ? 'none' : `${COLLAPSE_HEIGHT_EM}em`,
          overflow: 'hidden',
          ...(clamped && {
            maskImage: `linear-gradient(to bottom, black calc(100% - ${FADE_PX}px), transparent 100%)`,
            WebkitMaskImage: `linear-gradient(to bottom, black calc(100% - ${FADE_PX}px), transparent 100%)`,
          }),
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks, remarkSpoiler, remarkMention]}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          components={{
            a: ({ href, children }) => (
              <Link href={href} target="_blank" rel="noopener noreferrer nofollow" sx={{ color: ACCENT }}>
                {children}
              </Link>
            ),
            // `spoiler` is a custom element emitted by remarkSpoiler — not a known
            // HTML tag, so the components map is cast to allow the extra key.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            spoiler: ({ children }: any) => <Spoiler>{children}</Spoiler>,
            // `mention` is emitted by remarkMention — a styled @handle.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            mention: ({ children }: any) => (
              <Box component="span" sx={{ color: ACCENT, fontWeight: 500 }}>
                {children}
              </Box>
            ),
          } as Components}
        >
          {protectSpoilers(rest)}
        </ReactMarkdown>
      </Box>
      {overflowing && (
        <Box
          component="button"
          onClick={() => setExpanded((e) => !e)}
          sx={{
            all: 'unset',
            display: 'inline-block',
            mt: 0.5,
            ml: 3,
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'rgba(255,255,255,0.72)',
            '&:hover': { color: 'rgba(255,255,255,0.95)' },
          }}
        >
          {expanded ? '▲ Collapse' : '▼ Show full comment'}
        </Box>
      )}
      </>
      )}
    </Box>
  );
}
