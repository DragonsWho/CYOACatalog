// Shared input used for new comments, replies and edits.
// Submit with the button or Ctrl/Cmd+Enter.
//
// A compact formatting toolbar and a live Markdown preview are both hidden by
// default (the design is minimalist) and toggled on demand from the footer row.

import { useEffect, useRef, useState } from 'react';
import { Box, Button, Stack, TextField, ToggleButton, Tooltip, Typography } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import CodeIcon from '@mui/icons-material/Code';
import LinkIcon from '@mui/icons-material/Link';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import TextFieldsIcon from '@mui/icons-material/TextFields';
import CommentBody from './CommentBody';

interface Props {
  onSubmit: (text: string) => Promise<void>;
  onCancel?: () => void;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
}

// A formatting action wraps the current selection in `before`/`after`. If
// nothing is selected, `placeholder` is inserted and left selected so the user
// can type over it.
const TOOLS: { icon: JSX.Element; title: string; before: string; after: string; placeholder: string }[] = [
  { icon: <FormatBoldIcon fontSize="small" />, title: 'Bold', before: '**', after: '**', placeholder: 'bold' },
  { icon: <FormatItalicIcon fontSize="small" />, title: 'Italic', before: '*', after: '*', placeholder: 'italic' },
  { icon: <StrikethroughSIcon fontSize="small" />, title: 'Strikethrough', before: '~~', after: '~~', placeholder: 'text' },
  { icon: <FormatQuoteIcon fontSize="small" />, title: 'Quote', before: '> ', after: '', placeholder: 'quote' },
  { icon: <CodeIcon fontSize="small" />, title: 'Code', before: '`', after: '`', placeholder: 'code' },
  { icon: <LinkIcon fontSize="small" />, title: 'Link', before: '[', after: '](https://)', placeholder: 'text' },
  { icon: <VisibilityOffIcon fontSize="small" />, title: 'Spoiler', before: '>!', after: '!<', placeholder: 'spoiler' },
];

export default function CommentForm({
  onSubmit,
  onCancel,
  initialValue = '',
  placeholder = 'Add a comment…',
  submitLabel = 'Comment',
  autoFocus = false,
}: Props) {
  const [text, setText] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const canSubmit = text.trim().length > 0 && !busy;

  // When autofocused with a seed template (e.g. "@moderator …\n\n" from "Call a
  // moderator"), drop the cursor at the very end so the user types *below* the
  // mention instead of in front of it.
  useEffect(() => {
    if (!autoFocus || !initialValue) return;
    const el = inputRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    // Only on mount — the seed is fixed for this form instance (remounted by key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyTool = (before: string, after: string, ph: string) => {
    const el = inputRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selected = text.slice(start, end) || ph;
    const next = text.slice(0, start) + before + selected + after + text.slice(end);
    setText(next);
    // Restore focus and select the wrapped content for quick overtyping.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText('');
      setShowPreview(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      {showTools && (
        <Stack direction="row" spacing={0.5} sx={{ mb: 0.75, flexWrap: 'wrap' }}>
          {TOOLS.map((t) => (
            <Tooltip key={t.title} title={t.title}>
              <span>
                <Button
                  size="small"
                  onClick={() => applyTool(t.before, t.after, t.placeholder)}
                  disabled={busy}
                  sx={{ minWidth: 32, px: 0.5, color: 'text.secondary' }}
                >
                  {t.icon}
                </Button>
              </span>
            </Tooltip>
          ))}
        </Stack>
      )}

      {showPreview ? (
        <Box
          sx={{
            minHeight: 80,
            p: 1.5,
            borderRadius: '4px',
            border: '1px solid',
            borderColor: 'divider',
            bgcolor: 'rgba(0,0,0,0.25)',
          }}
        >
          {text.trim() ? (
            <CommentBody content={text} />
          ) : (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Nothing to preview yet.
            </Typography>
          )}
        </Box>
      ) : (
        <TextField
          fullWidth
          multiline
          minRows={3}
          maxRows={16}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          disabled={busy}
          inputRef={inputRef}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          inputProps={{ 'data-testid': 'comment-input' }}
          sx={{
            '& .MuiOutlinedInput-root': { bgcolor: 'rgba(0,0,0,0.25)', fontSize: '0.95rem' },
          }}
        />
      )}

      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 1 }}>
        <Tooltip title="Formatting">
          <ToggleButton
            value="tools"
            size="small"
            selected={showTools}
            onChange={() => setShowTools((s) => !s)}
            sx={{ p: 0.5, border: 0, color: 'text.secondary' }}
          >
            <TextFieldsIcon fontSize="small" />
          </ToggleButton>
        </Tooltip>
        <Button
          size="small"
          color="inherit"
          onClick={() => setShowPreview((p) => !p)}
          disabled={busy || (!text.trim() && !showPreview)}
          sx={{ color: 'text.secondary', textTransform: 'none' }}
        >
          {showPreview ? 'Edit' : 'Preview'}
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {onCancel && (
          <Button size="small" color="inherit" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button
          size="small"
          variant="contained"
          onClick={() => void submit()}
          disabled={!canSubmit}
          data-testid="comment-submit"
        >
          {submitLabel}
        </Button>
      </Stack>
      {error && (
        <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}
