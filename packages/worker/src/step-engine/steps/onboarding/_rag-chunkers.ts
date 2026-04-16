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
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'javascript',
  '.py': 'python',
};

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
      currentId = slugifyHeading(m[2]!);
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

function extractPhpSections(content: string): RagSection[] {
  const sections: RagSection[] = [];

  // File docblock
  const docblockRe = /^<\?php\s*(\/\*\*[\s\S]*?\*\/)/;
  const docMatch = docblockRe.exec(content);
  if (docMatch) {
    sections.push({ sectionId: 'file-docblock', content: docMatch[1]! });
  }

  // Functions (standalone and methods)
  const funcRe =
    /(\/\*\*[\s\S]*?\*\/\s*)?((?:public|protected|private|static)\s+)*function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(content)) !== null) {
    const funcName = match[3]!;
    const funcStart = match.index;
    const bodyStart = content.indexOf('{', funcStart + match[0].length - 1);
    const body = extractBraceBlock(content, bodyStart);
    if (body) {
      const full = (match[1] || '') + content.slice(funcStart, bodyStart) + body;
      sections.push({ sectionId: `function-${funcName}`, content: full.slice(0, 3000) });
    }
  }

  if (sections.length === 0) {
    sections.push({ sectionId: 'full-file', content: content.slice(0, 5000) });
  }
  return sections;
}

function extractJsSections(content: string): RagSection[] {
  const sections: RagSection[] = [];

  // Named functions
  const funcRe = /function\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(content)) !== null) {
    const name = match[1]!;
    const bodyStart = content.indexOf('{', match.index + match[0].length - 1);
    const body = extractBraceBlock(content, bodyStart);
    if (body) {
      sections.push({
        sectionId: `function-${name}`,
        content: (content.slice(match.index, bodyStart) + body).slice(0, 3000),
      });
    }
  }

  // Arrow functions assigned to const/let/var
  const arrowRe =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*=>\s*\{/g;
  while ((match = arrowRe.exec(content)) !== null) {
    const name = match[1]!;
    const bodyStart = content.lastIndexOf('{', match.index + match[0].length);
    const body = extractBraceBlock(content, bodyStart);
    if (body) {
      sections.push({
        sectionId: `function-${name}`,
        content: (content.slice(match.index, bodyStart) + body).slice(0, 3000),
      });
    }
  }

  // Classes
  const classRe = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
  while ((match = classRe.exec(content)) !== null) {
    const name = match[1]!;
    const bodyStart = content.indexOf('{', match.index + match[0].length - 1);
    const body = extractBraceBlock(content, bodyStart);
    if (body) {
      sections.push({
        sectionId: `class-${name}`,
        content: (content.slice(match.index, bodyStart) + body).slice(0, 3000),
      });
    }
  }

  if (sections.length === 0) {
    sections.push({ sectionId: 'full-file', content: content.slice(0, 5000) });
  }
  return sections;
}

function extractPythonSections(content: string): RagSection[] {
  const sections: RagSection[] = [];
  const lines = content.split('\n');

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
      const body = lines.slice(startLine, i).join('\n');
      sections.push({ sectionId: `${kind}-${name}`, content: body.slice(0, 3000) });
    } else {
      i += 1;
    }
  }

  if (sections.length === 0) {
    sections.push({ sectionId: 'full-file', content: content.slice(0, 5000) });
  }
  return sections;
}

/** Extract a brace-delimited block starting at position `start` (which must be '{'). */
function extractBraceBlock(content: string, start: number): string | null {
  if (start < 0 || content[start] !== '{') return null;
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    if (content[i] === '{') depth += 1;
    else if (content[i] === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  // Unclosed brace — return up to 3000 chars
  return content.slice(start, start + 3000);
}

export function extractCodeSections(content: string, filePath: string): RagSection[] {
  const ext = path.extname(filePath).toLowerCase();
  const lang = CODE_EXTENSIONS[ext];
  switch (lang) {
    case 'php':
      return extractPhpSections(content);
    case 'javascript':
    case 'typescript':
    case 'tsx':
      return extractJsSections(content);
    case 'python':
      return extractPythonSections(content);
    default:
      return [{ sectionId: 'full-file', content: content.slice(0, 5000) }];
  }
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
    start = splitAt - overlap;
    if (start <= chunks[chunks.length - 1]!.content.length - overlap) {
      start = splitAt; // prevent infinite loop
    }
  }

  return chunks;
}
