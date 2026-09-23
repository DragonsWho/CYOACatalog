// Author and tag registries for the shared editor. Every screen used to fetch the full author list
// itself (Add, ModeratorPanel) and the review panel loaded the tag name map separately — hundreds
// of records per open. Now one module cache per tab: the first call loads, others reuse the
// promise.

import { useEffect, useState } from 'react';
import { Author, authorsCollection, tagsCollection } from '../../pocketbase/pocketbase';

let authorsCache: Promise<Author[]> | null = null;
const authorSubs = new Set<(a: Author[]) => void>();

function loadAuthors(): Promise<Author[]> {
  if (!authorsCache) {
    // Only id→name resolution is needed (AuthorSelector); `description` and `games` (long for
    // prolific authors) are never read from this cache.
    authorsCache = authorsCollection.getFullList({ sort: '+name', fields: 'id,name' }).catch((err) => {
      authorsCache = null;  // don't stick on a failed load
      throw err;
    });
  }
  return authorsCache;
}

// Author list + setter for a just-created author (AuthorSelector creates on the fly). The setter
// updates the cache and all mounted instances, or a second card on the same screen wouldn't see the
// new author.
export function useAuthorsCatalog(enabled = true) {
  const [authors, setAuthors] = useState<Author[]>([]);
  // Without this, a network failure (timeout, CF 502) left authors == [] forever, indistinguishable
  // from "no authors".
  const [error, setError] = useState(false);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    setError(false);
    loadAuthors()
      .then((list) => { if (alive) setAuthors(list); })
      .catch((err) => {
        console.error('Failed to load authors', err);
        if (alive) setError(true);
      });
    const sub = (list: Author[]) => { if (alive) setAuthors(list); };
    authorSubs.add(sub);
    return () => { alive = false; authorSubs.delete(sub); };
  }, [enabled, retryToken]);

  const publish = (list: Author[]) => {
    authorsCache = Promise.resolve(list);
    authorSubs.forEach((fn) => fn(list));
  };

  const retry = () => { authorsCache = null; setRetryToken((t) => t + 1); };

  return { authors, error, retry, setAuthors: publish };
}

let tagNamesCache: Promise<Record<string, string>> | null = null;

function loadTagNames(): Promise<Record<string, string>> {
  if (!tagNamesCache) {
    // Only id and name are used; don't download other tag columns for hundreds of records.
    tagNamesCache = tagsCollection
      .getFullList({ fields: 'id,name' })
      .then((tags) => {
        const map: Record<string, string> = {};
        tags.forEach((t) => { map[t.id] = t.name; });
        return map;
      })
      .catch((err) => {
        tagNamesCache = null;
        throw err;
      });
  }
  return tagNamesCache;
}

// Flat Record return type (not {names,...}) to keep `tagNames[id]` consumers working. id→name for
// all tags: the selector emits ids, chips render names.
export function useTagNames(enabled = true): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    loadTagNames()
      .then((map) => { if (alive) setNames(map); })
      .catch((err) => console.error('Failed to load tag names', err));
    return () => { alive = false; };
  }, [enabled]);
  return names;
}
