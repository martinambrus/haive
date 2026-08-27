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
  /\b(function|class|def|interface|type|struct|trait|enum|const|let|var|fn|sub|module|namespace)\b/;

/** First line (1-based) that names the symbol, preferring a definition over a
 *  mention; null when it is not in this file at all.
 *
 *  A code link records a path and a symbol but no line, deliberately: a line
 *  number is only true of one checkout, so it is found at read time rather than
 *  stored and left to rot against every later edit. */
export function findSymbolLine(content: string, symbol: string | null): number | null {
  if (!symbol) return null;
  const needle = symbol.includes('::') ? (symbol.split('::').pop() ?? symbol) : symbol;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  const lines = content.split('\n');
  let firstMention: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    if (!re.test(text)) continue;
    if (DEFINES.test(text)) return i + 1;
    if (firstMention === null) firstMention = i + 1;
  }
  return firstMention;
}

/** Fence language for a path, or '' when the extension is unknown — an unknown
 *  language leaves highlight.js to pass the text through, which beats colouring
 *  it as the wrong grammar. */
export function languageForPath(repoPath: string): string {
  const ext = repoPath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? '';
}
