// Catalog state vocabulary: types of the three axes (filter / sort / seed) and reading them from
// the URL. Separate from FeedModeControls because both the catalog page and the header sheet row
// use it, and a module exporting both a component and constants breaks hot reload.

// Three independent axes. `feed` = nothing pressed: activity feed with bumps and updates. The other
// sorts are explicit user choices; once chosen, bumps leave the ordering (they asked about
// something else).
export type SortKey = 'feed' | 'fresh' | 'top' | 'talk';
export type PeriodKey = 'all' | 'week' | 'month' | 'year';
export type FormatKey = 'all' | 'img' | 'link';
// Seed: while active, sort doesn't apply — the order IS the answer.
export type SeedKey = 'none' | 'semantic' | 'random';
export type DirKey = 'desc' | 'asc';

export const PERIOD_SHORT: Record<PeriodKey, string> = {
  all: 'All',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

export const SORT_TIP: Record<Exclude<SortKey, 'feed'>, [string, string]> = {
  fresh: ['Newest in the catalogue — no bumps', 'Oldest in the catalogue'],
  top: ['Most liked', 'Least liked'],
  talk: ['Discussed', 'Least discussed'],
};

// Reads the same URL params as the catalog page.
export const readSeed = (params: URLSearchParams): SeedKey => {
  const sem = params.get('sem') || '';
  if (sem.trim().length >= 2) return 'semantic';
  return params.get('seed') === 'random' ? 'random' : 'none';
};
