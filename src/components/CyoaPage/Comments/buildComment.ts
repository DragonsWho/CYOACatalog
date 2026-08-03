// A "build" (a player's set of choices in an interactive CYOA) is stored as a
// normal comment so it reuses the whole thread machinery — likes, replies,
// notifications, moderation, pagination — with zero schema changes. The
// structured payload rides inside the comment text as a fenced ```cyoa-build
// block; CommentBody splits it out and renders BuildCard, and the cheat gate
// detects "this user already posted a build here" by the marker below.

export const BUILD_MARKER = 'cyoaBuild'; // also the substring the gate filters on

// A public build is stored as a comment, so its encoded body must fit the
// `comments.content` field's Max length on the PocketBase server. Keep this in
// sync with that schema field: if the body exceeds the server cap the post
// fails with an opaque 500, so we guard client-side and show a clear message
// instead (see encodeBuildCommentChecked in buildsApi.ts).
export const MAX_BUILD_COMMENT_LEN = 30000;

export interface BuildPoint {
  name: string;
  value: number;
}
export interface BuildChoice {
  id: string;
  title: string;
  /** Index into `summary.rows` — the section this card was picked from. */
  r?: number;
}
export interface BuildSummary {
  count: number;
  points?: BuildPoint[];
  /** Section names, one per contributing row, referenced by `BuildChoice.r`. */
  rows?: string[];
  choices?: BuildChoice[];
}
export interface CheatBuild {
  code: string; // comma-separated choice ids — the paste-able "build string"
  summary: BuildSummary;
}

export interface BuildGroup {
  /** Section name; empty when the author left the row untitled. */
  name: string;
  choices: BuildChoice[];
}

/**
 * Group a build's cards by the section they came from, so it reads like a
 * character sheet ("Race: Demon", "Drawbacks: Weak, Short") instead of one long
 * comma list. Groups keep the order the cards appear in, i.e. game order.
 *
 * Builds posted before the shim started sending `rows`/`r` simply collapse into
 * a single unnamed group — same flat list as before, no special-casing needed.
 */
export function groupBuildChoices(summary: BuildSummary): BuildGroup[] {
  const choices = summary.choices ?? [];
  const rows = summary.rows ?? [];
  const groups: BuildGroup[] = [];
  const byRow = new Map<number, BuildGroup>();
  for (const choice of choices) {
    const key = typeof choice.r === 'number' && choice.r >= 0 ? choice.r : -1;
    let group = byRow.get(key);
    if (!group) {
      group = { name: key >= 0 ? rows[key] ?? '' : '', choices: [] };
      byRow.set(key, group);
      groups.push(group);
    }
    group.choices.push(choice);
  }
  return groups;
}

const FENCE_RE = /```cyoa-build\s*\n([\s\S]*?)\n```/;

/** Serialize a build into the fenced block that gets posted as a comment. */
export function encodeBuildComment(build: CheatBuild): string {
  const payload = {
    [BUILD_MARKER]: 1,
    code: build.code,
    summary: build.summary,
  };
  return '```cyoa-build\n' + JSON.stringify(payload) + '\n```';
}

/**
 * Pull a build out of a comment's content. Returns the parsed build (if the
 * fenced block is present and valid) plus the remaining text with the block
 * removed, so CommentBody can render a card + any surrounding note.
 */
export function splitBuildComment(content: string): { build: CheatBuild | null; rest: string } {
  const m = content.match(FENCE_RE);
  if (!m) return { build: null, rest: content };
  let build: CheatBuild | null = null;
  try {
    const data = JSON.parse(m[1]);
    if (data && data[BUILD_MARKER] && typeof data.code === 'string' && data.summary) {
      build = { code: data.code, summary: data.summary };
    }
  } catch {
    /* malformed block: fall back to showing it as plain text */
  }
  if (!build) return { build: null, rest: content };
  const rest = (content.slice(0, m.index) + content.slice(m.index! + m[0].length)).trim();
  return { build, rest };
}
