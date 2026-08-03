// Переключатель языка/версии на странице игры (мультиязычность, гибрид-модель).
// Пилюли у заголовка: клик подменяет контент на месте и запоминается как
// глобальная преференция (см. langPref + GameDetails). Лайки/комменты/теги общие
// (живут на каноне), тут не участвуют. См. wiki/components/multilang-variants-spec.md.

import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material';
import TranslateIcon from '@mui/icons-material/Translate';

export interface LangOption {
  key: string;   // код языка (ISO 639-1)
  label: string; // родное название для пилюли
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
  // Одна версия = переключать нечего.
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
