// Shared card metadata editor (title / aliases / authors / tags). The same fields live in TWO
// tables: `games` (published catalog, via /api/custom/games/:id/edit; each edit = a reversible
// game_revisions record) and `game_pipeline_state` (pipeline "kitchen", via
// /api/pipeline/review/:id/meta). The component knows no transport: it hands a patch to an adapter
// (adapters.ts).

import { Author } from '../../pocketbase/pocketbase';
import { normalizeGameAliases } from '../../utils/aliases';

export type GameMetaField = 'title' | 'aliases' | 'authors' | 'tags';

// Authors need only id+name, so trimmed queue objects and full `authors` records both fit.
export type AuthorRef = Pick<Author, 'id' | 'name'>;
export type TagRef = { id: string; name: string };

export interface GameMetaValue {
  title: string;
  // Aliases one per line (separator ONLY
  // , see utils/aliases.ts).
  aliases: string;
  authors: AuthorRef[];
  tags: TagRef[];
}

export interface GameMetaAdapter {
  // patch contains only fields that actually changed.
  save(patch: Partial<GameMetaValue>): Promise<void>;
  // Storage capability gate: e.g. `aliases` isn't in the queue schema; published card tags live in
  // voting, not here.
  supports(field: GameMetaField): boolean;
}

export function emptyGameMeta(): GameMetaValue {
  return { title: '', aliases: '', authors: [], tags: [] };
}

function idsKey(list: Array<{ id: string }>): string {
  return list
    .map((x) => x.id)
    .slice()
    .sort()
    .join(',');
}

// Diff by visible fields. Aliases compared NORMALIZED — else a stray newline goes to the server as
// an "edit" and creates an empty revision. Lists compared as sets: the backend doesn't treat
// relation order as a change.
export function gameMetaPatch(
  base: GameMetaValue,
  next: GameMetaValue,
  fields: GameMetaField[],
): Partial<GameMetaValue> {
  const patch: Partial<GameMetaValue> = {};
  const has = (f: GameMetaField) => fields.includes(f);

  if (has('title') && next.title.trim() !== base.title.trim()) {
    patch.title = next.title.trim();
  }
  if (has('aliases')) {
    const a = normalizeGameAliases(next.aliases, next.title);
    if (a !== normalizeGameAliases(base.aliases, base.title)) patch.aliases = a;
  }
  if (has('authors') && idsKey(next.authors) !== idsKey(base.authors)) {
    patch.authors = next.authors;
  }
  if (has('tags') && idsKey(next.tags) !== idsKey(base.tags)) {
    patch.tags = next.tags;
  }
  return patch;
}
