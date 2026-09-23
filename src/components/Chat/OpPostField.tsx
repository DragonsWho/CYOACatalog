// OP field: long text plus up to five positioned images. One component for "create topic" and "edit
// OP" so writing and rewriting use the same field and rules. The OP is a field of the ROOM itself,
// not the first feed message (see shoutbox_community.go header).

import { useRef } from 'react';
import { Box, Stack, TextField } from '@mui/material';
import MarkdownBar from './MarkdownBar';
import OpImageRow, { useOpSlotUrls } from './OpImageRow';
import { OP_TEXT_MAX as SERVER_OP_TEXT_MAX, type OpImageSlot } from './communityApi';

// Cap mirrors the server (shoutCommunityOpMax) and op_text schema. Re-exported, not a second
// literal: two places saying "4000" eventually diverge.
export const OP_TEXT_MAX = SERVER_OP_TEXT_MAX;

type Props = {
  text: string;
  onText: (v: string) => void;
  // Post images IN ORDER: saved ones as filenames, newly picked as File. The list is authoritative:
  // whatever is missing is removed on save.
  images: OpImageSlot[];
  onImages: (next: OpImageSlot[]) => void;
  urlOf?: (name: string) => string | undefined;
  disabled?: boolean;
  autoFocus?: boolean;
};

export default function OpPostField({
  text, onText, images, onImages, urlOf, disabled, autoFocus,
}: Props) {
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const urls = useOpSlotUrls(images, urlOf);

  // Image marker goes at the cursor (same as ThreadComposer.insertToken): "at the end" is exactly
  // what we moved away from.
  const insertToken = (n: number) => {
    const el = areaRef.current;
    const token = `[img${n}]`;
    const at = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? at;
    const before = text.slice(0, at).replace(/\s+$/, '');
    const after = text.slice(end).replace(/^\s+/, '');
    const next = `${before}${before ? '\n\n' : ''}${token}${after ? '\n\n' : ''}${after}`;
    if (next.length > OP_TEXT_MAX) return;
    onText(next);
    requestAnimationFrame(() => {
      const a = areaRef.current;
      if (!a) return;
      const caret = before.length + (before ? 2 : 0) + token.length;
      a.focus();
      a.setSelectionRange(caret, caret);
    });
  };

  return (
    <Stack spacing={1}>
      {/*
        Same markdown bar as the create-topic screen: editing must support exactly what writing
        did.
      */}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
        <Box sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'rgba(255,255,255,0.03)' }}>
          <MarkdownBar areaRef={areaRef} value={text} onChange={onText} max={OP_TEXT_MAX} disabled={disabled} />
        </Box>
        <TextField
          autoFocus={autoFocus}
          size="small"
          label="Opening post (optional)"
          value={text}
          onChange={(e) => onText(e.target.value.slice(0, OP_TEXT_MAX))}
          multiline
          minRows={5}
          maxRows={14}
          disabled={disabled}
          fullWidth
          inputRef={areaRef}
          // Say explicitly that everyone entering sees this, or people write private notes and get
          // a topic header.
          helperText={`${text.trim().length}/${OP_TEXT_MAX} — the topic itself; everyone sees it at the top`}
          sx={{ '& .MuiOutlinedInput-notchedOutline': { border: 0 } }}
        />
      </Box>


      <OpImageRow
        slots={images}
        onSlots={onImages}
        urls={urls}
        onInsert={insertToken}
        hasToken={(n) => new RegExp(`\\[img${n}\\]`).test(text)}
        disabled={disabled}
      />
    </Stack>
  );
}
