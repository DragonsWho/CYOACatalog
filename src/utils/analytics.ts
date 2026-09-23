// One typed funnel for every custom GA4 event. gtag is set up in index.html (send_page_view:false;
// page_view emitted manually from App.tsx / GameDetails.tsx). Rules: snake_case names/keys (GA4
// convention); every call is fire-and-forget and MUST never throw into the UI — gtag may be blocked
// (ad-blockers, common on an NSFW audience) or not loaded yet (fetched 2s after load); keep params
// low-cardinality where they become custom dimensions (game_id, tab, mode, action). See
// docs/analytics-events.md for dimensions to register in GA4 admin.

type ParamValue = string | number | boolean | undefined;
type Params = Record<string, ParamValue>;

function track(event: string, params?: Params): void {
  try {
    window.gtag?.('event', event, params);
  } catch {
  // analytics must never break the app
  }
}

export const analytics = {
  search: (p: { source: 'header' | 'catalog'; has_query: boolean; tag_count: number; author_count: number }) =>
    track('search', p),
  semanticSearch: (p: { source: 'page' | 'catalog'; query_len: number }) =>
    track('semantic_search', p),
  tabSwitch: (tab: string) => track('tab_switch', { tab }),
  filterToggle: (mode: string) => track('filter_toggle', { mode }),

  tagVote: (p: { game_id: string; tag_id: string; action: string }) =>
    track('tag_vote', p),
  gameUpvote: (p: { game_id: string; active: boolean }) =>
    track('game_upvote', p),
  commentPost: (p: { game_id: string; is_reply: boolean }) =>
    track('comment_post', p),
  commentLike: (p: { active: boolean }) => track('comment_like', p),
  cheatBuildSaved: (p: { game_id: string; is_public: boolean }) =>
    track('cheat_build_saved', p),

  gamePlay: (p: { game_id: string; hosted: boolean }) => track('game_play', p),
  // Slice of ENGAGED playtime. Sum `seconds` per game_id in GA/BigQuery for real playtime — fixes
  // "every game shows ~15s", because interaction inside a cross-origin iframe never reaches GA's
  // engagement timer.
  gameHeartbeat: (p: { game_id: string; seconds: number; hosted: boolean }) =>
    track('game_heartbeat', p),
};
