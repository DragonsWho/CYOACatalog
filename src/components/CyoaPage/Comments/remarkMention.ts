// Highlights @username mentions in comment markdown.
//
// Walks the parsed mdast and splits any text node containing an @mention into
// plain-text + `mention` element nodes, so the user can see the system picked
// the handle up. We mirror the server's matcher (main.go `mentionRE`): a handle
// is alphanumerics plus `._-`, 2–30 chars, and must be preceded by a non-word
// character so embedded addresses (e.g. an email's local@domain) don't light up.
//
// Only `text` nodes are touched — inline code keeps its own node type and links
// already carry their own text, so neither is mangled here.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9._-]{2,30})/g;

function textNode(value: string): Node {
  return { type: 'text', value };
}

function mentionNode(text: string): Node {
  // `emphasis` is a known mdast type (so it has a hast handler); data.hName
  // overrides the emitted tag, giving us a <mention> element to style.
  return { type: 'emphasis', data: { hName: 'mention' }, children: [textNode(text)] };
}

/** Split a text value into alternating text and mention nodes. */
function splitMentions(value: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(value)) !== null) {
    const lead = m[1];
    const before = value.slice(last, m.index) + lead;
    if (before) out.push(textNode(before));
    out.push(mentionNode('@' + m[2]));
    last = MENTION_RE.lastIndex;
  }
  if (last < value.length) out.push(textNode(value.slice(last)));
  return out.length ? out : [textNode(value)];
}

function walk(node: Node): void {
  if (!node || !Array.isArray(node.children)) return;
  const next: Node[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('@')) {
      next.push(...splitMentions(child.value));
    } else {
      walk(child); // recurse; freshly built mention nodes are never re-walked
      next.push(child);
    }
  }
  node.children = next;
}

/** remark plugin: wrap @mention tokens in `mention` elements. */
export default function remarkMention() {
  return (tree: Node) => walk(tree);
}
