// src/utils/fuzzy.ts
//
// Прощающий поиск: нормализация + Левенштейн + резолв синонимов (aliases) +
// «может, вы имели в виду…». Единый источник вместо трёх копий levenshtein в
// компонентах Add/*. Синонимы приходят из поля `aliases` (строки через \n),
// заведённого на games/authors/tags (см. tools/taxonomy_cleanup).

const MAX_DIST = 3;

// Нормализатор для СРАВНЕНИЯ (не для показа): игнорирует регистр, пробелы,
// дефис/подчёркивание/точку, апострофы и reddit-префикс `u/`. Так «LordCYOA»,
// «lord-cyoa», «Lord CYOA» и «u/LordCYOA» схлопываются в один ключ.
export function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/^u\//, '')
    .replace(/[\s\-_.'’`/]+/g, '');
}

// Левенштейн с ранним выходом (перенесён из CustomTagSelector без изменений логики).
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

// normalized(любое написание/синоним) -> каноническое отображаемое имя.
export type AliasIndex = Map<string, string>;

// Строит индекс из записей с полем aliases. Каноническое имя (name) тоже
// индексируется. Первое имя выигрывает при коллизии нормализованных ключей.
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

// aliases хранится как строки через перевод строки (иногда запятые) — режем по обоим.
export function splitAliases(aliases?: string): string[] {
  if (!aliases) return [];
  return aliases
    .split(/[\r\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Резолв ввода в каноническое имя: сначала точное (по нормализованному ключу,
// т.е. включая синонимы), затем ближайший по Левенштейну. null — совпадений нет.
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

// «Может, вы имели в виду…»: ближайшие имена (по нормализованному Левенштейну),
// с дедупом канонических имён. Точное совпадение из выдачи исключается.
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
