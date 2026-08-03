// Tiny decoupled channel: a game-page chip (a tag, or an author name) asks the
// header's search overlay to collect it as a catalog filter. The chips (deep in
// the route tree) and the header live as siblings under <App/>, so a window
// CustomEvent avoids prop drilling / lifting the overlay state. Synchronous dispatch
// keeps it inside the tap gesture.
//
// <Header/> (the unified site header) listens; TagDisplay / GameDetails
// dispatch on tag/author taps.

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

// "Return home" signal: the site is a single-page catalog where every search
// (a tab, tag/author/title filters, semantic query) is just a different STATE of
// the same home view, held inside SearchPage — not the URL. So navigating to "/"
// alone can't reset it (and does nothing at all when already on "/"). The logo
// dispatches this; SearchPage listens and snaps back to the default "New" tab with
// all filters cleared. Decoupled via a window event for the same reason as the
// filter bus above (header and SearchPage are siblings under <App/>).
export const SEARCH_HOME_EVENT = 'cyoa:search-home';

export function requestSearchHome(): void {
  window.dispatchEvent(new Event(SEARCH_HOME_EVENT));
}
