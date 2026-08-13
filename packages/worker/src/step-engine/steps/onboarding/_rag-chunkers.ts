import { createHash } from 'node:crypto';
import path from 'node:path';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface RagSection {
  sectionId: string;
  content: string;
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
  end: number;
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
 *  time, not retrieval value. Callers log the skip — never drop a file quietly. */
export const MAX_FILE_BYTES = 512_000;

/** Per-file chunk budget (~160 KB of covered text at DEFAULT_MAX_SIZE). This is
 *  the real constraint the old 3000/5000-char slices were groping at: peak
 *  memory is bounded by the file itself either way, but every extra chunk is
 *  another embedding call. Over-budget files keep the first N chunks and report
 *  the remainder so the loss is logged rather than silent. */
export const MAX_CHUNKS_PER_FILE = 80;

/** Uncovered spans with less non-whitespace than this are not worth an embedding
 *  of their own — import blocks, closing braces, blank lines between functions. */
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

/* ------------------------------------------------------------------ */
/* Markdown section extraction                                         */
/* ------------------------------------------------------------------ */

const HEADING_RE = /^(#{1,3})\s+(.+)$/;

export function extractMarkdownSections(content: string, _filePath: string): RagSection[] {
  const lines = content.split('\n');
  const sections: RagSection[] = [];
  let currentId = 'intro';
  let currentLines: string[] = [];

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      // Flush previous section
      const text = currentLines.join('\n').trim();
      if (text) {
        sections.push({ sectionId: currentId, content: text });
      }
      currentId = safeSectionId(slugifyHeading(m[2]!));
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Flush final section
  const text = currentLines.join('\n').trim();
  if (text) {
    sections.push({ sectionId: currentId, content: text });
  }

  return sections;
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

function phpRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];

  // File docblock
  const docMatch = /^<\?php\s*(\/\*\*[\s\S]*?\*\/)/.exec(content);
  if (docMatch) {
    const start = content.indexOf(docMatch[1]!);
    ranges.push({ sectionId: 'file-docblock', start, end: start + docMatch[1]!.length });
  }

  // Functions (standalone and methods)
  const funcRe =
    /(\/\*\*[\s\S]*?\*\/\s*)?((?:public|protected|private|static)\s+)*function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) {
      ranges.push({ sectionId: `function-${match[3]!}`, start: match.index, end });
    }
  }

  return ranges;
}

function jsRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  let match: RegExpExecArray | null;

  // Named functions
  const funcRe = /function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  while ((match = funcRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) ranges.push({ sectionId: `function-${match[1]!}`, start: match.index, end });
  }

  // Arrow functions assigned to const/let/var
  const arrowRe =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>\s*\{/g;
  while ((match = arrowRe.exec(content)) !== null) {
    const braceStart = content.lastIndexOf('{', match.index + match[0].length);
    const end = braceBlockEnd(content, braceStart);
    if (end !== null) ranges.push({ sectionId: `function-${match[1]!}`, start: match.index, end });
  }

  // Classes
  const classRe = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
  while ((match = classRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) ranges.push({ sectionId: `class-${match[1]!}`, start: match.index, end });
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
    if (end !== null) ranges.push({ sectionId: `function-${match[1]!}`, start: match.index, end });
  }
  return ranges;
}

function rustRanges(content: string): SectionRange[] {
  const ranges: SectionRange[] = [];
  let match: RegExpExecArray | null;

  const fnRe = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)[^{]*\{/g;
  while ((match = fnRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) ranges.push({ sectionId: `function-${match[1]!}`, start: match.index, end });
  }

  const implRe = /impl\s+(?:<[^>]*>\s+)?(\w+)(?:\s+for\s+\w+)?\s*\{/g;
  while ((match = implRe.exec(content)) !== null) {
    const end = blockEndFromMatch(content, match);
    if (end !== null) ranges.push({ sectionId: `impl-${match[1]!}`, start: match.index, end });
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
 *  so a class yields its methods rather than one duplicate copy of both. */
export function assembleSections(content: string, ranges: SectionRange[]): RagSection[] {
  const kept = ranges.filter(
    (r) =>
      !ranges.some(
        (s) =>
          s !== r && s.start >= r.start && s.end <= r.end && (s.start > r.start || s.end < r.end),
      ),
  );
  kept.sort((a, b) => a.start - b.start || a.end - b.end);

  const sections: RagSection[] = [];
  let cursor = 0;
  let gapIndex = 0;

  const pushGap = (from: number, to: number): void => {
    if (to <= from) return;
    const text = content.slice(from, to);
    if (text.trim().length < MIN_GAP_CHARS) return;
    sections.push({ sectionId: `chunk-${gapIndex}`, content: text });
    gapIndex += 1;
  };

  for (const r of kept) {
    // Partial overlaps (a regex that ran past its construct) would double-index
    // the shared bytes; skip the later range rather than emit them twice.
    if (r.start < cursor) continue;
    pushGap(cursor, r.start);
    sections.push({
      sectionId: safeSectionId(r.sectionId),
      content: content.slice(r.start, r.end),
    });
    cursor = r.end;
  }
  pushGap(cursor, content.length);

  return sections;
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
      ranges = jsRanges(content);
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

export function chunkSection(
  section: RagSection,
  maxSize = DEFAULT_MAX_SIZE,
  overlap = DEFAULT_OVERLAP,
): RagChunk[] {
  const trimmed = section.content.trim();
  if (trimmed.length === 0) return [];

  if (trimmed.length <= maxSize) {
    return [
      {
        sectionId: section.sectionId,
        chunkIndex: 0,
        content: trimmed,
        chunkHash: computeChunkHash(trimmed),
      },
    ];
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
        // Try sentence break
        const sentBreak = trimmed.lastIndexOf('. ', end);
        if (sentBreak > start + maxSize / 2) {
          splitAt = sentBreak + 2;
        }
      }
    }

    const text = trimmed.slice(start, splitAt);
    chunks.push({
      sectionId: section.sectionId,
      chunkIndex: idx,
      content: text,
      chunkHash: computeChunkHash(text),
    });
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
