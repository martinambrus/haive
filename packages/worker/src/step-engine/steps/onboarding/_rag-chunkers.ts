import { createHash } from 'node:crypto';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RagSection {
  sectionId: string;
  content: string;
  /** Structural ancestry, outermost first: ['Deployment','DDEV','Ports'] for a
   *  markdown H3, ['class Foo','function bar'] for a PHP method. Empty for gap
   *  sections. Callers turn it into the chunk context header. */
  breadcrumb: string[];
}

export interface RagChunk {
  sectionId: string;
  chunkIndex: number;
  content: string;
  chunkHash: string;
}

/** A matched syntactic construct, as offsets into the file. Extractors return
 *  offsets rather than pre-sliced text so `assembleSections` can also see the
 *  spans BETWEEN matches and index those instead of discarding them. */
interface SectionRange {
  sectionId: string;
  start: number;
  /** Where the comment run directly above the construct starts, taken into the section when it is free. */
  commentStart?: number;
  end: number;
  breadcrumb: string[];
}

/* ------------------------------------------------------------------ */
/* Code extension map                                                  */
/* ------------------------------------------------------------------ */

export const CODE_EXTENSIONS: Record<string, string> = {
  '.php': 'php',
  '.inc': 'php',
  '.module': 'php',
  '.install': 'php',
  '.theme': 'php',
  '.profile': 'php',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'javascript',
  '.vue': 'javascript',
  '.svelte': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
};

/** .ts permits angle assertions; JSX is read only in the JS/JSX and TSX formats.
 *  Vue/Svelte keep their established script reader. */
const JSX_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.tsx']);

/** Minified / generated bundle files. These are machine-generated, single-line,
 *  and semantically useless to embed — they pollute the RAG index with false
 *  hits and waste embedding budget. Skipped at collection time even when their
 *  extension is in CODE_EXTENSIONS. */
const MINIFIED_RE = /(\.min\.(js|mjs|css)|\.bundle\.(js|css)|[.-]min\.(js|css))$/i;

export function isMinifiedPath(rel: string): boolean {
  return MINIFIED_RE.test(rel);
}

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

/** Files bigger than this are skipped whole rather than indexed in part. Real
 *  hand-written source never reaches it; past this size the cost is embedding
 *  time, not retrieval value. Callers log the skip — never drop a file quietly.
 *  Applies outside the repository's own code and KB, see `fileBudget`. */
export const MAX_FILE_BYTES = 512_000;

/** The size limit for a repository's own code and KB: a backstop against a generated file. */
export const MAX_OWN_FILE_BYTES = 2_000_000;

/** Per-file chunk budget (~160 KB of covered text at DEFAULT_MAX_SIZE). This is
 *  the real constraint the old 3000/5000-char slices were groping at: peak
 *  memory is bounded by the file itself either way, but every extra chunk is
 *  another embedding call. Over-budget files keep the first N chunks and report
 *  the remainder so the loss is logged rather than silent. Applies outside the
 *  repository's own code and KB, see `fileBudget`. */
export const MAX_CHUNKS_PER_FILE = 80;

/** True when `relPath` is the own entry (a directory, with or without a trailing slash, or a
 *  single file) or lives under it. */
export function isOwnPath(relPath: string, entry: string): boolean {
  const base = entry.replace(/\/+$/, '');
  return relPath === base || relPath.startsWith(`${base}/`);
}

export function fileBudget(
  relPath: string,
  kind: 'kb' | 'code',
  ownPaths: readonly string[],
): { maxBytes: number; maxChunks: number } {
  const own = kind === 'kb' || ownPaths.some((entry) => isOwnPath(relPath, entry));
  return own
    ? { maxBytes: MAX_OWN_FILE_BYTES, maxChunks: Infinity }
    : { maxBytes: MAX_FILE_BYTES, maxChunks: MAX_CHUNKS_PER_FILE };
}

/** A span between sections is a section of its own when its trimmed length reaches this; a
 *  shorter span that is not blank joins a neighbouring section, see `assembleSections`. */
const MIN_GAP_CHARS = 120;

/** The lines a span starts with that hold nothing but closing brackets, semicolons or commas. */
const CLOSING_LINES = /^(?:[ \t]*(?:[)\]};,]+[ \t]*)?(?:\r\n|[\r\n\u2028\u2029]))*/;

/* ------------------------------------------------------------------ */
/* Hashing / slugify                                                   */
/* ------------------------------------------------------------------ */

export function computeChunkHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Section ids are encoded into stale-reconcile keys as `${sectionId}:${chunkIndex}`
 *  and parsed back on the FIRST colon (steps/workflow/_rag-index.ts), so an id
 *  containing ':' would split at the wrong place and orphan the row. Normalise
 *  here rather than relying on every extractor to remember. */
function safeSectionId(id: string): string {
  return id.replace(/:/g, '-');
}

/** Make section ids unique within one file. Extractors name a section after its
 *  construct (`function-_Replace`, a heading slug), which is NOT unique: a file
 *  declaring the same name twice, or repeating a heading, produced two sections
 *  sharing one `(section_id, chunk_index)` row key.
 *
 *  That key is the RAG dedup key, so the collision was silently destructive:
 *  the unique index kept whichever chunk landed last, the sibling's row never
 *  existed, and the next sync compared the sibling's hash against the survivor's
 *  and re-embedded it. Every run, forever. MEASURED on one repo: 25 such keys,
 *  3 of them re-embedding on a sync whose other 3091 chunks were correctly
 *  skipped.
 *
 *  The nth repeat becomes `${id}~${n}`. '~' is used because no extractor and no
 *  slug can emit it, so a suffixed id can never collide with a real one that
 *  happens to end in a digit — and it is not ':' , which safeSectionId reserves
 *  as the stale-key separator. */
function uniqueSectionIds(sections: RagSection[]): RagSection[] {
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const n = (seen.get(section.sectionId) ?? 0) + 1;
    seen.set(section.sectionId, n);
    return n === 1 ? section : { ...section, sectionId: `${section.sectionId}~${n}` };
  });
}

/* ------------------------------------------------------------------ */
/* Markdown section extraction                                         */
/* ------------------------------------------------------------------ */

const HEADING_RE = /^(#{1,3})\s+(.+)$/;

/** True when a block of markdown holds nothing but its own heading — an H1 whose
 *  first child is an H2, or a heading at EOF.
 *
 *  Such a section chunks into pure title text, which is the worst possible shape
 *  for this index: it embeds sharply, so on the title-shaped query the global KB
 *  digest instructs agents to make ("call `rag_search` with a title to read the
 *  entry behind it") it OUTRANKS the entry's own body chunks and then spends the
 *  entry's single merge slot on zero information. MEASURED before this guard:
 *  37 of 370 global KB chunks were these, and one beat its own body at
 *  dense=0.903 on a query naming that entry's own subject matter.
 *
 *  Nothing is lost by dropping it — every child section already carries the
 *  parent heading in its breadcrumb, and therefore in its chunk context header. */
export function isHeadingOnlyMarkdown(text: string): boolean {
  const lines = text.split(/\r\n|[\r\n]/).filter((l) => l.trim().length > 0);
  return lines.length === 1 && HEADING_RE.test(lines[0]!.trim());
}

/** Chunk-level counterpart: a STORED chunk carries the `[context header]` line
 *  `chunkSection` prepends, so strip that before applying the section-level
 *  rule. Conservative by construction — content whose first line is not a
 *  bracketed header keeps that line, so it reads as two lines and is never
 *  reported as heading-only. */
export function isHeadingOnlyChunk(content: string): boolean {
  const body = /^\[[^\n]*\]\n/.test(content) ? content.slice(content.indexOf('\n') + 1) : content;
  return isHeadingOnlyMarkdown(body);
}

export function extractMarkdownSections(content: string, _filePath: string): RagSection[] {
  const { lines, offsets } = sourceLines(content);
  const sections: RagSection[] = [];
  // Heading-only sections are dropped, but held aside: a document that is
  // NOTHING but headings would otherwise index to zero chunks and become
  // unretrievable, which is worse than one weak chunk.
  const headingOnly: RagSection[] = [];
  // Heading text per level (1-3). A heading clears every deeper level, so an H3
  // under a fresh H2 never inherits the previous H2's ancestry.
  const stack: Array<string | undefined> = [undefined, undefined, undefined];
  let currentId = 'intro';
  let currentBreadcrumb: string[] = [];
  let currentStart = 0;

  const flush = (end: number): void => {
    const text = content.slice(currentStart, end).trim();
    if (!text) return;
    const section = { sectionId: currentId, content: text, breadcrumb: currentBreadcrumb };
    if (isHeadingOnlyMarkdown(text)) headingOnly.push(section);
    else sections.push(section);
  };

  for (const [index, line] of lines.entries()) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush(offsets[index]!);
      const level = m[1]!.length;
      const title = m[2]!.trim();
      stack[level - 1] = title;
      for (let deeper = level; deeper < stack.length; deeper += 1) stack[deeper] = undefined;
      currentId = safeSectionId(slugifyHeading(title));
      currentBreadcrumb = stack.slice(0, level).filter((s): s is string => !!s);
      currentStart = offsets[index]!;
    }
  }

  flush(content.length);

  return uniqueSectionIds(sections.length > 0 ? sections : headingOnly);
}

/* ------------------------------------------------------------------ */
/* Comment and string masking                                          */
/* ------------------------------------------------------------------ */

type Span = [from: number, to: number];

/** A short `<?` needs no space after it; `<?xml` stays markup, as most installs turn short tags off. */
const PHP_OPEN_TAG = /<\?(?:php(?=\s|$)|=|(?!xml\b))/gi;
/** PHP reads any byte from 0x80 up as a label character, so every non-ASCII code unit is one. */
const PHP_LABEL = String.raw`[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*`;
const PHP_LABEL_CHAR = /[\w\u0080-\uFFFF]/;
const PHP_HEREDOC = new RegExp(
  String.raw`<<<[ \t]*(?:'(${PHP_LABEL})'|"(${PHP_LABEL})"|(${PHP_LABEL}))(?:\r\n?|\n)`,
  'y',
);
const REGEX_AFTER_WORD = /^(?:return|typeof|instanceof|in|new|delete|void|throw|case|do|else)$/;
/** Keywords only in their own syntax: an identifier anywhere else, so a slash after one divides. */
const CONTEXTUAL_WORDS = new Set(['of', 'yield', 'await']);
const BARE_NAME = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const WORD_START = /^[\p{ID_Start}_$]/u;
const WORD_CHAR = /^[\p{ID_Continue}$\u200C\u200D]/u;

/** The whole code point at `at`, so an identifier character outside the BMP is read as one. */
function codePointAt(text: string, at: number): string {
  return String.fromCodePoint(text.codePointAt(at) ?? 0);
}

/** A '/' that opens no regex literal would otherwise scan to the end of its line from every call: a
 *  literal longer than MAX_REGEX_CHARS is not read as one, and a line gives up on regex literals after
 *  MAX_REGEX_MISSES slashes that closed none. */
const MAX_REGEX_CHARS = 20_000;
const MAX_REGEX_MISSES = 8;

/** How many unclosed template literals or block comments one file may give back as plain text before the rest masks to EOF. */
const MAX_STRAY_TICKS = 8;

/** `//` right after `scheme:` is a URL in markup text, not a line comment. */
const URL_SCHEME = /[A-Za-z][A-Za-z0-9+.-]*:$/;

/** `scheme://` where a statement may start is a label before a comment, not a URL. */
function isUrlScheme(text: string, slash: number): boolean {
  const head = text.slice(Math.max(0, slash - 40), slash);
  const m = URL_SCHEME.exec(head);
  if (!m) return false;
  const before = head.slice(0, m.index).trimEnd();
  return !(before === '' && slash <= 40) && !/[{};)]$/.test(before);
}

/** Java and PHP end a line at LF or CR; ECMAScript also at U+2028 and U+2029. */
function isLineTerminator(c: string, lfCrOnly: boolean): boolean {
  return c === '\n' || c === '\r' || (!lfCrOnly && (c === '\u2028' || c === '\u2029'));
}

/** Whether only spaces and tabs stand between the start of `at`'s line and `at`. */
function atLineStart(text: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  return j < 0 || isLineTerminator(text[j]!, false);
}

/** Index of the first line terminator at or after `from`, else -1. */
function lineEnd(text: string, from: number, lfCrOnly: boolean): number {
  for (let i = from; i < text.length; i += 1) if (isLineTerminator(text[i]!, lfCrOnly)) return i;
  return -1;
}

/** Start of the physical line containing the position just before `at`. */
function lineStartAt(text: string, at: number): number {
  let i = at - 1;
  while (i >= 0 && !isLineTerminator(text[i]!, false)) i -= 1;
  return i + 1;
}

/** Original line bodies and offsets; CRLF counts once and is never normalised. */
function sourceLines(text: string): { lines: string[]; offsets: number[] } {
  const lines: string[] = [];
  const offsets: number[] = [];
  let from = 0;
  for (const match of text.matchAll(/\r\n|[\r\n]/g)) {
    offsets.push(from);
    lines.push(text.slice(from, match.index));
    from = match.index + match[0].length;
  }
  offsets.push(from);
  lines.push(text.slice(from));
  return { lines, offsets };
}

/** Index just past the quote that closes the string opening at `open`, else the end of the text. */
function quotedEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === text[open]) return i + 1;
  }
  return text.length;
}

/** `quotedEnd` for a JS string, which is -1 when its line ends first: such a quote is text, as an
 *  apostrophe is in markup. */
function lineStringEnd(text: string, open: number, java: boolean): number {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += text[i + 1] === '\r' && text[i + 2] === '\n' ? 2 : 1;
    else if (text[i] === text[open]) return i + 1;
    else if (isLineTerminator(text[i]!, java)) return -1;
  }
  return -1;
}

/** Index just past the `"""` that closes the Java text block opening at `open`, else -1. */
function textBlockEnd(text: string, open: number): number {
  for (let i = open + 3; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text.startsWith('"""', i)) return i + 3;
  }
  return -1;
}

/** Index just past the '}' that closes the '{' at `open`; a quoted string inside is skipped. */
function interpolationEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '"' || text[i] === "'") i = quotedEnd(text, i) - 1;
    else if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function phpDoubleQuotedEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
    else if (text[i] === '{' && text[i + 1] === '$') i = interpolationEnd(text, i) - 1;
    else if (text[i] === '$' && text[i + 1] === '{') i = interpolationEnd(text, i + 1) - 1;
  }
  return text.length;
}

/** The body of the string that opens at `open` and ends at `end`, quotes out. */
function stringBody(text: string, open: number, end: number): Span {
  return [open + 1, end - 1 > open && text[end - 1] === text[open] ? end - 1 : end];
}

/** The body and the end (just past the closing label) of the heredoc or nowdoc opening at `open`. */
function heredocAt(text: string, open: number): { body: Span; end: number } | null {
  PHP_HEREDOC.lastIndex = open;
  const m = PHP_HEREDOC.exec(text);
  if (!m) return null;
  const label = (m[1] ?? m[2] ?? m[3])!;
  const bodyStart = open + m[0].length;
  for (let line = bodyStart; line < text.length;) {
    let at = line;
    while (text[at] === ' ' || text[at] === '\t') at += 1;
    if (text.startsWith(label, at) && !PHP_LABEL_CHAR.test(text[at + label.length] ?? ' ')) {
      return { body: [bodyStart, line], end: at + label.length };
    }
    const newline = lineEnd(text, line, true);
    if (newline < 0) break;
    line = newline + (text[newline] === '\r' && text[newline + 1] === '\n' ? 2 : 1);
  }
  return { body: [bodyStart, text.length], end: text.length };
}

/** The spans of a PHP file that are not code: inline HTML, comments, strings and heredocs. A file
 *  with no open tag, such as a template, is inline HTML throughout. */
function phpNonCode(text: string): Span[] {
  const spans: Span[] = [];
  const openAfter = (from: number): RegExpExecArray | null => {
    PHP_OPEN_TAG.lastIndex = from;
    return PHP_OPEN_TAG.exec(text);
  };
  let tag = openAfter(0);
  spans.push([0, tag ? tag.index : text.length]);
  let i = tag ? tag.index + tag[0].length : text.length;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    const heredoc = c === '<' ? heredocAt(text, i) : null;
    if (c === '?' && next === '>') {
      tag = openAfter(i + 2);
      spans.push([i + 2, tag ? tag.index : text.length]);
      i = tag ? tag.index + tag[0].length : text.length;
    } else if ((c === '/' && next === '/') || (c === '#' && next !== '[')) {
      const from = i + (c === '#' ? 1 : 2);
      i = from;
      while (
        i < text.length &&
        !isLineTerminator(text[i]!, true) &&
        !(text[i] === '?' && text[i + 1] === '>')
      )
        i += 1;
      spans.push([from, i]);
    } else if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      spans.push([
        i + (text.startsWith('/**', i) && text[i + 3] !== '/' ? 3 : 2),
        close < 0 ? text.length : close,
      ]);
      i = close < 0 ? text.length : close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const end = c === '"' ? phpDoubleQuotedEnd(text, i) : quotedEnd(text, i);
      spans.push(stringBody(text, i, end));
      i = end;
    } else if (heredoc) {
      spans.push(heredoc.body);
      i = heredoc.end;
    } else i += 1;
  }
  return spans;
}

/** Index of the '/' that closes a regex, or -1 when it cannot close within the bound.
 *  JS stays on one line; Ruby explicitly permits a multiline regexp value. */
function regexClose(text: string, open: number, java: boolean, multiline = false): number {
  let inClass = false;
  const limit = Math.min(text.length, open + MAX_REGEX_CHARS);
  for (let i = open + 1; i < limit; i += 1) {
    if (!multiline && isLineTerminator(text[i]!, java)) return -1;
    if (text[i] === '\\') i += 1;
    else if (text[i] === '[') inClass = true;
    else if (text[i] === ']') inClass = false;
    else if (text[i] === '/' && !inClass) return i;
  }
  return -1;
}

/** Whether a '/' after the token `prev` opens a regex literal rather than divides: `prev` is a word,
 *  '' after a literal or a number, its punctuation otherwise, and null at the start of the text. */
function regexMayStart(prev: string | null): boolean {
  if (prev === null) return true;
  if (WORD_START.test(prev)) return REGEX_AFTER_WORD.test(prev);
  return prev !== '' && ![')', ']', '}', '>', '<', '.'].includes(prev);
}

/** Whether the `<` or `>` run before the slash at `slash` is a spaced operator (`a > /re/`), not the
 *  end of a JSX tag (`<p>/x`) or the start of a closing one (`</p>`): spaces on both sides of it. */
function spacedOperatorBefore(text: string, slash: number): boolean {
  let j = slash - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j -= 1;
  if (j === slash - 1 || j < 0 || (text[j] !== '<' && text[j] !== '>')) return false;
  let k = j;
  while (k > 0 && (text[k - 1] === '<' || text[k - 1] === '>')) k -= 1;
  return k > 0 && (text[k - 1] === ' ' || text[k - 1] === '\t');
}

interface JsxFrame {
  mode: 'tag' | 'text' | 'expression';
  depth: number;
  closing: boolean;
  braces: number;
  resume: 'tag' | 'text';
}

/** One token from a bounded JSX lookahead, skipping JS trivia and comments. */
function jsxHeadToken(text: string, from: number): { text: string; word: boolean; end: number } {
  let i = from;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) i += 1;
    else if (text.startsWith('//', i)) {
      const end = lineEnd(text, i + 2, false);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else break;
  }
  const start = i;
  const word = i < text.length && WORD_START.test(codePointAt(text, i));
  if (word) {
    i += codePointAt(text, i).length;
    while (i < text.length && WORD_CHAR.test(codePointAt(text, i)))
      i += codePointAt(text, i).length;
  } else if (i < text.length) i += 1;
  return { text: text.slice(start, i), word, end: i };
}

// TypeScript's hard reserved words cannot name a type parameter, but may name a JSX tag.
const TS_RESERVED_NAME =
  /^(?:break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|function|if|import|in|instanceof|new|null|return|super|switch|this|throw|true|try|typeof|var|void|while|with)$/;

/** Match TypeScript's JSX generic-arrow prefix decision on tokens, not head spelling.
 *  The prefix suffices; nested constraints and parameter/return syntax stay ordinary code. */
function tsxGenericHead(header: string): boolean {
  let name = jsxHeadToken(header, 1);
  if (name.text === 'const') name = jsxHeadToken(header, name.end);
  if (!name.word || TS_RESERVED_NAME.test(name.text)) return false;
  const next = jsxHeadToken(header, name.end);
  if (next.text === ',' || next.text === '=') return true;
  if (next.text !== 'extends') return false;
  const constraint = jsxHeadToken(header, next.end).text;
  return constraint !== '' && !['=', '>', '/'].includes(constraint);
}

/** Read a bounded opening tag only after ruling out the token-level generic prefix. */
function jsxOpeningAt(text: string, at: number, tsx: boolean): boolean {
  const header = text.slice(at, at + MAX_PARAMS_CHARS);
  if (tsx && tsxGenericHead(header)) return false;
  const head = /^<(?:[A-Za-z][\w.:-]*(?=[\s/>])|(?=>))/.exec(header.slice(0, 256));
  if (!head) return false;
  let braces = 0;
  for (let i = head[0].length; i < header.length; i += 1) {
    const c = header[i];
    if ((c === '"' || c === "'") && braces === 0) {
      const close = header.indexOf(c, i + 1);
      i = close < 0 ? header.length : close;
    } else if (c === '"' || c === "'" || c === '`') i = quotedEnd(header, i) - 1;
    else if (c === '{') braces += 1;
    else if (c === '}') braces -= 1;
    else if (c === '>' && braces === 0) return true;
  }
  return false;
}

/** The spans of a JS, TS or Java file that are not code: comments, strings, template literals (their
 *  `${}` expressions too) and regex literals. A string that is a bare name stays: it may be a key. */
function jsNonCode(
  text: string,
  java: boolean,
  htmlComments = false,
  module = false,
  jsxMode: boolean | 'tsx' = false,
): Span[] {
  const spans: Span[] = [];
  // The open template literals and `${` expressions, innermost last: -1 is template text, n >= 1
  // the braces open in an expression. Spans are recorded for the outermost template only.
  const frames: number[] = [];
  let templateOpen = 0;
  const jsx: JsxFrame[] = [];
  let prev: string | null = null;
  let regexMisses = 0;
  let strayTicks = 0;
  let sawGenerator = false;
  let sawAsync = module;
  let i = 0;
  if (!java && text.startsWith('#!')) {
    const close = lineEnd(text, 2, false);
    i = close < 0 ? text.length : close;
    spans.push([2, i]);
  }
  while (true) {
    if (i >= text.length) {
      if (frames.length === 0 || strayTicks >= MAX_STRAY_TICKS) break;
      // A template that never closes is a stray backtick (JSX text, a comment's prose): lex on as text.
      strayTicks += 1;
      frames.length = 0;
      i = templateOpen + 1;
      prev = '';
      continue;
    }
    const c = text[i]!;
    const next = text[i + 1];
    const top = frames[frames.length - 1];
    const markup = jsx[jsx.length - 1];
    if (top === undefined && markup && markup.mode !== 'expression') {
      if (c === '{') {
        markup.resume = markup.mode;
        markup.mode = 'expression';
        markup.braces = 1;
        prev = '{';
        i += 1;
      } else if (markup.mode === 'text' && c === '<') {
        markup.mode = 'tag';
        markup.closing = next === '/';
        i += next === '/' ? 2 : 1;
      } else if (markup.mode === 'tag' && (c === '"' || c === "'")) {
        const close = text.indexOf(c, i + 1);
        const end = close < 0 ? text.length : close + 1;
        spans.push([i, end]);
        i = end;
      } else if (markup.mode === 'tag' && c === '>') {
        if (markup.closing) markup.depth -= 1;
        else if (text[i - 1] !== '/') markup.depth += 1;
        i += 1;
        if (markup.depth === 0) {
          jsx.pop();
          prev = '';
        } else markup.mode = 'text';
      } else {
        const from = i++;
        while (
          i < text.length &&
          (markup.mode === 'text' ? text[i] !== '<' && text[i] !== '{' : !/[>{"']/.test(text[i]!))
        )
          i += 1;
        spans.push([from, i]);
      }
      continue;
    }
    if (
      jsxMode &&
      !java &&
      top === undefined &&
      c === '<' &&
      regexMayStart(prev) &&
      jsxOpeningAt(text, i, jsxMode === 'tsx')
    ) {
      jsx.push({ mode: 'tag', depth: 0, closing: false, braces: 0, resume: 'text' });
      i += 1;
      continue;
    }
    if (top === -1) {
      if (c === '\\') i += 2;
      else if (c === '$' && next === '{') {
        frames.push(1);
        prev = '{';
        i += 2;
      } else {
        i += 1;
        if (c === '`') {
          frames.pop();
          if (frames.length === 0) {
            spans.push([templateOpen + 1, i - 1]);
            prev = '';
          }
        }
      }
    } else if (/\s/.test(c)) {
      i += 1;
      if (isLineTerminator(c, java)) regexMisses = 0;
    } else if (
      htmlComments &&
      ((c === '<' && text.startsWith('<!--', i)) ||
        (c === '-' && text.startsWith('-->', i) && atLineStart(text, i)))
    ) {
      const from = i + (c === '<' ? 4 : 3);
      const close = lineEnd(text, from, false);
      const bodyEnd = close < 0 ? text.length : close;
      if (frames.length === 0) spans.push([from, bodyEnd]);
      i = bodyEnd;
    } else if (c === '/' && next === '/' && isUrlScheme(text, i)) {
      prev = '';
      i += 2;
    } else if (c === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? lineEnd(text, i + 2, java) : text.indexOf('*/', i + 2);
      if (close < 0 && next === '*' && frames.length === 0 && strayTicks < MAX_STRAY_TICKS) {
        // An unclosed block comment is a regex like /[/*]/ read as one: lex on as code.
        strayTicks += 1;
        prev = '';
        i += 2;
        continue;
      }
      const bodyEnd = close < 0 ? text.length : close;
      if (frames.length === 0) spans.push([i + 2, bodyEnd]);
      i = next === '*' && close >= 0 ? close + 2 : bodyEnd;
    } else if (c === '/') {
      const mayStart =
        regexMayStart(prev) || ((prev === '<' || prev === '>') && spacedOperatorBefore(text, i));
      const close = mayStart && regexMisses < MAX_REGEX_MISSES ? regexClose(text, i, java) : -1;
      if (close < 0) {
        if (mayStart) regexMisses += 1;
        prev = c;
        i += 1;
      } else {
        if (frames.length === 0) spans.push([i + 1, close]);
        i = close + 1;
        while (/[a-z]/.test(text[i] ?? '')) i += 1;
        prev = '';
      }
    } else if (java && text.startsWith('"""', i) && textBlockEnd(text, i) >= 0) {
      const end = textBlockEnd(text, i);
      if (frames.length === 0) spans.push([i + 3, end - 3]);
      prev = '';
      i = end;
    } else if (c === "'" || c === '"') {
      const end = lineStringEnd(text, i, java);
      if (end < 0) {
        prev = c;
        i += 1;
      } else {
        const body = stringBody(text, i, end);
        if (frames.length === 0 && !BARE_NAME.test(text.slice(body[0], body[1]))) spans.push(body);
        prev = '';
        i = end;
      }
    } else if (c === '`') {
      if (frames.length === 0) templateOpen = i;
      frames.push(-1);
      i += 1;
    } else if (c === '{' || c === '}') {
      if (top === undefined && markup?.mode === 'expression') {
        markup.braces += c === '{' ? 1 : -1;
        if (markup.braces === 0) markup.mode = markup.resume;
      }
      if (top !== undefined) {
        frames[frames.length - 1] = top + (c === '{' ? 1 : -1);
        if (frames[frames.length - 1] === 0) frames.pop();
      }
      prev = c;
      i += 1;
    } else if (WORD_START.test(codePointAt(text, i))) {
      let end = i + codePointAt(text, i).length;
      while (end < text.length && WORD_CHAR.test(codePointAt(text, end))) {
        end += codePointAt(text, end).length;
      }
      const word = text.slice(i, end);
      if (word === 'async' || word === 'import' || word === 'export') sawAsync = true;
      const operandBefore: boolean = prev !== null && !regexMayStart(prev);
      if (prev === '.' || (prev === '#' && text[i - 1] === '#')) prev = '';
      else if (CONTEXTUAL_WORDS.has(word)) {
        const keyword: boolean =
          word === 'of'
            ? operandBefore
            : !operandBefore && (word === 'yield' ? sawGenerator : sawAsync);
        prev = keyword ? '/' : '';
      } else if (word === 'default' && prev === 'export') prev = ';';
      else prev = word;
      i = end;
    } else if (c >= '0' && c <= '9') {
      let end = i + 1;
      while (end < text.length && /[\w.]/.test(text[end]!)) end += 1;
      prev = '';
      i = end;
    } else if (c === '=' && next === '>') {
      prev = '=>';
      i += 2;
    } else if (c === '.' && next === '.' && text[i + 2] === '.') {
      prev = '...';
      i += 3;
    } else if ((c === '+' || c === '-') && next === c && prev !== null && !regexMayStart(prev)) {
      prev = '';
      i += 2;
    } else if (c === '!' && next !== '=' && prev !== null && !regexMayStart(prev)) {
      i += 1;
    } else {
      if (
        c === '*' &&
        (prev === 'function' || prev === null || ['{', '}', ',', ';'].includes(prev))
      ) {
        sawGenerator = true;
      }
      prev = c;
      i += 1;
    }
  }
  if (frames.length > 0) spans.push([templateOpen + 1, text.length]);
  return spans;
}

/** Lexical spans for the small brace/indentation readers. Rust raw strings and nested
 *  comments differ from Go; a Rust lifetime is deliberately not a character literal. */
function simpleNonCode(text: string, syntax: 'go' | 'rust' | 'python'): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((syntax === 'python' && c === '#') || (syntax !== 'python' && text.startsWith('//', i))) {
      const end = lineEnd(text, i, true);
      const to = end < 0 ? text.length : end;
      spans.push([i + (syntax === 'python' ? 1 : 0), to]);
      i = to;
    } else if (syntax !== 'python' && text.startsWith('/*', i)) {
      const from = i;
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (syntax === 'rust' && text.startsWith('/*', i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      spans.push([from, i]);
    } else if (syntax === 'rust' && (c === 'r' || (c === 'b' && text[i + 1] === 'r'))) {
      const raw = /^(?:b)?r(#{0,255})"/.exec(text.slice(i, i + 260));
      if (!raw) {
        i += 1;
        continue;
      }
      const close = text.indexOf('"' + raw[1]!, i + raw[0].length);
      const end = close < 0 ? text.length : close + 1 + raw[1]!.length;
      spans.push([i, end]);
      i = end;
    } else if (syntax === 'go' && c === '`') {
      const close = text.indexOf('`', i + 1);
      const end = close < 0 ? text.length : close + 1;
      spans.push([i, end]);
      i = end;
    } else if (c === '"' || c === "'") {
      const triple = syntax === 'python' && text.startsWith(c.repeat(3), i);
      let end: number;
      if (triple) {
        end = i + 3;
        while (end < text.length && !text.startsWith(c.repeat(3), end)) {
          end += text[end] === '\\' ? 2 : 1;
        }
        end = Math.min(text.length, end + 3);
      } else if (syntax === 'rust' && c === "'") {
        // One character (or an escape) followed immediately by a quote; otherwise this is 'a.
        const character =
          /^'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(
            text.slice(i, i + 32),
          );
        if (!character) {
          i += 1;
          continue;
        }
        end = i + character[0].length;
      } else end = quotedEnd(text, i);
      spans.push([i, end]);
      i = end;
    } else i += 1;
  }
  return spans;
}

/** `content` with the body of every comment and string blanked, so that a pattern or a brace count
 *  cannot match inside one: PHP loses its inline HTML and heredocs too, JS its template and regex
 *  literals. Same length and line ends. The established PHP/JS modes keep delimiters;
 *  Go/Rust and Python strings mask delimiters too; JSX text/tag masking is opt-in. */
export function maskNonCode(
  content: string,
  syntax: 'php' | 'js' | 'script' | 'module' | 'java' | 'go' | 'rust' | 'python',
  jsx: boolean | 'tsx' = false,
): string {
  let masked = '';
  let cursor = 0;
  for (const [from, to] of syntax === 'php'
    ? phpNonCode(content)
    : syntax === 'go' || syntax === 'rust' || syntax === 'python'
      ? simpleNonCode(content, syntax)
      : jsNonCode(content, syntax === 'java', syntax === 'script', syntax === 'module', jsx)) {
    masked +=
      content.slice(cursor, from) + content.slice(from, to).replace(/[^\r\n\u2028\u2029]/g, ' ');
    cursor = to;
  }
  return masked + content.slice(cursor);
}

/* ------------------------------------------------------------------ */
/* Code section extraction (regex fallback)                            */
/* ------------------------------------------------------------------ */

/** Index just past the '}' that closes the block opening at `start` (which must
 *  be a '{'), or null when it is not. An unclosed block runs to EOF — the
 *  section is still emitted whole rather than cut at an arbitrary offset. */
function braceBlockEnd(content: string, start: number): number | null {
  if (start < 0 || content[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

/** End offset of the brace block a match opens. Every pattern below ends AT its
 *  opening '{', so that brace is the last character of the match. */
function blockEndFromMatch(content: string, m: RegExpExecArray): number | null {
  const braceStart = content.indexOf('{', m.index + m[0].length - 1);
  return braceBlockEnd(content, braceStart);
}

/** A longer parameter list is not read as a signature: a '(' inside a string would otherwise
 *  send the scan to the end of the file from every call. */
const MAX_PARAMS_CHARS = 4000;

/** Index just past the ')' that closes the '(' at `open`, or null. A quoted string is skipped, so
 *  `advance("(")` does not leave a parenthesis open. */
function parenEnd(content: string, open: number): number | null {
  const limit = Math.min(content.length, open + MAX_PARAMS_CHARS);
  let depth = 0;
  for (let i = open; i < limit; i += 1) {
    const ch = content[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < limit && content[i] !== ch; i += 1) if (content[i] === '\\') i += 1;
    }
  }
  return null;
}

// An optional ': Type' that ends in a name, a bracket or a quote. A '{' after one of the excluded
// last characters opens a type literal, so such a signature is skipped rather than cut short. No
// parenthesis: after a call, ': function (a)' is the else branch of a ternary, not a return type.
const RETURN_TYPE = String.raw`(?::[^;{}=()]*[^\s;{}=:<,()|&?])?`;
const BLOCK_TAIL = new RegExp(String.raw`\s*${RETURN_TYPE}\s*\{`, 'y');
const ARROW_TAIL = new RegExp(String.raw`\s*${RETURN_TYPE}\s*=>\s*\{`, 'y');

/** Index of the '{' that opens the body of the function whose parameter list opens at `open`, with
 *  `tail` saying what may sit between the list and the brace. Null for a declaration with no body. */
function bodyAfterParams(content: string, open: number, tail: RegExp): number | null {
  const close = parenEnd(content, open);
  if (close === null) return null;
  tail.lastIndex = close;
  const m = tail.exec(content);
  return m ? close + m[0].length - 1 : null;
}

// A docblock attaches to the construct it is directly followed by. '/**/' opens nothing.
const PHP_FUNCTION_HEAD = String.raw`(\/\*\*(?!\/)(?:(?!\*\/)[\s\S])*\*\/\s*)?(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?\s*(${PHP_LABEL})\s*\(`;

function phpRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const code = maskNonCode(content, 'php');

  // File docblock
  const docMatch = /^<\?php\s*(\/\*\*[\s\S]*?\*\/)/.exec(content);
  if (docMatch) {
    const start = content.indexOf(docMatch[1]!);
    ranges.push({
      sectionId: 'file-docblock',
      start,
      end: start + docMatch[1]!.length,
      breadcrumb: [],
    });
  }

  // Class extents are NOT emitted as sections of their own — that would
  // duplicate every method inside them. They exist only to name the method that
  // sits within, so a chunk can say which class it belongs to.
  const classes: Array<{ name?: string; kind: string; start: number; end: number }> = [];
  // An anonymous class is an owner boundary too, but contributes no invented name.
  const classRe = new RegExp(
    String.raw`\b(class|trait|interface|enum)\b(?:\s+(${PHP_LABEL}))?[^{};]*\{`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) {
      const name = match[2];
      classes.push({
        name: name && !/^(?:extends|implements)$/i.test(name) ? name : undefined,
        kind: match[1]!.toLowerCase(),
        start: match.index,
        end,
      });
    }
  }

  // Functions (standalone and methods)
  const fileDoc = ranges.find((r) => r.sectionId === 'file-docblock');
  const funcRe = new RegExp(PHP_FUNCTION_HEAD, 'gi');
  while ((match = funcRe.exec(code)) !== null) {
    const brace = bodyAfterParams(code, match.index + match[0].length - 1, BLOCK_TAIL);
    // Interface methods have signatures ending at ';', without a body.
    const close = parenEnd(code, match.index + match[0].length - 1);
    const declaration = close === null ? null : new RegExp(String.raw`\s*${RETURN_TYPE}\s*;`, 'y');
    if (declaration && close !== null) declaration.lastIndex = close;
    const signature = declaration?.exec(code);
    const end =
      brace !== null
        ? braceBlockEnd(code, brace)
        : signature && close !== null
          ? close + signature[0].length
          : null;
    if (end === null) continue;
    const name = match[2]!;
    // The file docblock stays its own section even when the function follows it directly.
    const start = match.index === fileDoc?.start ? match.index + match[1]!.length : match.index;
    const owner = classes
      .filter((c) => start > c.start && end <= c.end)
      .sort((a, b) => b.start - a.start)[0];
    if (brace === null && owner?.kind !== 'interface') continue;
    ranges.push({
      sectionId: owner?.name ? `method-${owner.name}-${name}` : `function-${name}`,
      start,
      end,
      breadcrumb: owner?.name
        ? [`${owner.kind} ${owner.name}`, `function ${name}`]
        : [`function ${name}`],
    });
  }

  return ranges;
}

const JS_NAME = String.raw`[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*`;
const JS_GENERICS = String.raw`(?:<[^(){};]*>\s*)?`;
const JS_MEMBER_START = String.raw`(?:^|(?<=[{,;}]))[ \t]*`;
// A member key: a name, bare or in matching quotes. Any other quoted key ("my-key") is not read.
const JS_KEY = String.raw`(?:"(?=${JS_NAME}"\s*:)|'(?=${JS_NAME}'\s*:)|(?=${JS_NAME}\s*:))(${JS_NAME})["']?`;
const JS_CONTROL_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'with',
]);

// After '=>', '{ key: Type' is an object type, not a function body.
const TYPE_MEMBER = /\s*(?:readonly\s+)?(?:[A-Za-z_$][\w$]*|'[^'\n]*'|"[^"\n]*")\s*\??\s*:/y;

// Every pattern captures the name first and ends at the '(' of the parameter list, or at the '{' of
// an arrow with one bare parameter. The last three read a member of an object literal or a class.
const JS_FORMS: Array<{ source: string; arrow: boolean; member: boolean }> = [
  {
    // function [*] name(...) {
    source: String.raw`function(?:\s*\*\s*|\s+)(${JS_NAME})\s*${JS_GENERICS}\(`,
    arrow: false,
    member: false,
  },
  {
    // const|let|var name[: Type] = [async] (...) => {
    source: String.raw`(?:const|let|var)\s+(${JS_NAME})\s*(?::[^=;{}\n]+)?=\s*(?:async\s+)?${JS_GENERICS}(?:\(|${JS_NAME}\s*=>\s*\{)`,
    arrow: true,
    member: false,
  },
  {
    // [modifiers] name(...) {
    source: String.raw`${JS_MEMBER_START}(?:(?:static|async|get|set|public|private|protected|readonly|abstract|override)\s+)*(?:\*\s*)?(${JS_NAME})\s*${JS_GENERICS}\(`,
    arrow: false,
    member: true,
  },
  {
    // name: [async] function [*] [id](...) {
    source: String.raw`${JS_MEMBER_START}${JS_KEY}\s*:\s*(?:async\s+)?function\b\s*\*?\s*(?:${JS_NAME}\s*)?${JS_GENERICS}\(`,
    arrow: false,
    member: true,
  },
  {
    // name: [async] (...) => {
    source: String.raw`${JS_MEMBER_START}${JS_KEY}\s*:\s*(?:async\s+)?${JS_GENERICS}(?:\(|${JS_NAME}\s*=>\s*\{)`,
    arrow: true,
    member: true,
  },
];

const DECLARATION_PREFIX = /(?:\b(?:export|default|async|declare|abstract)[ \t]+)+$/;
const LINE_COMMENT = /[ \t]*\/\//y;

function lineCommentAt(content: string, lineStart: number): number {
  LINE_COMMENT.lastIndex = lineStart;
  const m = LINE_COMMENT.exec(content);
  return m ? lineStart + m[0].length - 2 : -1;
}

/** Start of the comment run directly above the construct at `start` (consecutive `//` lines, or one block
 *  that opens its line), or `start`. The run that opens the file is its header and stays out. */
function commentRunStart(content: string, start: number, headerAt: number): number {
  const prefix = DECLARATION_PREFIX.exec(content.slice(Math.max(0, start - 64), start));
  let end = start - (prefix ? prefix[0].length : 0);
  while (end > 0 && /\s/.test(content[end - 1]!)) end -= 1;

  let runStart = -1;
  if (end >= 2 && content.startsWith('*/', end - 2)) {
    const open = content.lastIndexOf('/*', end - 2);
    if (open >= 0 && content.indexOf('*/', open + 2) === end - 2) {
      const before = content.slice(lineStartAt(content, open), open);
      if (before.trim() === '') runStart = open;
    }
  } else if (end > 0) {
    let lineAt = lineStartAt(content, end);
    runStart = lineCommentAt(content, lineAt);
    while (runStart >= 0 && lineAt >= 2) {
      const prevAt = lineStartAt(
        content,
        lineAt - (content[lineAt - 2] === '\r' && content[lineAt - 1] === '\n' ? 2 : 1),
      );
      const prev = lineCommentAt(content, prevAt);
      if (prev < 0) break;
      runStart = prev;
      lineAt = prevAt;
    }
  }
  return runStart < 0 || runStart === headerAt ? start : runStart;
}

function jsRanges(
  content: string,
  members: boolean,
  flavour: 'js' | 'script' | 'module' = 'js',
  jsx: boolean | 'tsx' = members,
): SectionRange[] {
  const ranges: SectionRange[] = [];
  const code = maskNonCode(content, members ? flavour : 'java', jsx);
  let match: RegExpExecArray | null;
  const headerAt = content.search(/\S/);
  // Java shares this reader but is read as before: no members, no comment join.
  const withComments = (start: number): number =>
    members ? commentRunStart(content, start, headerAt) : start;

  // Classes. Their extents also name the class a member sits in.
  const classes: Array<{ name: string; start: number; end: number }> = [];
  const classRe = new RegExp(
    String.raw`\bclass\s+(${JS_NAME})(?:\s+extends\s+${JS_NAME})?\s*\{`,
    'gu',
  );
  while ((match = classRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) {
      classes.push({ name: match[1]!, start: match.index, end });
      ranges.push({
        sectionId: `class-${match[1]!}`,
        start: match.index,
        commentStart: withComments(match.index),
        end,
        breadcrumb: [`class ${match[1]!}`],
      });
    }
  }

  for (const { source, arrow, member } of JS_FORMS) {
    if (member && !members) continue;
    const formRe = new RegExp(source, 'gmu');
    while ((match = formRe.exec(code)) !== null) {
      const name = match[1]!;
      if (JS_CONTROL_NAMES.has(name)) continue;
      const last = match.index + match[0].length - 1;
      const brace =
        code[last] === '{' ? last : bodyAfterParams(code, last, arrow ? ARROW_TAIL : BLOCK_TAIL);
      if (brace === null) continue;
      if (arrow) {
        TYPE_MEMBER.lastIndex = brace + 1;
        if (TYPE_MEMBER.test(code)) continue;
      }
      const end = braceBlockEnd(code, brace);
      if (end === null) continue;
      const start = match.index + match[0].search(/\S/);
      const owner = member ? classes.find((c) => start > c.start && end <= c.end) : undefined;
      ranges.push({
        sectionId: `function-${name}`,
        start,
        commentStart: withComments(start),
        end,
        breadcrumb: owner ? [`class ${owner.name}`, `function ${name}`] : [`function ${name}`],
      });
    }
  }

  return ranges;
}

const RUBY_END = /^end\b/;
const RUBY_CLAUSE = /^(?:rescue|ensure|else)\b/;

function pythonRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const { lines: codeLines, offsets } = sourceLines(maskNonCode(content, 'python'));
  const defRe = /^([ \t]*)(?:async[ \t]+)?(def|class)[ \t]+(\w+)/;
  let i = 0;
  while (i < codeLines.length) {
    const m = defRe.exec(codeLines[i]!);
    if (!m) {
      i += 1;
      continue;
    }
    const indent = m[1]!.length;
    const kind = m[2] === 'class' ? 'class' : 'function';
    const name = m[3]!;
    const startLine = i++;
    while (i < codeLines.length) {
      const line = codeLines[i]!;
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      i += 1;
    }
    ranges.push({
      sectionId: `${kind}-${name}`,
      start: offsets[startLine]!,
      end: offsets[i] ?? content.length,
      breadcrumb: [`${kind} ${name}`],
    });
  }
  return ranges;
}

/** Ruby names allow extended bytes and optional method punctuation. */
const RUBY_NAME_START = /[A-Za-z_\u0080-\uFFFF]/;
const RUBY_NAME_CHAR = /[\w\u0080-\uFFFF]/;
const RUBY_PREFIX_OPERATORS = new Set(['not', 'and', 'or', 'defined?']);

/** End of an endless expression: completed tokens stop at a top-level newline,
 *  while operators require another value. Literal bodies cannot change depth. */
function rubyExpressionEnd(content: string, from: number): number {
  let depth = 0;
  let continues = false;
  let operandExpected = true;
  let qualifiedName = false;
  for (let i = from; i < content.length; i += 1) {
    const c = content[i]!;
    if (c === '"' || c === "'") {
      i = quotedEnd(content, i) - 1;
      continues = false;
      operandExpected = false;
      qualifiedName = false;
    } else if (RUBY_NAME_START.test(c)) {
      const start = i;
      while (i + 1 < content.length && RUBY_NAME_CHAR.test(content[i + 1]!)) i += 1;
      const suffix = content[i + 1];
      if (suffix === '?' || (suffix === '!' && !['=', '~'].includes(content[i + 2] ?? ''))) i += 1;
      const word = content.slice(start, i + 1);
      continues = !qualifiedName && RUBY_PREFIX_OPERATORS.has(word);
      operandExpected = continues;
      qualifiedName = false;
    } else if (c === '/' && operandExpected) {
      const close = regexClose(content, i, true, true);
      if (close >= 0) {
        i = close;
        while (/[imoxnesu]/.test(content[i + 1] ?? '')) i += 1;
        continues = false;
        operandExpected = false;
      } else {
        continues = true;
        operandExpected = true;
      }
      qualifiedName = false;
    } else if (c === '#') {
      const end = lineEnd(content, i, true);
      i = (end < 0 ? content.length : end) - 1;
    } else if (isLineTerminator(c, true)) {
      if (depth === 0 && !continues) return i + (c === '\r' && content[i + 1] === '\n' ? 2 : 1);
    } else if ('([{'.includes(c)) {
      depth += 1;
      continues = false;
      operandExpected = true;
      qualifiedName = false;
    } else if (')]}'.includes(c)) {
      depth = Math.max(0, depth - 1);
      continues = false;
      operandExpected = false;
      qualifiedName = false;
    } else if (c === '.' || c === ':' || c === '@' || c === '$') {
      qualifiedName = true;
      continues = c === '.' || c === ':';
      operandExpected = c !== '.';
    } else if (!/\s/.test(c)) {
      continues = /[-+*/%&|^,?=<>!~\\]/.test(c);
      operandExpected = continues;
      qualifiedName = false;
    }
  }
  return content.length;
}

/** Ruby's module is ancestry, while classes keep their established whole-class section.
 *  Indentation bounds these heuristic ranges; an endless def has no closing end of its own. */
function rubyRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const { lines, offsets } = sourceLines(content);
  const modules: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    if (
      RUBY_END.test(line.trim()) &&
      modules.length &&
      indent <= modules[modules.length - 1]!.indent
    ) {
      modules.pop();
      i += 1;
      continue;
    }
    const module = /^[ \t]*module[ \t]+([\w:]+)/.exec(line);
    if (module) {
      modules.push({ indent, name: module[1]! });
      i += 1;
      continue;
    }
    const m = /^[ \t]*(def|class)[ \t]+((?:self\.)?\w+[!?=]?)/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const kind = m[1] === 'class' ? 'class' : 'function';
    const name = m[2]!;
    const tail = line.slice(m[0].length).trimStart();
    const close = tail.startsWith('(') ? parenEnd(tail, 0) : 0;
    const endless = kind === 'function' && close !== null && /^\s*=(?!=|>)/.test(tail.slice(close));
    const startLine = i++;
    if (endless) {
      const expressionStart =
        offsets[startLine]! +
        line.length -
        tail.length +
        close! +
        tail.slice(close!).indexOf('=') +
        1;
      const end = rubyExpressionEnd(content, expressionStart);
      while (i < lines.length && offsets[i]! < end) i += 1;
    }
    while (!endless && i < lines.length) {
      const body = lines[i]!;
      if (!body.trim()) {
        i += 1;
        continue;
      }
      const bodyIndent = body.length - body.trimStart().length;
      const clause = !endless && bodyIndent === indent && RUBY_CLAUSE.test(body.trim());
      if (bodyIndent <= indent && !clause) break;
      i += 1;
    }
    if (
      !endless &&
      lines[i] !== undefined &&
      RUBY_END.test(lines[i]!.trim()) &&
      lines[i]!.length - lines[i]!.trimStart().length === indent
    )
      i += 1;
    ranges.push({
      sectionId: `${kind}-${name}`,
      start: offsets[startLine]!,
      end: offsets[i] ?? content.length,
      breadcrumb: [...modules.map((owner) => `module ${owner.name}`), `${kind} ${name}`],
    });
  }
  return ranges;
}

function goRanges(content: string): SectionRange[] {
  const code = maskNonCode(content, 'go');
  const ranges: SectionRange[] = [];
  const funcRe = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\([^)]*\)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) {
      ranges.push({
        sectionId: `function-${match[1]!}`,
        start: match.index,
        end,
        breadcrumb: [`function ${match[1]!}`],
      });
    }
  }
  return ranges;
}

function rustRanges(content: string): SectionRange[] {
  const code = maskNonCode(content, 'rust');
  const ranges: SectionRange[] = [];
  let match: RegExpExecArray | null;

  const fnRe = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{/g;
  while ((match = fnRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) {
      ranges.push({
        sectionId: `function-${match[1]!}`,
        start: match.index,
        end,
        breadcrumb: [`function ${match[1]!}`],
      });
    }
  }

  const implRe = /impl\s+(?:<[^>]*>\s+)?(\w+)(?:\s+for\s+\w+)?\s*\{/g;
  while ((match = implRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) {
      ranges.push({
        sectionId: `impl-${match[1]!}`,
        start: match.index,
        end,
        breadcrumb: [`impl ${match[1]!}`],
      });
    }
  }

  return ranges;
}

/** Turn matched ranges into a section list that COVERS the whole file: matched
 *  constructs keep their own ids, and every span between them is emitted as a
 *  `chunk-<n>` gap section. This is what stops a file whose regexes matched
 *  nothing (73% of legacy .js in the measured index) from being cut at a fixed
 *  offset — such a file is simply one big gap section that `chunkSection` splits
 *  normally.
 *
 *  A range that strictly contains another is dropped in favour of the finer one,
 *  so a class yields its methods rather than one duplicate copy of both.
 *
 *  A short span joins the section before it when it continues that section's last
 *  line, holds no word character or ends the file, else the section after it, bar
 *  the closing lines it starts with, which stay with the section they close. */
export function assembleSections(content: string, ranges: SectionRange[]): RagSection[] {
  const kept = ranges.filter(
    (r) =>
      !ranges.some(
        (s) =>
          s !== r && s.start >= r.start && s.end <= r.end && (s.start > r.start || s.end < r.end),
      ),
  );
  kept.sort((a, b) => a.start - b.start || a.end - b.end);

  const slices: Array<{ sectionId: string; breadcrumb: string[]; from: number; to: number }> = [];
  let cursor = 0;
  let gapIndex = 0;

  const placeGap = (from: number, to: number, hasNext: boolean): number => {
    const text = content.slice(from, to);
    const length = text.trim().length;
    if (length === 0) return to;
    if (length >= MIN_GAP_CHARS) {
      slices.push({ sectionId: `chunk-${gapIndex}`, breadcrumb: [], from, to });
      gapIndex += 1;
      return to;
    }
    const previous = slices[slices.length - 1];
    const continuesLine =
      !isLineTerminator(content[from - 1] ?? '', false) &&
      !/^[ \t]*(?:\r\n|[\r\n\u2028\u2029])/.test(text);
    if (previous && (!hasNext || continuesLine || !/[\p{L}\p{N}_]/u.test(text))) {
      previous.to = from + text.trimEnd().length;
      return to;
    }
    const closing = previous ? CLOSING_LINES.exec(text)![0] : '';
    if (previous && closing.trim() !== '') previous.to = from + closing.trimEnd().length;
    return from + text.length - text.slice(closing.length).trimStart().length;
  };

  for (const r of kept) {
    // A comment run that reaches back into the previous section stays out of this one.
    const from =
      r.commentStart !== undefined && r.commentStart >= cursor ? r.commentStart : r.start;
    // Partial overlaps (a regex that ran past its construct) would double-index
    // the shared bytes; skip the later range rather than emit them twice.
    if (from < cursor) continue;
    const start = placeGap(cursor, from, true);
    slices.push({
      sectionId: safeSectionId(r.sectionId),
      breadcrumb: r.breadcrumb,
      from: start,
      to: r.end,
    });
    cursor = r.end;
  }
  placeGap(cursor, content.length, false);

  return uniqueSectionIds(
    slices.map(({ sectionId, breadcrumb, from, to }) => ({
      sectionId,
      content: content.slice(from, to),
      breadcrumb,
    })),
  );
}

export function extractCodeSections(content: string, filePath: string): RagSection[] {
  const ext = path.extname(filePath).toLowerCase();
  const lang = CODE_EXTENSIONS[ext];
  let ranges: SectionRange[];
  switch (lang) {
    case 'php':
      ranges = phpRanges(content);
      break;
    case 'javascript':
    case 'typescript':
    case 'tsx':
    case 'java':
      // Java shares this reader, but its constructors and synchronized blocks are not object members.
      // .js/.cjs are scripts (Annex B `<!--` comments); .mjs is a module (top-level await).
      // Vue/Svelte keep their existing script reader: the whole file is not JSX.
      ranges = jsRanges(
        content,
        lang !== 'java',
        ext === '.js' || ext === '.cjs' ? 'script' : ext === '.mjs' ? 'module' : 'js',
        ext === '.tsx' ? 'tsx' : JSX_EXTENSIONS.has(ext),
      );
      break;
    case 'python':
      ranges = pythonRanges(content);
      break;
    case 'ruby':
      ranges = rubyRanges(content);
      break;
    case 'go':
      ranges = goRanges(content);
      break;
    case 'rust':
      ranges = rustRanges(content);
      break;
    default:
      ranges = [];
  }
  return assembleSections(content, ranges);
}

/* ------------------------------------------------------------------ */
/* Section → chunks                                                    */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_SIZE = 2000;
const DEFAULT_OVERLAP = 200;

export interface ChunkOptions {
  /** Context line prepended to EVERY chunk, e.g.
   *  "modules/foo/foo.module > class Foo > function bar". Omitting it produces
   *  output byte-identical to the header-less form. */
  header?: string;
  maxSize?: number;
  overlap?: number;
}

export function chunkSection(section: RagSection, opts: ChunkOptions = {}): RagChunk[] {
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;
  // The header rides INSIDE content: it is what the agent reads in a hit, and it
  // is indexed into content_tsv, so the lexical half of the RRF fusion can match
  // a heading or path term the body itself never spells out.
  const header = opts.header ? `[${opts.header}]\n\n` : '';
  const trimmed = section.content.trim();
  if (trimmed.length === 0) return [];

  const emit = (body: string, chunkIndex: number): RagChunk => {
    const content = header + body;
    return {
      sectionId: section.sectionId,
      chunkIndex,
      content,
      chunkHash: computeChunkHash(content),
    };
  };

  if (trimmed.length <= maxSize) {
    return [emit(trimmed, 0)];
  }

  const chunks: RagChunk[] = [];
  const lineBreaks: Span[] = [];
  const paragraphBreaks: Span[] = [];
  let previous: Span | undefined;
  for (const match of trimmed.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
    const span: Span = [match.index, match.index + match[0].length];
    lineBreaks.push(span);
    if (previous?.[1] === span[0]) paragraphBreaks.push([previous[0], span[1]]);
    previous = span;
  }
  const lastBreak = (breaks: Span[], limit: number): Span | undefined => {
    let lo = 0;
    let hi = breaks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (breaks[mid]![0] <= limit) lo = mid + 1;
      else hi = mid;
    }
    return breaks[lo - 1];
  };
  let start = 0;
  let idx = 0;
  while (start < trimmed.length) {
    const end = Math.min(trimmed.length, start + maxSize);
    let splitAt = end;
    // Prefer splitting at paragraph break
    if (end < trimmed.length) {
      const paragraph = lastBreak(paragraphBreaks, end);
      const line = lastBreak(lineBreaks, end);
      if (paragraph && paragraph[0] > start + maxSize / 2) splitAt = paragraph[1];
      else if (line && line[0] > start + maxSize / 2) splitAt = line[1];
      else {
        const sentBreak = trimmed.lastIndexOf('. ', end);
        if (sentBreak > start + maxSize / 2) splitAt = sentBreak + 2;
      }
      // Never put half of a CRLF on either side of a cut.
      if (trimmed[splitAt - 1] === '\r' && trimmed[splitAt] === '\n') splitAt -= 1;
    }

    chunks.push(emit(trimmed.slice(start, splitAt), idx));
    idx += 1;

    if (splitAt >= trimmed.length) break;
    // Step back by `overlap`, but never to or before the current start. The old
    // guard compared an absolute offset against a chunk LENGTH, which silently
    // dropped the overlap on the first chunk and only avoided looping by luck.
    // Multi-chunk sections are the norm now, so the guard has to actually hold.
    start = Math.max(splitAt - overlap, start + 1);
    if (trimmed[start - 1] === '\r' && trimmed[start] === '\n') start += 1;
  }

  return chunks;
}

/* ------------------------------------------------------------------ */
/* Per-file budget                                                     */
/* ------------------------------------------------------------------ */

/** Context header for a chunk: the source root (a repo-relative path, or a
 *  global KB entry's title — never that store's synthetic filename) followed by
 *  the section's structural ancestry. */
export function contextHeader(root: string, breadcrumb: string[]): string {
  const parts = [root, ...breadcrumb];
  // A global KB entry's H1 is usually its title verbatim, which would render as
  // "[Foo > Foo]" — no signal, and it eats the one context line a chunk gets.
  // Collapse any consecutive repeat rather than only the title/H1 pair.
  return parts.filter((p, i) => i === 0 || p !== parts[i - 1]).join(' > ');
}

export interface CappedChunks {
  chunks: RagChunk[];
  /** Chunks dropped by the per-file budget. Non-zero obliges the caller to log
   *  it: a silent cap is indistinguishable from full coverage. */
  dropped: number;
}

export function capChunks(chunks: RagChunk[], max = MAX_CHUNKS_PER_FILE): CappedChunks {
  if (chunks.length <= max) return { chunks, dropped: 0 };
  return { chunks: chunks.slice(0, max), dropped: chunks.length - max };
}
