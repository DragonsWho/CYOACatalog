// Forgiving search: normalization + Levenshtein + synonym (aliases) resolution + "did you mean".
// Single source replacing three levenshtein copies in Add/*. Synonyms come from `aliases`
// (newline-separated) on games/authors/tags (see tools/taxonomy_cleanup).

const MAX_DIST = 3;

// Normalizer for COMPARISON (not display): ignores case, spaces, -_., apostrophes and reddit `u/`
// prefix, so "LordCYOA", "lord-cyoa", "Lord CYOA", "u/LordCYOA" share one key.
export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/^u\//, '')
    .replace(/[\s\-_.'’`/]+/g, '');
}

export function levenshtein(a: string, b: string, maxDistance: number = MAX_DIST): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    let minInRow = Infinity;
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
      minInRow = Math.min(minInRow, matrix[i][j]);
    }
    if (minInRow > maxDistance) return Infinity;
  }
  return matrix[b.length][a.length];
}

export interface AliasRecord {
  name: string;
  aliases?: string;
}

// normalized(any spelling/synonym) → canonical display name.
export type AliasIndex = Map<string, string>;

// Index from records with aliases; canonical name indexed too. First name wins on normalized-key
// collision.
export function buildAliasIndex(records: AliasRecord[]): AliasIndex {
  const idx: AliasIndex = new Map();
  for (const r of records) {
    if (!r?.name) continue;
    const canon = r.name;
    const put = (raw: string) => {
      const k = normalize(raw);
      if (k && !idx.has(k)) idx.set(k, canon);
    };
    put(canon);
    for (const a of splitAliases(r.aliases)) put(a);
  }
  return idx;
}

// aliases are newline-separated (sometimes commas) — split on both. (NOT for game titles: see
// utils/aliases.ts.)
export function splitAliases(aliases?: string): string[] {
  if (!aliases) return [];
  return aliases
    .split(/[\r\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Resolve input to canonical name: exact (normalized key, incl. synonyms), then nearest by
// Levenshtein. null = no match.
export function resolveAlias(input: string, idx: AliasIndex, maxDistance: number = 2): string | null {
  const key = normalize(input);
  if (!key) return null;
  const exact = idx.get(key);
  if (exact) return exact;

  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const [k, canon] of idx) {
    const d = levenshtein(key, k, maxDistance);
    if (d < bestDist) {
      bestDist = d;
      best = canon;
      if (d === 0) break;
    }
  }
  return bestDist <= maxDistance ? best : null;
}

export interface Suggestion {
  name: string;
  distance: number;
}

// "Did you mean": nearest names by normalized Levenshtein, deduped by canonical name; exact match
// excluded.
export function findSimilar(
  input: string,
  names: string[],
  maxDistance: number = MAX_DIST,
  maxResults: number = 3,
): Suggestion[] {
  const key = normalize(input);
  if (!key) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const name of names) {
    const d = levenshtein(key, normalize(name), maxDistance);
    if (d > 0 && d <= maxDistance && !seen.has(name)) {
      seen.add(name);
      out.push({ name, distance: d });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, maxResults);
}
