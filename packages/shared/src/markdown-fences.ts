/** A fenced code block, read by CommonMark's rules from lines of text. */
export interface Fence {
  /** First word of the info string, '' when there is none. */
  lang: string;
  /** Line index of the opening fence. */
  open: number;
  /** Line index of the closing fence, null when the block runs to the end of the text. */
  close: number | null;
  /** The lines between, with the opener's indentation taken off each as CommonMark does. */
  content: string[];
}

const OPENER_RE = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)\r?$/;
const CLOSER_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;

/** The fence a line opens, or null: its indentation, its run and its info string. */
export function fenceOpener(line: string): { indent: number; run: string; info: string } | null {
  const m = OPENER_RE.exec(line);
  if (!m) return null;
  const run = m[2]!;
  const info = m[3]!.trim();
  if (run[0] === '`' && info.includes('`')) return null;
  return { indent: m[1]!.length, run, info };
}

/** Whether a line closes a fence opened by `run`: the same character, at least as long. */
export function closesFence(line: string, run: string): boolean {
  const closer = CLOSER_RE.exec(line)?.[1];
  return closer !== undefined && closer[0] === run[0] && closer.length >= run.length;
}

/** Top-level fences only: a line scanner cannot see a fence nested in a list item indented 4 or
 *  more spaces, or one behind a blockquote's `>`. */
export function scanFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opener = fenceOpener(lines[i]!);
    if (!opener) continue;
    const indent = new RegExp(`^ {0,${opener.indent}}`);
    const lang = opener.info.split(/[ \t]/)[0]!;
    const fence: Fence = { lang, open: i, close: null, content: [] };
    for (i += 1; i < lines.length; i++) {
      if (closesFence(lines[i]!, opener.run)) {
        fence.close = i;
        break;
      }
      fence.content.push(lines[i]!.replace(indent, ''));
    }
    fences.push(fence);
  }
  return fences;
}

/** Per line: whether it is a fence line or inside a fenced block. */
export function fencedLines(lines: readonly string[]): boolean[] {
  const inside = lines.map(() => false);
  for (const f of scanFences(lines)) {
    for (let i = f.open; i <= (f.close ?? lines.length - 1); i++) inside[i] = true;
  }
  return inside;
}
