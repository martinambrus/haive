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

/** Identifier-ish candidates inside a symbol field, in the order written.
 *
 *  The field is documented as one identifier, and agents also write it as a
 *  breadcrumb of what matters in the file — "generateErrorPage / installer gate
 *  / require init.php". Both are real data, so both are read: the phrase is
 *  split and each candidate tried in turn. Tokens under three characters are
 *  dropped because they match everywhere and would point at noise.
 */
export function symbolCandidates(symbol: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of symbol.split(/[\s/,|+()[\]{}]+/)) {
    // A qualified name yields its last segment: `Mailer::SendMail` is declared
    // as `SendMail`.
    const token = raw.includes('::') ? (raw.split('::').pop() ?? raw) : raw;
    const trimmed = token.trim();
    if (!/^[A-Za-z_$][\w$.]{2,}$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function lineMatching(lines: string[], token: string, declaredOnly: boolean): number | null {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (!re.test(text)) continue;
    if (!declaredOnly || DEFINES.test(text)) return i + 1;
  }
  return null;
}

/** First line (1-based) that names the symbol, preferring a declaration over a
 *  mention; null when nothing in the symbol appears in this file at all.
 *
 *  A code link records a path and a symbol but no line, deliberately: a line
 *  number is only true of one checkout, so it is found at read time rather than
 *  stored and left to rot against every later edit. */
export function findSymbolLine(content: string, symbol: string | null): number | null {
  if (!symbol) return null;
  const lines = content.split('\n');
  const candidates = symbolCandidates(symbol);
  // Declarations of ANY candidate beat a mention of the first one: a symbol
  // field that leads with prose should still land on the function it names.
  for (const token of candidates) {
    const declared = lineMatching(lines, token, true);
    if (declared !== null) return declared;
  }
  for (const token of candidates) {
    const mention = lineMatching(lines, token, false);
    if (mention !== null) return mention;
  }
  return null;
}

/** Fence language for a path, or '' when the extension is unknown — an unknown
 *  language leaves highlight.js to pass the text through, which beats colouring
 *  it as the wrong grammar. */
export function languageForPath(repoPath: string): string {
  const ext = repoPath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? '';
}
