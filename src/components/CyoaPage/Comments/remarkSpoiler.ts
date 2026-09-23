// Reddit-style spoilers >!hidden!< (may span lines/builds). A `>` at line start would begin a
// blockquote, so `protectSpoilers` swaps `>!`/`!<` for private-use sentinels BEFORE parsing. The
// plugin then tokenizes sentinels out of text children at each node level and regroups everything
// between matching OPEN/CLOSE (incl. line breaks and nested formatting) into a `spoiler` element.
// Unmatched sentinels are restored to literal `>!`/`!<`.

// Private-use sentinels built via char codes so the source stays pure ASCII.
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

export function protectSpoilers(src: string): string {
  return src.split('>!').join(OPEN).split('!<').join(CLOSE);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;
type Token =
  | { k: 'text'; value: string }
  | { k: 'node'; node: Node }
  | { k: 'open' }
  | { k: 'close' };

function textNode(value: string): Node {
  return { type: 'text', value };
}

function spoilerNode(children: Node[]): Node {
  // `strong` is a known mdast type (has a hast handler); data.hName overrides the tag to <spoiler>.
  return { type: 'strong', data: { hName: 'spoiler' }, children };
}

function tokenizeText(value: string): Token[] {
  const toks: Token[] = [];
  let buf = '';
  for (const ch of value) {
    if (ch === OPEN || ch === CLOSE) {
      if (buf) {
        toks.push({ k: 'text', value: buf });
        buf = '';
      }
      toks.push({ k: ch === OPEN ? 'open' : 'close' });
    } else {
      buf += ch;
    }
  }
  if (buf) toks.push({ k: 'text', value: buf });
  return toks;
}

function group(tokens: Token[]): Node[] {
  const stack: Node[][] = [[]];
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (t.k === 'open') {
      stack.push([]);
    } else if (t.k === 'close') {
      if (stack.length > 1) {
        const collected = stack.pop()!;
        stack[stack.length - 1].push(spoilerNode(collected));
      } else {
        top.push(textNode('!<'));  // unmatched close → literal
      }
    } else if (t.k === 'text') {
      top.push(textNode(t.value));
    } else {
      top.push(t.node);
    }
  }
  // Still-open frames are unmatched opens: restore literal `>!`.
  while (stack.length > 1) {
    const frame = stack.pop()!;
    const top = stack[stack.length - 1];
    top.push(textNode('>!'));
    for (const n of frame) top.push(n);
  }
  return stack[0];
}

function walk(node: Node): void {
  if (!node || !Array.isArray(node.children)) return;
  const tokens: Token[] = [];
  for (const child of node.children) {
    if (
      child.type === 'text' &&
      typeof child.value === 'string' &&
      (child.value.includes(OPEN) || child.value.includes(CLOSE))
    ) {
      tokens.push(...tokenizeText(child.value));
    } else {
      walk(child);  // recurse for spoilers nested in lists/quotes/etc.
      tokens.push({ k: 'node', node: child });
    }
  }
  node.children = group(tokens);
}

export default function remarkSpoiler() {
  return (tree: Node) => walk(tree);
}
