// Topic OP as rendered: text with images IN PLACE (images used to be one, always at the end — wrong
// for "here's a collection" topics). Image positions are marked `[img1]`…`[img5]` by NUMBER, not
// filename (filenames change on re-upload). Parsing in splitOpText, incl. "unmarked images are
// appended at the end" so uploads never vanish. One component for the topic header and the
// create-topic preview: the preview must be the same code or it starts lying on the second edit.

import { Box } from '@mui/material';
import { renderRichText } from '../Shoutbox/richText';
import { EMOJI_SIZE } from '../Emoji/registry';
import { splitOpText, type OpChunk } from './communityApi';
import HiddenImage from './HiddenImage';

// Image URL plus known dimensions (from the filename, see imageNameSize) to reserve space BEFORE
// load, or text jumps after reading began.
export type OpImageView = { url: string; w?: number; h?: number };

type Props = {
  text: string;
  images: OpImageView[];
  maxWidth?: number | string;
  onImageClick?: (i: number) => void;
  blurImages?: boolean;
};

export default function OpBody({ text, images, maxWidth = 420, onImageClick, blurImages = false }: Props) {
  const chunks: OpChunk[] = splitOpText(text, images.length);

  return (
    <>
      {chunks.map((c, i) => {
        if ('text' in c) {
          return (
            // whiteSpace here, not on the wrapper: images sit as blocks between chunks and newlines
            // within text must survive.
            <Box key={`t${i}`} sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {renderRichText(c.text, { emojiSize: EMOJI_SIZE.inline })}
            </Box>
          );
        }
        const img = images[c.img];
        if (!img) return null;
        return (
          <HiddenImage
            key={`i${c.img}`}
            src={img.url}
            revealKey={`op:${img.url}`}
            alt=""
            loading="lazy"
            blurUntilClicked={blurImages}
            onClick={onImageClick ? () => onImageClick(c.img) : undefined}
            sx={{
              display: 'block',
              my: 0.75,
              borderRadius: 1,
              cursor: onImageClick ? 'zoom-in' : 'default',
              maxWidth: { xs: '100%', sm: maxWidth },
              ...(img.w && img.h
                ? { width: `min(100%, ${img.w}px)`, aspectRatio: `${img.w} / ${img.h}` }
                : {}),
            }}
          />
        );
      })}
    </>
  );
}
