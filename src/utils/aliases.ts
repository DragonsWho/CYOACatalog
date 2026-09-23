// Game alt titles (`games.aliases`): reissues, translated titles, thread nicknames, established
// typos. Searched alongside title (`title ~ q || aliases ~ q`, Header/SearchPage); shown muted
// above tags on the detail page. Stored newline-separated. ONLY newline is a separator — commas are
// common in CYOA titles ("Hero, Villain, Whatever"). Same parsing in the same order in:
// normalizeAliases() in game_edits.go, inline normalization in POST /api/pipeline/review/{id}/meta
// (pb_hooks/pipeline_review.pb.js), and _split_aliases() in CYOA Harvester/agent_ops.py. All four
// must agree — change one, change all. NOTE: splitAliases() in utils/fuzzy.ts ALSO splits on commas
// — that's for tag/author synonyms, not game titles.

// `games.aliases` → names: trimmed, non-empty, case-insensitive dedup.
export function splitGameAliases(raw?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of (raw || '').replace(/\r\n/g, '\n').split('\n')) {
    const v = line.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

// List → field string. `title` (if given) is dropped: no point duplicating the main title, it's
// searched anyway.
export function normalizeGameAliases(raw?: string, title?: string): string {
  const t = (title || '').trim().toLowerCase();
  return splitGameAliases(raw)
    .filter((a) => !t || a.toLowerCase() !== t)
    .join('\n');
}
