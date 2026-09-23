// Highlights @username mentions in comment markdown: splits text nodes into text + `mention`
// elements. Mirrors the server matcher (main.go `mentionRE`): alphanumerics plus `._-`, 2–30 chars,
// preceded by a non-word char so emails don't light up. Only `text` nodes are touched (inline code
// and link text keep their own nodes).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const MENTION_RE = /(^|[^\w@])@([a-zA-Z0-9._-]{2,30})/g;

function textNode(value: string): Node {
  return { type: 'text', value };
}

function mentionNode(text: string): Node {
  // `emphasis` is a known mdast type (has a hast handler); data.hName overrides the tag to
  // <mention>.
  return { type: 'emphasis', data: { hName: 'mention' }, children: [textNode(text)] };
}

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
      walk(child);  // recurse; freshly built mention nodes are never re-walked
      next.push(child);
    }
  }
  node.children = next;
}

export default function remarkMention() {
  return (tree: Node) => walk(tree);
}
