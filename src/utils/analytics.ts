// src/utils/analytics.ts
//
// One typed funnel for every custom GA4 event on the site. gtag itself is set up
// in index.html (send_page_view:false; page_view is emitted by hand from
// App.tsx / GameDetails.tsx). This module is ONLY for the extra "what did they
// actually do" events — search, tag votes, likes, comments, real playtime, etc.
//
// Rules:
//   • Event names and param keys are snake_case (GA4 convention).
//   • Every call is fire-and-forget and MUST never throw into the UI — gtag may
//     be blocked (ad-blockers, esp. on an NSFW audience) or not loaded yet
//     (it's fetched 2s after load). track() swallows everything.
//   • Keep params small and low-cardinality where they'll become custom
//     dimensions (game_id, tab, mode, action). See docs/analytics-events.md for
//     the list of custom dimensions to register in the GA4 admin.

type ParamValue = string | number | boolean | undefined;
type Params = Record<string, ParamValue>;

function track(event: string, params?: Params): void {
  try {
    window.gtag?.('event', event, params);
  } catch {
    /* analytics must never break the app */
  }
}

export const analytics = {
  // ── Discovery ────────────────────────────────────────────────────────────
  /** Full catalog search submitted from the header search bar. */
  search: (p: { source: 'header' | 'catalog'; has_query: boolean; tag_count: number; author_count: number }) =>
    track('search', p),
  /** Natural-language semantic search run (dedicated page or the catalog tab). */
  semanticSearch: (p: { source: 'page' | 'catalog'; query_len: number }) =>
    track('semantic_search', p),
  /** Catalog tab changed (recent / top / liked / tags / random / similar / semantic). */
  tabSwitch: (tab: string) => track('tab_switch', { tab }),
  /** SFW / NSFW / All content filter toggled. */
  filterToggle: (mode: string) => track('filter_toggle', { mode }),

  // ── Participation (the silent majority's actual signals) ──────────────────
  /** Tag vote cast on a game (upvote / downvote / clear). */
  tagVote: (p: { game_id: string; tag_id: string; action: string }) =>
    track('tag_vote', p),
  /** Game like (upvote) toggled. `active` = liked after the click. */
  gameUpvote: (p: { game_id: string; active: boolean }) =>
    track('game_upvote', p),
  /** Comment or reply posted. */
  commentPost: (p: { game_id: string; is_reply: boolean }) =>
    track('comment_post', p),
  /** Comment like toggled. `active` = liked after the click. */
  commentLike: (p: { active: boolean }) => track('comment_like', p),
  /** A cheat/saver build was saved from inside a hosted game. */
  cheatBuildSaved: (p: { game_id: string; is_public: boolean }) =>
    track('cheat_build_saved', p),

  // ── Real playtime (Track B — the numbers GA's own timer can't see) ────────
  /** First moment a game view becomes actively played (fires once per view). */
  gamePlay: (p: { game_id: string; hosted: boolean }) => track('game_play', p),
  /**
   * A slice of *engaged* time spent playing a game. Sum `seconds` per game_id in
   * GA/BigQuery to get real playtime — this is what fixes the "every game shows
   * ~15s" problem, because interaction inside a cross-origin iframe never
   * reaches GA's built-in engagement timer.
   */
  gameHeartbeat: (p: { game_id: string; seconds: number; hosted: boolean }) =>
    track('game_heartbeat', p),
};
