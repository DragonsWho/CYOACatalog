// Markdown bar above the composer (bold, italic, strike, code, spoiler, quote, color). The chat
// markup is custom (richText.tsx) and undocumented — nobody discovers `||spoiler||` unless shown.
// Each button inserts exactly what the parser understands, so buttons can't diverge from rendering.
// No "link" button on purpose: the parser doesn't know `[text](url)`; it auto-links bare https://…
// — the button would teach syntax that renders as brackets.
// Works over a plain textarea: edits go out via onChange and we restore the selection ourselves,
// else the cursor jumps to the end after each button.

import { useRef, useState } from 'react';
import { Box, Popover, Tooltip } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import FormatStrikethroughIcon from '@mui/icons-material/FormatStrikethrough';
import CodeIcon from '@mui/icons-material/Code';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import { TEXT_COLORS } from '../Shoutbox/richText';

type Props = {
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (v: string) => void;
  // Length cap: a button must not push the text past it.
  max?: number;
  disabled?: boolean;
};

const BTN_SX = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 26,
  border: 0,
  borderRadius: 1,
  bgcolor: 'transparent',
  color: 'text.secondary',
  cursor: 'pointer',
  p: 0,
  '&:hover': { bgcolor: 'rgba(255,255,255,0.08)', color: 'text.primary' },
  '&:disabled': { opacity: 0.4, cursor: 'default' },
} as const;

export default function MarkdownBar({ areaRef, value, onChange, max, disabled }: Props) {
  const [colorAnchor, setColorAnchor] = useState<HTMLElement | null>(null);
  const lastSel = useRef<[number, number]>([0, 0]);

  // Selection captured at press time: the color popover steals focus, and by pick time
  // selectionStart means nothing.
  const grabSel = (): [number, number] => {
    const el = areaRef.current;
    if (!el) return lastSel.current;
    const sel: [number, number] = [el.selectionStart ?? value.length, el.selectionEnd ?? value.length];
    lastSel.current = sel;
    return sel;
  };

  const put = (next: string, caret: number, caretEnd: number) => {
    if (max && next.length > max) return;
    onChange(next);
    // Set selection AFTER React re-renders the new value: before that the DOM has the old text and
    // the range lands wrong.
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caretEnd);
    });
  };

  // No selection → insert markers around a placeholder word and select it, so the user types over
  // it.
  const wrap = (open: string, close: string, hint: string) => {
    const [start, end] = grabSel();
    const picked = value.slice(start, end);
    const inner = picked || hint;
    const next = `${value.slice(0, start)}${open}${inner}${close}${value.slice(end)}`;
    const from = start + open.length;
    put(next, from, from + inner.length);
  };

  // Quote is a per-line marker: "> " at the start of each touched line; pressing again removes it.
  const quote = () => {
    const [start, end] = grabSel();
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const toRaw = value.indexOf('\n', end);
    const to = toRaw < 0 ? value.length : toRaw;
    const block = value.slice(from, to) || '';
    const lines = block.split('\n');
    const on = lines.every((l) => l.startsWith('> ') || l === '>');
    const fixed = lines
      .map((l) => (on ? l.replace(/^> ?/, '') : `> ${l}`))
      .join('\n');
    const next = value.slice(0, from) + fixed + value.slice(to);
    put(next, from, from + fixed.length);
  };

  const color = (name: string) => {
    setColorAnchor(null);
    const [start, end] = lastSel.current;
    const picked = value.slice(start, end);
    const inner = picked || 'text';
    const open = `[c=${name}]`;
    const next = `${value.slice(0, start)}${open}${inner}[/c]${value.slice(end)}`;
    const from = start + open.length;
    put(next, from, from + inner.length);
  };

  const btn = (
    key: string,
    title: string,
    icon: React.ReactNode,
    onClick: () => void,
  ) => (
    <Tooltip key={key} title={title} disableInteractive>
      <Box
        component="button"
        type="button"
        disabled={disabled}
        // onMouseDown, not onClick: otherwise the press first clears the field selection and
        // there's nothing to wrap.
        onMouseDown={(e: React.MouseEvent) => { e.preventDefault(); onClick(); }}
        aria-label={title}
        sx={BTN_SX}
      >
        {icon}
      </Box>
    </Tooltip>
  );

  return (
    <Box sx={{
      display: 'flex',
      alignItems: 'center',
      gap: 0.25,
      // No wrap: on narrow screens it went to a second line and the sheet jumped in height.
      // Horizontal scroll instead.
      flexWrap: 'nowrap',
      overflowX: 'auto',
      px: 0.5,
      py: 0.25,
      scrollbarWidth: 'none',
      '&::-webkit-scrollbar': { display: 'none' },
    }}>
      {btn('b', 'Bold  **text**', <FormatBoldIcon sx={{ fontSize: 17 }} />, () => wrap('**', '**', 'bold'))}
      {btn('i', 'Italic  *text*', <FormatItalicIcon sx={{ fontSize: 17 }} />, () => wrap('*', '*', 'italic'))}
      {btn('s', 'Strikethrough  ~~text~~', <FormatStrikethroughIcon sx={{ fontSize: 17 }} />, () => wrap('~~', '~~', 'text'))}
      {btn('c', 'Code  `text`', <CodeIcon sx={{ fontSize: 17 }} />, () => wrap('`', '`', 'code'))}
      {btn('sp', 'Spoiler  ||text||', <VisibilityOffOutlinedIcon sx={{ fontSize: 16 }} />, () => wrap('||', '||', 'spoiler'))}
      {btn('q', 'Quote  > text', <FormatQuoteIcon sx={{ fontSize: 17 }} />, quote)}

      <Box sx={{ width: '1px', height: 16, bgcolor: 'divider', mx: 0.25, flexShrink: 0 }} />

      <Tooltip title="Colour  [c=red]text[/c]" disableInteractive>
        <Box
          component="button"
          type="button"
          disabled={disabled}
          aria-label="Colour"
          onMouseDown={(e: React.MouseEvent<HTMLElement>) => {
            e.preventDefault();
            grabSel();
            setColorAnchor(e.currentTarget);
          }}
          sx={BTN_SX}
        >
          <PaletteOutlinedIcon sx={{ fontSize: 16 }} />
        </Box>
      </Tooltip>

      <Popover
        open={Boolean(colorAnchor)}
        anchorEl={colorAnchor}
        onClose={() => setColorAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 0.75, borderRadius: 2 } } }}
      >
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 24px)', gap: 0.5 }}>
          {TEXT_COLORS.map((c) => (
            <Tooltip key={c.name} title={c.name} disableInteractive>
              <Box
                component="button"
                type="button"
                aria-label={c.name}
                onClick={() => color(c.name)}
                sx={{
                  width: 24,
                  height: 24,
                  border: 1,
                  borderColor: 'rgba(255,255,255,0.2)',
                  borderRadius: '50%',
                  bgcolor: c.hex,
                  cursor: 'pointer',
                  p: 0,
                  '&:hover': { transform: 'scale(1.12)' },
                }}
              />
            </Tooltip>
          ))}
        </Box>
      </Popover>
    </Box>
  );
}
