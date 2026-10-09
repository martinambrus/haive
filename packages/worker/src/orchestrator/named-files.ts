import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';

// Linux's NAME_MAX and PATH_MAX, counted in UTF-16 units, which never outnumber UTF-8 bytes.
const MAX_SEGMENT_CHARS = 255;
const MAX_PATH_CHARS = 4096;
// A path and its wrapping fit; a longer piece (a pasted blob) is skipped before any work on it.
const MAX_PIECE_CHARS = 2 * MAX_PATH_CHARS;
const WRAP_OPEN = '[{<"\'';
const WRAP_CLOSE = ']}>"\',;:!?.';
const EMPHASIS = ['**', '__', '*', '_'];
const LINE_REF = /(?::\d+(?:[-:]\d+)?|#L\d+(?:-L?\d+)?)$/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
const WWW_URL = /^www\./i;
// No glob character and no "scheme://" URL is made of these.
const PATH_CHARS = /^[\p{L}\p{M}\p{N}._@+%~$()/-]+$/u;
// A parenthesis belongs to a name only as a whole-segment group like Next.js's `(app)`, never as a call.
const SEGMENT = /^(?:[^()]*|\([^()]+\))$/;

/** Each parenthesis' partner in the token, or -1 for one that has none. */
function pairParentheses(token: string): number[] {
  const partner = new Array<number>(token.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === '(') {
      open.push(i);
    } else if (token[i] === ')' && open.length > 0) {
      const mate = open.pop()!;
      partner[mate] = i;
      partner[i] = mate;
    }
  }
  return partner;
}

// A scan, not a `[...]+$` regex, which is quadratic on a long run of these; the text is agent output.
function peel(token: string): string {
  const partner = pairParentheses(token);
  let start = 0;
  let end = token.length;
  // An edge parenthesis comes off only unpaired, or as the pair around the whole token: a route group stays.
  while (
    start < end &&
    (WRAP_OPEN.includes(token[start]!) || (token[start] === '(' && partner[start] === -1))
  ) {
    start += 1;
  }
  while (
    end > start &&
    (WRAP_CLOSE.includes(token[end - 1]!) || (token[end - 1] === ')' && partner[end - 1] === -1))
  ) {
    end -= 1;
  }
  while (start < end && token[start] === '(' && partner[start] === end - 1) {
    start += 1;
    end -= 1;
  }
  return token.slice(start, end);
}

function unwrap(piece: string): string {
  let token = piece;
  for (let pass = 0; pass < 8; pass += 1) {
    const before = token;
    const mark = EMPHASIS.find(
      (m) => token.length > 2 * m.length && token.startsWith(m) && token.endsWith(m),
    );
    if (mark !== undefined) token = token.slice(mark.length, -mark.length);
    token = peel(token);
    if (token === before) break;
  }
  return token;
}

function withoutAnchor(token: string): string {
  const hash = token.indexOf('#', token.lastIndexOf('/') + 1);
  return hash !== -1 && EXTENSION.test(token.slice(0, hash)) ? token.slice(0, hash) : token;
}

function isName(token: string): boolean {
  return (
    (token.includes('/') || EXTENSION.test(token)) &&
    token.length <= MAX_PATH_CHARS &&
    PATH_CHARS.test(token) &&
    !WWW_URL.test(token) &&
    !token.startsWith('/') &&
    !token.startsWith('...') &&
    !token
      .split('/')
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          segment.length > MAX_SEGMENT_CHARS ||
          !SEGMENT.test(segment),
      )
  );
}

/** The paths a text names, as written: a name has a "/" or an extension and need not exist. */
export function namedFiles(text: string): string[] {
  const found = new Set<string>();
  // A markdown link `[text](target)` reads as two tokens, its text and its target.
  for (const piece of text.split(/[\s`]+|\]\(/)) {
    if (piece.length > MAX_PIECE_CHARS) continue;
    let token = withoutAnchor(unwrap(piece).replace(LINE_REF, ''));
    if (token.startsWith(`${SANDBOX_WORKDIR}/`)) token = token.slice(SANDBOX_WORKDIR.length + 1);
    while (token.startsWith('./')) token = token.slice(2);
    if (isName(token)) found.add(token);
  }
  return [...found];
}

/** A name that ends exactly one tracked file on a "/" boundary becomes that file; a bare word no
 *  tracked file carries is dropped; others stay as written. */
export function resolveNamedFiles(names: readonly string[], tracked: readonly string[]): string[] {
  const byBase = new Map<string, string[]>();
  for (const file of tracked) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    const same = byBase.get(base);
    if (same === undefined) byBase.set(base, [file]);
    else same.push(file);
  }
  return names.flatMap((name) => {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const ends = (byBase.get(base) ?? []).filter(
      (file) => file === name || file.endsWith(`/${name}`),
    );
    if (ends.length === 1) return [ends[0]!];
    // A bare word that no tracked file carries is prose ("Node.js"), not a path.
    return ends.length === 0 && !name.includes('/') ? [] : [name];
  });
}
