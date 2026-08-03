// Альт-названия игры (`games.aliases`) — имена, под которыми CYOA знают помимо
// основного: переиздания, переводы названия, кличка из треда, устоявшаяся
// опечатка. Ищутся наравне с title (`title ~ q || aliases ~ q`, см.
// Header/SearchPage), на деталке выводятся приглушённой строкой над тегами.
//
// Хранение: строки через `\n`. Разделитель ТОЛЬКО перевод строки — запятые в
// названиях CYOA обычны («Hero, Villain, Whatever»). Тем же самым и в том же
// порядке это делают normalizeAliases() в site-frontend-backend/game_edits.go
// (правка через диалог на странице игры) и _split_aliases() в
// CYOA Harvester/agent_ops.py (`pipeline.py aliases`, ночные агенты). Три
// реализации должны понимать поле одинаково — правишь одну, правь все.
//
// Внимание: splitAliases() из utils/fuzzy.ts режет ЕЩЁ И по запятым — он про
// синонимы тегов/авторов (короткие термины), к названиям игр не применим.

/** `games.aliases` → список имён: трим, без пустых, дедуп без учёта регистра. */
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

/**
 * Список → строка для записи в поле. `title` (если передан) выкидывается:
 * основное название дублировать в альтернативных незачем — оно и так ищется.
 */
export function normalizeGameAliases(raw?: string, title?: string): string {
  const t = (title || '').trim().toLowerCase();
  return splitGameAliases(raw)
    .filter((a) => !t || a.toLowerCase() !== t)
    .join('\n');
}
