// One custom emoji. Size fixed in CSS in both dimensions — not decoration: without fixed
// width/height the chat feed jerks while images load (same reason chat image sizes are encoded in
// filenames).

import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { EmojiDef, emojiUrl } from './registry';
import { freezeEmojiFrame, frozenFrame } from './freezeFrame';
import { useChatPrefs } from '../Chat/chatPrefs';

interface Props {
  emoji: EmojiDef;
  size: number;
  inline?: boolean;
  // Force animation regardless of the setting — for the pack panel (people inspect the emoji
  // there).
  animate?: boolean;
}

// URL respecting "don't animate". While the frame is being captured show the original: an empty
// slot would flicker more than the animation.
function useEmojiSrc(emoji: EmojiDef, freeze: boolean): string {
  const [frame, setFrame] = useState(() => (freeze ? frozenFrame(emoji.id) : undefined));

  useEffect(() => {
    if (!freeze) { setFrame(undefined); return; }
    const ready = frozenFrame(emoji.id);
    if (ready) { setFrame(ready); return; }
    let alive = true;
    void freezeEmojiFrame(emoji).then((url) => { if (alive && url) setFrame(url); });
    return () => { alive = false; };
  }, [emoji, freeze]);

  return frame || emojiUrl(emoji);
}

export default function EmojiImg({ emoji, size, inline = false, animate = false }: Props) {
  const { freezeEmoji } = useChatPrefs();
  const src = useEmojiSrc(emoji, emoji.animated && freezeEmoji && !animate);
  return (
    <Box
      component="img"
      src={src}
      alt={`:${emoji.name}:`}
      title={`:${emoji.name}:`}
      loading="lazy"
      decoding="async"
      draggable={false}
      sx={{
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
        // display set explicitly in both branches: the global reset makes images block and an
        // inline emoji broke onto its own line.
        ...(inline
          ? { display: 'inline-block', verticalAlign: `${(-0.22 * size).toFixed(1)}px`, mx: '1px' }
          : { display: 'block' }),
      }}
    />
  );
}
