// Shared catalogue of moderator-request kinds. Mirrors the `kind` select on the
// `mod_requests` collection and the validModKinds map in Go. The "Call a
// moderator" menu offers these (with a tooltip hint), and each seeds the comment
// composer with a guided @moderator template so the user isn't staring at an
// empty box. Keeping the shape stable also helps the future LLM moderator parse
// requests consistently.

export interface ModKindDef {
  kind: string;       // matches mod_requests.kind enum (and Go validModKinds)
  label: string;      // menu label shown to the user
  hint: string;       // tooltip: what to attach/cite so the request is actionable
  // Seed text dropped into the composer. The @moderator mention stays on the
  // first line; a blank line follows so the cursor lands below it.
  seed: string;
}

export const MOD_KINDS: ModKindDef[] = [
  {
    kind: 'dead_link',
    label: 'Dead / broken link',
    hint: 'Paste the correct, working link if you have one.',
    seed: '@moderator – dead or broken link\n\n',
  },
  {
    kind: 'missing_images',
    label: 'Pictures are broken / missing',
    hint: 'If you can, link a copy that still has the images (a Wayback Machine snapshot or other archive), or attach a suitable replacement picture.',
    seed: '@moderator – broken / missing pictures\n\n',
  },
  {
    kind: 'update_version',
    label: 'A newer version exists',
    hint: 'Link to the newer version and where you found it.',
    seed: '@moderator – newer version available\n\n',
  },
  {
    kind: 'wrong_author',
    label: 'Wrong author',
    hint: 'Attach a source link, or quote the credit from inside the game.',
    seed: '@moderator – wrong author\n\n',
  },
  {
    kind: 'change_tag',
    label: 'Wrong or missing tags',
    hint: 'Say which tags to add or remove, and why.',
    seed: '@moderator – tag fix\n\n',
  },
  {
    kind: 'relation',
    label: 'Linked game (DLC / sequel / port / translation)',
    hint: 'Link the other game and say how they relate (DLC, sequel, port, translation…).',
    seed: '@moderator – related game\n\n',
  },
  {
    kind: 'duplicate',
    label: 'Duplicate of another game',
    hint: 'Link the original this duplicates.',
    seed: '@moderator – duplicate\n\n',
  },
  {
    kind: 'illegal',
    label: 'Illegal or rule-breaking content',
    hint: 'Explain exactly what is wrong and where – be specific.',
    seed: '@moderator – illegal / rule-breaking content\n\n',
  },
  {
    kind: 'other',
    label: 'Something else',
    hint: 'Describe the issue in your own words.',
    seed: '@moderator\n\n',
  },
];

export function seedForKind(kind: string | null): string {
  const found = MOD_KINDS.find((k) => k.kind === kind);
  return found ? found.seed : '@moderator\n\n';
}
