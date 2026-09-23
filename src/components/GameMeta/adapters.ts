// Transport for GameMetaEditor. Edits go to different tables depending on whether the game is
// published or still in the pipeline:
// catalogAdapter → POST /api/custom/games/{id}/edit (games + game_revisions)
// pipelineAdapter → POST /api/pipeline/review/{id}/meta (game_pipeline_state)

import { authedFetch, pb } from '../../pocketbase/pocketbase';
import { GameMetaAdapter, GameMetaValue } from './types';

async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.error || data?.message || fallback;
  } catch {
    return fallback;
  }
}

export interface CatalogAdapterOptions {
  // Aliases are a moderator field; hidden from card owners.
  aliases?: boolean;
}

// Published card. Tags NOT included: published games get tags through voting (game_tag_votes); no
// moderator bypass here — author's decision.
export function catalogAdapter(gameId: string, opts: CatalogAdapterOptions = {}): GameMetaAdapter {
  return {
    supports: (f) => (f === 'tags' ? false : f === 'aliases' ? opts.aliases !== false : true),
    async save(patch: Partial<GameMetaValue>) {
      const payload: Record<string, unknown> = {};
      if (patch.title !== undefined) payload.title = patch.title;
      if (patch.aliases !== undefined) payload.aliases = patch.aliases;
      if (patch.authors !== undefined) payload.authors = patch.authors.map((a) => a.id);
      if (Object.keys(payload).length === 0) return;

      const formData = new FormData();
      formData.append('payload', JSON.stringify(payload));
      const res = await authedFetch(`/api/custom/games/${gameId}/edit`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(await extractError(res, `Save failed (${res.status})`));
    },
  };
}

export interface PipelineAdapterCaps {
  // false — `aliases` isn't in the game_pipeline_state schema yet (input hidden).
  aliases?: boolean;
}

export function pipelineAdapter(rowId: string, caps: PipelineAdapterCaps = {}): GameMetaAdapter {
  return {
    supports: (f) => (f === 'aliases' ? caps.aliases !== false : true),
    async save(patch: Partial<GameMetaValue>) {
      const body: Record<string, unknown> = {};
      if (patch.title !== undefined) body.title = patch.title;
      if (patch.aliases !== undefined) body.aliases = patch.aliases;
      if (patch.authors !== undefined) body.authors = patch.authors.map((a) => a.id);
      if (patch.tags !== undefined) body.tags = patch.tags.map((t) => t.id);
      if (Object.keys(body).length === 0) return;
      await pb.send(`/api/pipeline/review/${rowId}/meta`, { method: 'POST', body });
    },
  };
}

export interface QueueRowRef {
  id: string;
  game?: string;
  state?: string;
  has_aliases?: boolean;
}

// A published row is edited via the CATALOG adapter: editing the pipeline "kitchen" after
// publication changes nothing on the site and silently diverges from the card.
export function pickAdapter(row: QueueRowRef): GameMetaAdapter {
  if (row.state === 'published' && row.game) return catalogAdapter(row.game);
  return pipelineAdapter(row.id, { aliases: row.has_aliases !== false });
}
