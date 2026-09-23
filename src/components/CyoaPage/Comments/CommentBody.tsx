// Renders comment markdown safely. react-markdown does NOT parse raw HTML (no rehype-raw), so
// `<script>` etc. show as literal text. Reddit-like subset
// (bold/italic/strike/links/lists/quotes/code/tables); images explicitly dropped (hotlink abuse).
// remark-gfm: strike, tables, task lists, autolinks; remark-breaks: single newline = line break.

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

// Muted accent for links and @mentions — bright primary is too loud on the dark thread.
const ACCENT = '#d25353';

// Wall-of-text guard: comments taller than ~13 lines start clamped with fade + "expand". Height in
// em of this component's font so it tracks the 0.95rem/1.55 line-height below.
const COLLAPSE_HEIGHT_EM = 13 * 1.55;

const FADE_PX = 48;

const ALLOWED_ELEMENTS = [
  'p', 'br', 'strong', 'em', 'del', 'a', 'ul', 'ol', 'li',
  'blockquote', 'code', 'pre', 'hr', 'span', 'input',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'spoiler', 'mention',
];

// Hoisted so react-markdown gets stable identities. Not about a parse cache (v10 has none,
// re-parses every render) — `components.a`/`spoiler`/`mention` are element TYPES, and fresh inline
// functions make React remount the subtree. This concretely broke Spoiler: its local `revealed`
// state snapped back to hidden whenever the comment re-rendered (e.g. "Show full comment").
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkSpoiler, remarkMention];
const MD_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <Link href={href} target="_blank" rel="noopener noreferrer nofollow" sx={{ color: ACCENT }}>
      {children}
    </Link>
  ),
  // `spoiler` is a custom element from remarkSpoiler — cast the components map to allow the key.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spoiler: ({ children }: any) => <Spoiler>{children}</Spoiler>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mention: ({ children }: any) => (
    <Box component="span" sx={{ color: ACCENT, fontWeight: 500 }}>
      {children}
    </Box>
  ),
} as Components;

export default function CommentBody({ content, loadable, mine }: { content: string; loadable?: boolean; mine?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // A build from the cheat menu rides as a fenced ```cyoa-build block — render it as a card above
  // the author's note. `rest` = remaining markdown.
  const { build, rest } = splitBuildComment(content);

  // scrollHeight reflects full content even with overflow hidden — detects need for fade/toggle
  // without rendering twice.
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
          '& ul': { listStyleType: 'disc' },
          '& ol': { listStyleType: 'decimal' },
          '& ul ul': { listStyleType: 'circle' },
          '& li': { display: 'list-item' },
          '& li > ul, & li > ol': { my: 0 },
          '& h1, & h2, & h3, & h4, & h5, & h6': {
            fontSize: '1rem',
            fontWeight: 700,
            lineHeight: 1.4,
            m: 0,
            mt: 1,
            mb: 0.5,
          },
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
          remarkPlugins={REMARK_PLUGINS}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          components={MD_COMPONENTS}
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
