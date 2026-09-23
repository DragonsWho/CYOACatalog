// Language/version switcher on the game page (multilang hybrid model). Pills by the title: click
// swaps content in place and stores a global preference (langPref + GameDetails).
// Likes/comments/tags are shared on the canonical record. See
// wiki/components/multilang-variants-spec.md.

import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material';
import TranslateIcon from '@mui/icons-material/Translate';

export interface LangOption {
  key: string;  // language code (ISO 639-1)
  label: string;  // native name for the pill
}

interface LanguageSwitcherProps {
  options: LangOption[];
  activeKey: string;
  onSelect: (key: string) => void;
}

export default function LanguageSwitcher({
  options,
  activeKey,
  onSelect,
}: LanguageSwitcherProps): JSX.Element | null {
  if (options.length < 2) return null;

  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0.75, mb: 1 }}>
      <TranslateIcon fontSize="small" sx={{ color: 'text.secondary' }} />
      <ToggleButtonGroup
        size="small"
        exclusive
        value={activeKey}
        onChange={(_, v) => { if (v) onSelect(v); }}
        aria-label="Game language"
      >
        {options.map((o) => (
          <ToggleButton
            key={o.key}
            value={o.key}
            sx={{ textTransform: 'none', py: 0.25, px: 1.25, lineHeight: 1.3 }}
          >
            {o.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  );
}
