// src/utils/useLocalizedGames.ts
//
// Локализация КАТАЛОГА: если у пользователя выбран язык (pref_lang) и для игры есть
// `game_variants{language=pref}`, подменяем на карточке заголовок и описание на
// локализованные — чтобы кореец сразу видел по корейским описаниям, что игра переведена.
//
// Подменяем ТОЛЬКО title/description. Обложку/id/ссылку НЕ трогаем: файл обложки
// варианта живёт под его collectionId+id (file-URL-капкан), а id нужен ссылке и memo.
// У языковых вариантов обложки обычно нет → и так фолбэк на канон.
//
// Один запрос на язык (`language="ko"`, анонимный pbPublic → кэшируется Cloudflare
// одинаково для всех), результат кэшируется в модуле. Масштаб: пока вариантов единицы;
// если станет сотни — перейти на выборку по видимым id.

import { useEffect, useMemo, useState } from 'react';
import {
  Game,
  GameVariant,
  gameVariantsCollectionPublic,
  VARIANT_FIELDS,
} from '../pocketbase/pocketbase';
import { getPrefLang } from './langPref';

// lang → (canonGameId → variant). Живёт на время сессии страницы.
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
      const description = v.description ?? g.description;
      if (title === g.title && description === g.description) return g;
      changed = true;
      return { ...g, title, description };
    });
    return changed ? out : games;
  }, [games, variantMap, pref]);
}
