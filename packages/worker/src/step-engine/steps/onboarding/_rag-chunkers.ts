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
const CLOSING_LINES = /^(?:[ \t]*(?:[)\]};,]+[ \t]*)?\r?\n)*/;

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
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
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
  const lines = content.split('\n');
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
  let currentLines: string[] = [];

  const flush = (): void => {
    const text = currentLines.join('\n').trim();
    if (!text) return;
    const section = { sectionId: currentId, content: text, breadcrumb: currentBreadcrumb };
    if (isHeadingOnlyMarkdown(text)) headingOnly.push(section);
    else sections.push(section);
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      const title = m[2]!.trim();
      stack[level - 1] = title;
      for (let deeper = level; deeper < stack.length; deeper += 1) stack[deeper] = undefined;
      currentId = safeSectionId(slugifyHeading(title));
      currentBreadcrumb = stack.slice(0, level).filter((s): s is string => !!s);
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  flush();

  return uniqueSectionIds(sections.length > 0 ? sections : headingOnly);
}

/* ------------------------------------------------------------------ */
/* Comment and string masking                                          */
/* ------------------------------------------------------------------ */

type Span = [from: number, to: number];

const PHP_OPEN_TAG = /<\?(?:php(?=\s|$)|=|(?=\s))/gi;
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
const BARE_NAME = /^[A-Za-z_$][\w$]*$/;
const WORD_START = /[\p{ID_Start}_$]/u;
const WORD_CHAR = /[\p{ID_Continue}$\u200C\u200D]/u;

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

/** Index of the first line terminator at or after `from`, else -1. */
function lineEnd(text: string, from: number, lfCrOnly: boolean): number {
  for (let i = from; i < text.length; i += 1) if (isLineTerminator(text[i]!, lfCrOnly)) return i;
  return -1;
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

/** Index of the '/' that closes the regex literal opening at `open`, or -1 when its line ends first. */
function regexClose(text: string, open: number, java: boolean): number {
  let inClass = false;
  const limit = Math.min(text.length, open + MAX_REGEX_CHARS);
  for (let i = open + 1; i < limit; i += 1) {
    if (isLineTerminator(text[i]!, java)) return -1;
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
  if (WORD_START.test(prev[0] ?? '')) return REGEX_AFTER_WORD.test(prev);
  return prev !== '' && ![')', ']', '}', '>', '<', '.'].includes(prev);
}

/** The spans of a JS, TS or Java file that are not code: comments, strings, template literals (their
 *  `${}` expressions too) and regex literals. A string that is a bare name stays: it may be a key. */
function jsNonCode(text: string, java: boolean): Span[] {
  const spans: Span[] = [];
  // The open template literals and `${` expressions, innermost last: -1 is template text, n >= 1
  // the braces open in an expression. Spans are recorded for the outermost template only.
  const frames: number[] = [];
  let templateOpen = 0;
  let prev: string | null = null;
  let regexMisses = 0;
  let strayTicks = 0;
  let sawGenerator = false;
  let sawAsync = false;
  let i = 0;
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
      const mayStart = regexMayStart(prev);
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
      if (top !== undefined) {
        frames[frames.length - 1] = top + (c === '{' ? 1 : -1);
        if (frames[frames.length - 1] === 0) frames.pop();
      }
      prev = c;
      i += 1;
    } else if (WORD_START.test(c)) {
      let end = i + 1;
      while (end < text.length && WORD_CHAR.test(text[end]!)) end += 1;
      const word = text.slice(i, end);
      if (word === 'async' || word === 'import' || word === 'export') sawAsync = true;
      const operandBefore: boolean = prev !== null && !regexMayStart(prev);
      if (prev === '.') prev = '';
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

/** `content` with the body of every comment and string blanked, so that a pattern or a brace count
 *  cannot match inside one: PHP loses its inline HTML and heredocs too, JS its template and regex
 *  literals. Same length and line ends; the delimiters stay. */
export function maskNonCode(content: string, syntax: 'php' | 'js' | 'java'): string {
  let masked = '';
  let cursor = 0;
  for (const [from, to] of syntax === 'php'
    ? phpNonCode(content)
    : jsNonCode(content, syntax === 'java')) {
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
const PHP_FUNCTION_HEAD = String.raw`(\/\*\*(?!\/)(?:(?!\*\/)[\s\S])*\*\/\s*)?(?:(?:public|protected|private|static|abstract|final)\s+)*function\s+&?\s*(\w+)\s*\(`;

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
  const classes: Array<{ name: string; start: number; end: number }> = [];
  const classRe = /class\s+(\w+)[^{;]*\{/gi;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(code)) !== null) {
    const end = blockEndFromMatch(code, match);
    if (end !== null) classes.push({ name: match[1]!, start: match.index, end });
  }

  // Functions (standalone and methods)
  const fileDoc = ranges.find((r) => r.sectionId === 'file-docblock');
  const funcRe = new RegExp(PHP_FUNCTION_HEAD, 'gi');
  while ((match = funcRe.exec(code)) !== null) {
    const brace = bodyAfterParams(code, match.index + match[0].length - 1, BLOCK_TAIL);
    const end = brace === null ? null : braceBlockEnd(code, brace);
    if (end === null) continue;
    const name = match[2]!;
    // The file docblock stays its own section even when the function follows it directly.
    const start = match.index === fileDoc?.start ? match.index + match[1]!.length : match.index;
    const owner = classes.find((c) => start > c.start && end <= c.end);
    ranges.push({
      sectionId: owner ? `method-${owner.name}-${name}` : `function-${name}`,
      start,
      end,
      breadcrumb: owner ? [`class ${owner.name}`, `function ${name}`] : [`function ${name}`],
    });
  }

  return ranges;
}

const JS_NAME = String.raw`[A-Za-z_$][\w$]*`;
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
      const before = content.slice(content.lastIndexOf('\n', open - 1) + 1, open);
      if (before.trim() === '') runStart = open;
    }
  } else if (end > 0) {
    let lineAt = content.lastIndexOf('\n', end - 1) + 1;
    runStart = lineCommentAt(content, lineAt);
    while (runStart >= 0 && lineAt >= 2) {
      const prevAt = content.lastIndexOf('\n', lineAt - 2) + 1;
      const prev = lineCommentAt(content, prevAt);
      if (prev < 0) break;
      runStart = prev;
      lineAt = prevAt;
    }
  }
  return runStart < 0 || runStart === headerAt ? start : runStart;
}

function jsRanges(content: string, members: boolean): SectionRange[] {
  const ranges: SectionRange[] = [];
  const code = maskNonCode(content, members ? 'js' : 'java');
  let match: RegExpExecArray | null;
  const headerAt = content.search(/\S/);
  // Java shares this reader but is read as before: no members, no comment join.
  const withComments = (start: number): number =>
    members ? commentRunStart(content, start, headerAt) : start;

  // Classes. Their extents also name the class a member sits in.
  const classes: Array<{ name: string; start: number; end: number }> = [];
  const classRe = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
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
    const formRe = new RegExp(source, 'gm');
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

function pythonRanges(content: string, ruby = false): SectionRange[] {
  const ranges: SectionRange[] = [];
  const lines = content.split('\n');

  // Offset of each line start, so the line-based scan can report file offsets.
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }

  const defRe = /^(\s*)(def|class)\s+(\w+)/;
  let i = 0;
  while (i < lines.length) {
    const m = defRe.exec(lines[i]!);
    if (m) {
      const indent = m[1]!.length;
      const kind = m[2] === 'class' ? 'class' : 'function';
      const name = m[3]!;
      const startLine = i;
      i += 1;
      // Collect lines with greater indentation (body)
      while (i < lines.length) {
        const line = lines[i]!;
        if (line.trim() === '') {
          i += 1;
          continue;
        }
        const lineIndent = line.length - line.trimStart().length;
        // A Ruby method's own rescue, else and ensure stand at the indentation of its `def`.
        const clause = ruby && lineIndent === indent && RUBY_CLAUSE.test(line.trim());
        if (lineIndent <= indent && !clause) break;
        i += 1;
      }
      // A Ruby definition owns its `end` line.
      const next = lines[i];
      if (ruby && next !== undefined && RUBY_END.test(next.trim())) {
        if (next.length - next.trimStart().length === indent) i += 1;
      }
      ranges.push({
        sectionId: `${kind}-${name}`,
        start: offsets[startLine]!,
        end: i < lines.length ? offsets[i]! : content.length,
        breadcrumb: [`${kind} ${name}`],
      });
    } else {
      i += 1;
    }
  }

  return ranges;
}

function goRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  const funcRe = /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\([^)]*\)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
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
  const ranges: SectionRange[] = [];
  let match: RegExpExecArray | null;

  const fnRe = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{/g;
  while ((match = fnRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
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
  while ((match = implRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
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
    const continuesLine = content[from - 1] !== '\n' && !/^\s*\n/.test(text);
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
      ranges = jsRanges(content, lang !== 'java');
      break;
    case 'python':
      ranges = pythonRanges(content);
      break;
    case 'ruby':
      ranges = pythonRanges(content, true);
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
  let start = 0;
  let idx = 0;
  while (start < trimmed.length) {
    const end = Math.min(trimmed.length, start + maxSize);
    let splitAt = end;
    // Prefer splitting at paragraph break
    if (end < trimmed.length) {
      const paraBreak = trimmed.lastIndexOf('\n\n', end);
      if (paraBreak > start + maxSize / 2) {
        splitAt = paraBreak + 2;
      } else {
        const lineBreak = trimmed.lastIndexOf('\n', end);
        if (lineBreak > start + maxSize / 2) {
          splitAt = lineBreak + 1;
        } else {
          // Try sentence break
          const sentBreak = trimmed.lastIndexOf('. ', end);
          if (sentBreak > start + maxSize / 2) {
            splitAt = sentBreak + 2;
          }
        }
      }
    }

    chunks.push(emit(trimmed.slice(start, splitAt), idx));
    idx += 1;

    if (splitAt >= trimmed.length) break;
    // Step back by `overlap`, but never to or before the current start. The old
    // guard compared an absolute offset against a chunk LENGTH, which silently
    // dropped the overlap on the first chunk and only avoided looping by luck.
    // Multi-chunk sections are the norm now, so the guard has to actually hold.
    start = Math.max(splitAt - overlap, start + 1);
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
