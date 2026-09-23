// A "build" (a player's choices in an interactive CYOA) is stored as a normal comment to reuse the
// whole thread machinery (likes, replies, notifications, moderation, pagination) with zero schema
// changes. The payload rides as a fenced ```cyoa-build block; CommentBody renders BuildCard; the
// legacy cheat gate detects "already posted a build" by the marker below.

export const BUILD_MARKER = 'cyoaBuild';  // also the substring the gate filters on

// A public build is a comment, so its encoded body must fit `comments.content` max length on the PB
// server. Keep in sync with the schema: exceeding it fails with an opaque 500, so we guard
// client-side (encodeBuildCommentChecked in buildsApi.ts).
export const MAX_BUILD_COMMENT_LEN = 30000;

export interface BuildPoint {
  name: string;
  value: number;
}
export interface BuildChoice {
  id: string;
  title: string;
  r?: number;
  // Multi-pick count when > 1. Absent on ordinary cards and on builds saved before the shim
  // reported it — treat as optional.
  n?: number;
  // Text the player typed into the card (usually the character name, substituted by the engine
  // throughout) — the build's proper noun.
  w?: string;
  // Card picture as a URL on our server. In the game it's a base64 data URL; the host swaps it for
  // a link before saving (buildImagesApi.ts) because one image alone would exceed
  // MAX_BUILD_COMMENT_LEN.
  img?: string;
  // Roll replay data: which card ids the roll picked (`rnd`) and resulting point values
  // `scoreIndex:value` (`rs`), so a loaded build shows the same roll instead of re-rolling. Not
  // rendered.
  rnd?: string[];
  rs?: string[];
}
export interface BuildSummary {
  count: number;
  points?: BuildPoint[];
  rows?: string[];
  choices?: BuildChoice[];
}
export interface CheatBuild {
  code: string;  // comma-separated choice ids — the paste-able "build string"
  summary: BuildSummary;
}

export interface BuildGroup {
  name: string;
  choices: BuildChoice[];
}

// Group cards by section like a character sheet ("Race: Demon", "Drawbacks: Weak, Short"), game
// order. Builds before `rows`/`r` existed collapse into one unnamed group — same flat list as
// before.
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

export function encodeBuildComment(build: CheatBuild): string {
  const payload = {
    [BUILD_MARKER]: 1,
    code: build.code,
    summary: build.summary,
  };
  return '```cyoa-build\n' + JSON.stringify(payload) + '\n```';
}

// Returns the parsed build (if the fenced block is valid) plus remaining text.
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
  // malformed block: fall back to plain text
  }
  if (!build) return { build: null, rest: content };
  const rest = (content.slice(0, m.index) + content.slice(m.index! + m[0].length)).trim();
  return { build, rest };
}
