// Set of tags ACTUALLY used (in at least one visible game), so autocomplete/search suggestions hide
// empty tags (common complaint). Computed server-side into the tag dictionary (utils/tagDictionary).
import { loadTagDictionary } from './tagDictionary';

// Returns Set of used tag ids. On failure → empty Set (callers then don't cut options).
export async function getUsedTagIds(): Promise<Set<string>> {
  try {
    return new Set((await loadTagDictionary()).used);
  } catch (e) {
    console.error('getUsedTagIds failed', e);
    return new Set<string>();
  }
}
