/** Local stand-in for `remark-breaks` (kept in-repo rather than added as a
 *  dependency — it is ~30 lines and a new dep here costs a full stack rebuild).
 *
 *  Turns every SOFT line break inside a paragraph into a hard `break` node, so a
 *  body whose newlines carry meaning (plain diagnostic text, CLI prose, bullet
 *  lists written without blank lines) keeps its line structure when rendered
 *  through the markdown pipeline instead of being reflowed into one blob.
 *
 *  Applied ONLY to bodies that do not look like markdown (see `looksLikeMarkdown`
 *  in markdown-view.tsx): genuine markdown prose is usually hard-wrapped at ~80
 *  columns by the authoring model, and forcing those wraps into <br> would make
 *  every narrow column ragged.
 *
 *  Only `text` nodes are touched. `code` / `inlineCode` / `html` carry their body
 *  in `value` with no children, so fenced blocks and inline spans are untouched. */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const NEWLINE = /\r?\n/;

export function remarkSoftBreaks() {
  return (tree: unknown): void => {
    breakify(tree as MdNode);
  };
}

function breakify(node: MdNode): void {
  const children = node.children;
  if (!children) return;
  // `out` stays null until the first text node that actually splits, so a subtree
  // with no soft breaks keeps its original children array.
  let out: MdNode[] | null = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.type === 'text' && typeof child.value === 'string' && NEWLINE.test(child.value)) {
      out ??= children.slice(0, i);
      const parts = child.value.split(NEWLINE);
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) out.push({ type: 'break' });
        // The newline consumed the trailing spaces on the line it ended; dropping
        // them matches remark-breaks and stops a stray space before the <br>.
        const value = p < parts.length - 1 ? parts[p]!.replace(/[ \t]+$/, '') : parts[p]!;
        if (value.length > 0) out.push({ type: 'text', value });
      }
      continue;
    }
    breakify(child);
    out?.push(child);
  }
  if (out) node.children = out;
}
