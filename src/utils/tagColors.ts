// Shared tag colouring for the compact, category-coloured chips used on the catalog
// cards (GameCard) and the mobile resting view on the game page (TagDisplay).
// Single source of truth — keep both call sites importing from here.

export const CATEGORY_COLORS: Record<string, string> = {
  Rating: 'rgba(0, 0, 0, 0.4)',
  Interactivity: 'rgba(0, 0, 0, 0.4)',
  POV: 'rgba(0, 0, 0, 0.4)',
  'Player Sexual Role': 'rgba(0, 0, 0, 0.4)',
  Playtime: 'rgba(255, 140, 0, 0.4)',
  Status: 'rgba(0, 0, 0, 0.4)',
  Genre: 'rgba(138, 43, 226, 0.4)',
  Setting: 'rgba(0, 0, 0, 0.4)',
  Tone: 'rgba(0, 0, 0, 0.4)',
  Extra: 'rgba(0, 0, 0, 0.4)',
  Kinks: 'rgba(194, 24, 91, 0.6)',
  'Visual Style': 'rgba(0, 0, 0, 0.4)',
  'Custom': 'rgba(96, 125, 139, 0.5)',
};

export const TAG_SPECIFIC_COLORS: Record<string, Record<string, string>> = {
  Rating: {
    'SFW': 'rgba(46, 125, 50, 0.6)',
    'Ecchi': 'rgba(255, 143, 0, 0.6)',
    'NSFW': 'rgba(211, 47, 47, 0.6)',
    'Extreme': 'rgba(172, 0, 0, 0.7)',
  },
  Interactivity: {
    'Static': 'rgba(84, 110, 122, 0.6)',
    'Interactive': 'rgba(243, 179, 62, 0.6)',
    'Interactive Port': 'rgba(243, 179, 62, 0.6)',
    'Interactive Other': 'rgba(123, 31, 162, 0.6)',
  },
};

// Resolve a chip's background colour: tag-specific override first, then the category
// default, then a neutral fallback.
export function getTagColor(category: string | undefined, tagName: string): string {
  const cat = category ?? '';
  return (
    TAG_SPECIFIC_COLORS[cat]?.[tagName] ??
    CATEGORY_COLORS[cat] ??
    'rgba(0, 0, 0, 0.5)'
  );
}

// Gold outline drawn over a category-coloured chip to flag a defining ("gold") tag.
// Distinct from the grey-background gold used by the interactive voting TagChip.
export const GOLD_ACCENT = '#ffd54f';
