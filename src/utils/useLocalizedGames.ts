// CATALOG localization: if the user has pref_lang and a game has `game_variants{language=pref}`,
// swap card title/description so e.g. Korean users see at a glance the game is translated. ONLY
// title/description — never cover/id/link: the variant's cover lives under ITS collectionId+id
// (file-URL trap) and id is needed for links/memo; language variants usually have no cover anyway.
// One anonymous pbPublic query per language (CF-cacheable for everyone), cached in module. Fine
// while variants are few; at hundreds, switch to fetching by visible ids.

import { useEffect, useMemo, useState } from 'react';
import {
  Game,
  GameVariant,
  gameVariantsCollectionPublic,
  VARIANT_FIELDS,
} from '../pocketbase/pocketbase';
import { getPrefLang } from './langPref';

// lang → (canonGameId → variant). Lives for the page session.
const variantCache = new Map<string, Map<string, GameVariant>>();

export function useLocalizedGames(games: Game[]): Game[] {
  const pref = getPrefLang();
  const [variantMap, setVariantMap] = useState<Map<string, GameVariant> | null>(
    () => (pref ? variantCache.get(pref) ?? null : null),
  );

  useEffect(() => {
    if (!pref) {
      setVariantMap(null);
      return;
    }
    const cached = variantCache.get(pref);
    if (cached) {
      setVariantMap(cached);
      return;
    }
    let alive = true;
    gameVariantsCollectionPublic
      .getFullList<GameVariant>({
        filter: `language = "${pref}"`,
        fields: `${VARIANT_FIELDS},game`,
      })
      .then((rows) => {
        const m = new Map<string, GameVariant>();
        for (const r of rows) if (!m.has(r.game)) m.set(r.game, r);
        variantCache.set(pref, m);
        if (alive) setVariantMap(m);
      })
      .catch(() => {
        if (alive) setVariantMap(null);
      });
    return () => {
      alive = false;
    };
  }, [pref]);

  return useMemo(() => {
    if (!pref || !variantMap || variantMap.size === 0) return games;
    let changed = false;
    const out = games.map((g) => {
      const v = variantMap.get(g.id);
      if (!v) return g;
      const title = v.title || g.title;
      // `||` not `??`: an empty string in a variant means "not translated", not "empty description"
      // — `??` once wiped the original.
      const description = v.description || g.description;
      if (title === g.title && description === g.description) return g;
      changed = true;
      return { ...g, title, description };
    });
    return changed ? out : games;
  }, [games, variantMap, pref]);
}
