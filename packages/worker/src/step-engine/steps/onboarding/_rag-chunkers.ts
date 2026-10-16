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
  const classRe = /class\s+(\w+)[^{;]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) classes.push({ name: match[1]!, start: match.index, end });
  }

  // Functions (standalone and methods)
  const fileDoc = ranges.find((r) => r.sectionId === 'file-docblock');
  const funcRe = new RegExp(PHP_FUNCTION_HEAD, 'gi');
  while ((match = funcRe.exec(content)) !== null) {
    const brace = bodyAfterParams(content, match.index + match[0].length - 1, BLOCK_TAIL);
    const end = brace === null ? null : braceBlockEnd(content, brace);
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
  let match: RegExpExecArray | null;
  const headerAt = content.search(/\S/);
  // Java shares this reader but is read as before: no members, no comment join.
  const withComments = (start: number): number =>
    members ? commentRunStart(content, start, headerAt) : start;

  // Classes. Their extents also name the class a member sits in.
  const classes: Array<{ name: string; start: number; end: number }> = [];
  const classRe = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
  while ((match = classRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
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
    while ((match = formRe.exec(content)) !== null) {
      const name = match[1]!;
      if (JS_CONTROL_NAMES.has(name)) continue;
      const last = match.index + match[0].length - 1;
      const brace =
        content[last] === '{'
          ? last
          : bodyAfterParams(content, last, arrow ? ARROW_TAIL : BLOCK_TAIL);
      if (brace === null) continue;
      if (arrow) {
        TYPE_MEMBER.lastIndex = brace + 1;
        if (TYPE_MEMBER.test(content)) continue;
      }
      const end = braceBlockEnd(content, brace);
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

function pythonRanges(content: string): SectionRange[] {
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
        if (lineIndent <= indent) break;
        i += 1;
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
 *  line, holds no word character or ends the file, else the section after it. */
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
    return from + text.length - text.trimStart().length;
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
    case 'ruby':
      ranges = pythonRanges(content);
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
