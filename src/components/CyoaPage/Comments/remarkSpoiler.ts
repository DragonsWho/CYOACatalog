// Reddit-style spoilers:  >!hidden text!<  (may span multiple lines / builds).
//
// A raw `>` at the start of a line would start a blockquote, so `protectSpoilers`
// swaps the `>!`/`!<` delimiters for private-use sentinels BEFORE parsing. This
// plugin then walks the mdast and, at each node level, tokenises the sentinels
// out of text children and re-groups everything between a matching OPEN/CLOSE
// (including line-break nodes and nested formatting) into a `spoiler` element.
// Unmatched sentinels are restored to literal `>!` / `!<`.

// Private-use sentinels (built via char codes so the source stays pure ASCII).
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);

/** Swap the `>!`/`!<` delimiters for sentinels so markdown won't mangle them. */
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
  // `strong` is a known mdast type (so it has a hast handler); data.hName
  // overrides the emitted tag, giving us a <spoiler> element.
  return { type: 'strong', data: { hName: 'spoiler' }, children };
}

/** Break a text value into text/open/close tokens. */
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

/** Stack-based grouping of OPEN…CLOSE ranges into spoiler nodes. */
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
        top.push(textNode('!<')); // unmatched close → literal
      }
    } else if (t.k === 'text') {
      top.push(textNode(t.value));
    } else {
      top.push(t.node);
    }
  }
  // Any still-open frames are unmatched opens: restore the literal `>!`.
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
      walk(child); // recurse for spoilers nested in lists/quotes/etc.
      tokens.push({ k: 'node', node: child });
    }
  }
  node.children = group(tokens);
}

/** remark plugin: expand sentinel pairs into `spoiler` elements. */
export default function remarkSpoiler() {
  return (tree: Node) => walk(tree);
}
