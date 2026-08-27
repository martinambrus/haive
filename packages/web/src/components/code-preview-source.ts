/** Fence language by extension, so highlight.js gets a hint instead of guessing.
 *  An unknown extension falls through to no language — highlight.js then leaves
 *  the text alone, which is better than colouring it as the wrong grammar. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  html: 'xml',
  xml: 'xml',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  md: 'markdown',
};

/** Words that introduce a definition in the languages this repo actually sees.
 *  A declaration line beats a mention: the first whole-word hit for `smtpmail`
 *  in a PHP file is usually the doc comment above it. */
const DEFINES =
  /\b(function|class|def|define|interface|type|struct|trait|enum|const|let|var|fn|sub|module|namespace)\b/;

/** Tokens that carry no location. `new` matched the first comment in a 700-line
 *  file that happened to contain the word, which is how a link to
 *  `$fck = new FCKeditor('FCKeditor1')` pointed at a remark about database
 *  records. Keywords name a language, never a place in it. */
const NOT_A_LOCATION = new Set([
  'new',
  'the',
  'and',
  'for',
  'this',
  'that',
  'with',
  'from',
  'null',
  'true',
  'false',
  'return',
  'function',
  'class',
  'const',
  'let',
  'var',
  'def',
  'import',
  'export',
  'public',
  'private',
  'static',
  'void',
  'php',
]);

/** A line the reader would call a comment. Excluded while looking for a
 *  definition: prose ABOUT the code is not the code.
 *
 *  `<!--` is in the set because the files this feature opens are PHP pages full
 *  of markup, where every section is introduced by an HTML banner comment. Miss
 *  it and a symbol search treats `<!-- TREE MENU ... START -->` as the code it
 *  labels. */
function looksLikeComment(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|#|--|;|<!--)/.test(line);
}

/** How far past a comment to look for the code it introduces. Small on
 *  purpose: a banner sits directly above its section, and a long scan would
 *  walk out of a file header into an unrelated first statement. */
const COMMENT_SCAN_LINES = 12;

/** The located line, moved forward off a comment onto the code beneath it.
 *
 *  A stated location is usually the START OF A REGION, and a region starts at
 *  the banner that names it — `lines 172-515: tree menu init, insertElement...`
 *  is honest about where that region begins and still lands the reader on
 *  `<!-- TREE MENU AND ELEMENT MANAGEMENT FUNCTIONS - START -->`. A code link
 *  points at code, so the divider is stepped over.
 *
 *  Bounded, and it gives up rather than guessing: a comment with nothing but
 *  more comments after it keeps the line it was given, because the prose is
 *  then the only thing that was ever found. */
export function firstCodeLine(content: string, line: number): number {
  const lines = content.split('\n');
  const stop = Math.min(lines.length, line - 1 + COMMENT_SCAN_LINES);
  for (let i = line - 1; i < stop; i++) {
    const text = lines[i]!;
    if (text.trim() === '' || looksLikeComment(text)) continue;
    return i + 1;
  }
  return line;
}

function lineIndexMatching(
  lines: string[],
  re: RegExp,
  opts: { declaredOnly?: boolean; skipComments?: boolean } = {},
): number | null {
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (opts.skipComments && looksLikeComment(text)) continue;
    if (!re.test(text)) continue;
    if (opts.declaredOnly && !DEFINES.test(text)) continue;
    return i + 1;
  }
  return null;
}

/** A whole-word matcher that survives sigils. `\b` cannot open before `$`, so
 *  `\b\$fck\b` matches nothing at all — which is why a PHP variable silently
 *  fell through to the next, far worse, candidate. */
function tokenRegExp(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = /^[A-Za-z0-9_]/.test(token) ? '\\b' : '(?<![\\w$])';
  const close = /[A-Za-z0-9_]$/.test(token) ? '\\b' : '(?![\\w$])';
  return new RegExp(`${open}${escaped}${close}`);
}

/** Identifier-ish candidates inside a symbol field, in the order written.
 *
 *  The field is documented as one identifier, and agents also write it as a
 *  breadcrumb of what matters in the file — "generateErrorPage / installer gate
 *  / require init.php" — or as a whole line of code. All three are real data, so
 *  the phrase is split and each candidate tried in turn. Tokens under three
 *  characters are dropped because they match everywhere, and keywords because
 *  they name a language rather than a place in it.
 */
export function symbolCandidates(symbol: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Not split on ':' — a qualified name is handled below, and splitting it here
  // would offer the CLASS before the method, sending `Mailer::SendMail` to the
  // class declaration instead of the function it names.
  for (const raw of symbol.split(/[\s/,|+()[\]{}=;'"`]+/)) {
    // A qualified name yields its last segment: `Mailer::SendMail` is declared
    // as `SendMail`.
    const token = raw.includes('::') ? (raw.split('::').pop() ?? raw) : raw;
    const trimmed = token.trim();
    if (!/^[A-Za-z_$][\w$.]{2,}$/.test(trimmed)) continue;
    if (NOT_A_LOCATION.has(trimmed.toLowerCase())) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** The line a code link's `evidence` states outright, when it states one.
 *  An agent that wrote "line 596 — the single construction site" already did
 *  the work; guessing from the symbol beats nothing, but not that. */
export function evidenceLine(
  evidence: string | null | undefined,
  lineCount: number,
): number | null {
  if (!evidence) return null;
  const m = /\blines?\s+(\d{1,6})\b/i.exec(evidence);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= lineCount ? n : null;
}

/**
 * First line (1-based) that names the symbol; null when nothing in it appears.
 *
 * Order of preference: the symbol as WRITTEN (an agent that pasted a line of
 * code has named the exact place), then a declaration of any candidate, then a
 * plain mention — comments last in each case, since prose about the code is not
 * the code.
 *
 * A code link records a path and a symbol but no line, deliberately: a line
 * number is only true of one checkout, so it is found at read time rather than
 * stored and left to rot against every later edit.
 */
export function findSymbolLine(content: string, symbol: string | null): number | null {
  if (!symbol) return null;
  const lines = content.split('\n');

  // The whole fragment, with its internal spacing relaxed — an agent writing
  // `$fck = new FCKeditor('FCKeditor1')` has named one line exactly, and no
  // token drawn out of it can be as precise.
  const asWritten = symbol.trim();
  if (/[\s(=]/.test(asWritten)) {
    const loose = asWritten
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*');
    const whole = lineIndexMatching(lines, new RegExp(loose), { skipComments: true });
    if (whole !== null) return whole;
  }

  const candidates = symbolCandidates(symbol);
  for (const pass of [
    { declaredOnly: true, skipComments: true },
    { declaredOnly: false, skipComments: true },
    { declaredOnly: false, skipComments: false },
  ]) {
    for (const token of candidates) {
      const hit = lineIndexMatching(lines, tokenRegExp(token), pass);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Where a code link should open: the line its evidence states, else the line
 * its symbol names, in either case stepped off a comment onto the code.
 *
 * One function so the dialog cannot resolve a line by a path the tests do not
 * cover — the preview's whole job is this number.
 */
export function resolvePreviewLine(
  content: string,
  symbol: string | null,
  evidence: string | null | undefined,
): number | null {
  const stated = evidenceLine(evidence, content.split('\n').length);
  const found = stated ?? findSymbolLine(content, symbol);
  return found === null ? null : firstCodeLine(content, found);
}

/** Fence language for a path, or '' when the extension is unknown — an unknown
 *  language leaves highlight.js to pass the text through, which beats colouring
 *  it as the wrong grammar. */
export function languageForPath(repoPath: string): string {
  const ext = repoPath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? '';
}
