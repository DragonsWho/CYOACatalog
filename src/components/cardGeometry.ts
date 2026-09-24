// Card geometry, tag order and badge rules shared by GameCard (React) and the pre-React pre-paint
// (src/prepaint). Dependency-free on purpose: the pre-paint is inlined into index.html and must not
// pull React/MUI/PocketBase. Change the card here and both follow.

export const CARD_ASPECT_RATIO = '133.33%';
// Cloudflare resize widths for the card cover; the browser picks the smallest ≥ slot width × DPR.
// Capped at 480: a card is never wider than a full-width phone (~412px), and dense screenshot AVIFs
// explode at higher widths (240=15KB, 480=55KB, 720=135KB). List length doesn't inflate the CF
// quota; only widths actually requested do (~3–4 buckets). Desktop 5-up slot ≈ 235px → 240w.
export const CARD_IMG_WIDTHS = [240, 360, 480];
// Lower quality than the detail page: the card cover is a background under a 50% dark overlay +
// blurred panels, AVIF artifacts are invisible. q50 trims ~25% vs the detail page's q70.
export const CARD_IMG_QUALITY = 50;
// Plain `src` fallback, a member of the list above so it doesn't create an extra transformation
// variant.
export const CARD_IMG_WIDTH = 480;
// Real rendered card width per breakpoint incl. gaps (a hair under measured so the browser rounds
// down): 5 cols lg ≈ 17vw, 3 md ≈ 31vw, 2 sm ≈ 47vw, 1 xs ≈ 96vw. MUI breakpoints: sm 600 / md 900
// / lg 1200 (GameGrid.tsx).
export const CARD_IMG_SIZES = '(max-width: 600px) 96vw, (max-width: 900px) 47vw, (max-width: 1200px) 31vw, 17vw';
export const TAG_DISPLAY_LIMIT = 20;
export const OVERLAY_OPACITY = 0.5;

// Sizes inside the card follow TWO different laws — don't mix them (burned twice).
// 1) GEOMETRY (where description/tags/caption boxes sit) follows the CARD: percentages of height
// (height is locked to width via CARD_ASPECT_RATIO). The first version used px per window
// breakpoint and the author caption sat 4px from the edge on phones vs 16px on desktop.
// 2) TEXT SIZE follows the SCREEN, not the card. Trap: window breakpoint and card width are
// INVERSELY related (`xs` = one full-width column = the LARGEST card, 342×456 on phone vs 266×355
// in 5-col desktop), so `xs` had the smallest fonts. But scaling by card width (cqw) gives "a
// desktop card under a magnifier" (37px title, five words per line). Readability is per screen: on
// phones text must be SMALLER than desktop though the card is larger. So fonts per breakpoint,
// stretched by vw within a breakpoint (half the coefficient on sm: the card is half the window).
export const CARD_PAD = { xs: 'clamp(10px, 3vw, 16px)', sm: 'clamp(10px, 1.5vw, 16px)', md: '16px' };
export const CARD_TITLE_FONT = { xs: 'clamp(1.25rem, 6vw, 1.9rem)', sm: 'clamp(1.25rem, 3vw, 1.9rem)', md: '1.8rem' };
export const CARD_TEXT_FONT = { xs: 'clamp(0.82rem, 3.6vw, 1.05rem)', sm: 'clamp(0.82rem, 1.8vw, 1.05rem)', md: '1rem' };
export const CARD_META_FONT = { xs: 'clamp(0.78rem, 3.4vw, 1rem)', sm: 'clamp(0.78rem, 1.7vw, 1rem)', md: '0.9rem' };
export const CARD_META_ICON = { xs: 'clamp(0.85rem, 3.7vw, 1.05rem)', sm: 'clamp(0.85rem, 1.85vw, 1.05rem)', md: '1rem' };
export const CARD_CHIP_FONT = { xs: 'clamp(0.7rem, 3vw, 0.85rem)', sm: 'clamp(0.7rem, 1.5vw, 0.85rem)', md: '0.8125rem' };
export const CARD_CHIP_HEIGHT = { xs: 'clamp(20px, 5.6vw, 26px)', sm: 'clamp(20px, 2.8vw, 26px)', md: '24px' };
export const TAG_SECTION_HEIGHT = { xs: 'clamp(44px, 12.5vw, 58px)', sm: 'clamp(44px, 6.25vw, 58px)', md: '54px' };
export const TITLE_MARGIN_BOTTOM = { xs: '6px', md: '8px' };
// Bottom offsets hold TEXT (tag row, author caption), so they use the font's unit per breakpoint:
// xs/sm fonts scale by vw ⇒ offsets in % of card height; md fonts are fixed px ⇒ offsets in px.
// Percentages on desktop were a bug: computed from the 5-col card 266×355, at 3 columns (~479×638)
// 27.6% becomes 176px instead of 98px — description shrinks to three lines and the caption drifts
// twice as far from the bottom.
export const DESC_BOX_TOP = { xs: '48%', md: '60%' };
export const DESC_BOX_BOTTOM = { xs: '20.5%', md: '98px' };
export const TAG_BOX_BOTTOM = { xs: '8.3%', md: '38px' };
export const META_BOX_BOTTOM = { xs: '2.6%', md: '16px' };

// Tag chips shown on a card: category order, gold tags first within their category, capped.
export const CATEGORY_ORDER = [
  'Rating', 'Interactivity', 'POV', 'Player Sexual Role', 'Playtime',
  'Status', 'Genre', 'Setting', 'Tone', 'Extra', 'Kinks',
  'Visual Style', 'Custom',
];

export interface CardTag {
  id: string;
  name: string;
}

export function sortCardTags<T extends CardTag>(
  tags: T[],
  categoryOf: (id: string) => string | undefined,
  gold: string[] | undefined,
): T[] {
  const valid = tags.filter((t) => t?.id && categoryOf(t.id) !== undefined);
  const goldSet = new Set(gold ?? []);
  return CATEGORY_ORDER.flatMap((cat) => {
    const inCat = valid.filter((t) => categoryOf(t.id) === cat);
    return [...inCat.filter((t) => goldSet.has(t.id)), ...inCat.filter((t) => !goldSet.has(t.id))];
  }).slice(0, TAG_DISPLAY_LIMIT);
}

// Fresh-release pin and "Fresh" badge live N days from created.
export const PINNED_ORIGINAL_DAYS = 5;

export function isFreshOriginal(game: { original_release?: boolean; created?: string }): boolean {
  if (!game.original_release || !game.created) return false;
  const createdMs = new Date(game.created).getTime();
  if (Number.isNaN(createdMs)) return false;
  return Date.now() - createdMs <= PINNED_ORIGINAL_DAYS * 24 * 60 * 60 * 1000;
}

// "Bump!" = card recently won bump roulette (bump_roulette.go sets bumped_at=now()). bumped_at is
// seeded = created and moves only on a real bump, so "bumped_at noticeably later than created"
// suffices — no bump_draws/bump_votes lookup.
export const BUMP_FRESH_DAYS = 7;
const BUMP_VS_CREATED_SLACK_MS = 60 * 1000;  // guards against millisecond jitter at seeding

export function isFreshBump(game: { bumped_at?: string; created?: string }): boolean {
  if (!game.bumped_at || !game.created) return false;
  const bumpedMs = new Date(game.bumped_at).getTime();
  const createdMs = new Date(game.created).getTime();
  if (Number.isNaN(bumpedMs) || Number.isNaN(createdMs)) return false;
  if (bumpedMs - createdMs <= BUMP_VS_CREATED_SLACK_MS) return false;
  return Date.now() - bumpedMs <= BUMP_FRESH_DAYS * 24 * 60 * 60 * 1000;
}
