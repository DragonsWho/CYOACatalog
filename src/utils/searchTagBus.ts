// Decoupled channel: a game-page chip (tag or author) asks the header's search overlay to add it as
// a catalog filter. Chips and header are siblings under <App/>, so a window CustomEvent avoids prop
// drilling. Synchronous dispatch keeps it inside the tap gesture. <Header/> listens; TagDisplay /
// GameDetails dispatch.

export const SEARCH_FILTER_EVENT = 'cyoa:search-filter';

export type SearchFilterKind = 'tag' | 'author';

export interface SearchFilterDetail {
  kind: SearchFilterKind;
  value: string;
}

export function requestSearchFilter(kind: SearchFilterKind, value: string): void {
  window.dispatchEvent(
    new CustomEvent<SearchFilterDetail>(SEARCH_FILTER_EVENT, { detail: { kind, value } }),
  );
}

export const requestSearchTag = (tag: string): void => requestSearchFilter('tag', tag);
export const requestSearchAuthor = (name: string): void => requestSearchFilter('author', name);

// "Return home" signal: every search (tab, tag/author/title filters, semantic query) is a STATE of
// the home view held in SearchPage, not the URL, so navigating to "/" can't reset it (and does
// nothing when already there). The logo dispatches; SearchPage resets to default "New" with filters
// cleared.
// "Open the search sheet" signal: on phones the catalog page has no controls of its own — the
// header sheet is the ONLY search surface — so tapping the current-feed line must be able to open
// it.
export const SEARCH_OPEN_EVENT = 'cyoa:search-open';

export function requestSearchOpen(): void {
  window.dispatchEvent(new Event(SEARCH_OPEN_EVENT));
}

export const SEARCH_HOME_EVENT = 'cyoa:search-home';

export function requestSearchHome(): void {
  window.dispatchEvent(new Event(SEARCH_HOME_EVENT));
}
