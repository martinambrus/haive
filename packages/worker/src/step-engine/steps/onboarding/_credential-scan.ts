import { readFileNoFollow } from '@haive/shared/fs-safe';
import { spawn } from 'node:child_process';
import { GIT_BASE_ENV, hardenGitArgs } from '../../../repo/git-exec.js';
import { isSingleLine, survivesFence } from '../_untrusted-repo.js';

/** Location only: neither the value nor its surrounding source may enter detect_output. */
export interface CredentialCandidate {
  file: string;
  line: number;
  kind: 'credential assignment' | 'provider key' | 'private key' | 'credential URL';
}

export interface CredentialScan {
  hits: CredentialCandidate[];
  omitted: number;
  files: number;
  unreadable: number;
  truncated: number;
}

const READ_CAP = 512 * 1024;
const PATH_BYTES = 4096;
// Classify a captured whole key separately to avoid greedy keyword-prefix/suffix
// patterns backtracking quadratically on long, repeated identifiers.
const CREDENTIAL_NAME = /password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key/i;
const ASSIGNMENT = /(?<![\w-])([\w-]+)["']?\s*(?:=>|[:=])\s*(["'`])([^"'`\r\n]+)\2/gi;
// .env and YAML commonly use bare scalars. Require a scalar terminator rather
// than matching the prefix of a function call or another compound expression.
const UNQUOTED_ASSIGNMENT =
  /(?<![\w-])([\w-]+)["']?[ \t]*(?:=>|[:=])[ \t]*([^\s"'`#,;{}\[\]()\\]{1,4096})(?=[ \t]*(?:[,;#}\r\n]|$))/gi;
const PROVIDER_KEY =
  /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const CREDENTIAL_URL =
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:'"<>]+:([^\s/@'"<>]+)@[^\s/'"<>]+/i;

function placeholder(value: string): boolean {
  return (
    /^(?:\$|\{|<|your[-_ ]|example|placeholder|dummy|changeme|change[-_ ]?me|redacted|process\.env\.|import\.meta\.env\.|x{3,}|\*{3,}|\.{3,})/i.test(
      value,
    ) ||
    /^(?:undefined|null|none|false|true)$/i.test(value) ||
    value === 'AKIAIOSFODNN7EXAMPLE'
  );
}

function hasLiteralAssignment(text: string, pattern: RegExp, group: number): boolean {
  for (const match of text.matchAll(pattern)) {
    if (CREDENTIAL_NAME.test(match[1]!) && !placeholder(match[group]!)) return true;
  }
  return false;
}

/** Visit matches without accumulating source text, regex matches or candidate objects. */
function visitCredentials(
  content: string,
  visit: (line: number, kind: CredentialCandidate['kind']) => void,
): void {
  if (content.includes('\0')) return;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    // One location per line keeps accountability unambiguous when multiple patterns match.
    let kind: CredentialCandidate['kind'] | undefined;
    if (PRIVATE_KEY.test(text)) kind = 'private key';
    else if (PROVIDER_KEY.test(text) && !text.includes('AKIAIOSFODNN7EXAMPLE'))
      kind = 'provider key';
    else if (hasLiteralAssignment(text, ASSIGNMENT, 3)) kind = 'credential assignment';
    else if (hasLiteralAssignment(text, UNQUOTED_ASSIGNMENT, 2)) kind = 'credential assignment';
    else {
      const url = text.includes('://') ? CREDENTIAL_URL.exec(text) : null;
      if (url && !placeholder(url[1]!)) kind = 'credential URL';
    }
    if (kind) visit(i + 1, kind);
  }
}

/** Deliberately candidates, never verdicts. Tests, examples and upstream files need judgement. */
export function scanTextForCredentials(file: string, content: string): CredentialCandidate[] {
  const hits: CredentialCandidate[] = [];
  visitCredentials(content, (line, kind) => hits.push({ file, line, kind }));
  return hits;
}

interface RankedCandidate {
  ordinal: number;
  fileIndex: number;
  hit: CredentialCandidate;
}

const compareRank = (a: RankedCandidate, b: RankedCandidate) =>
  a.ordinal - b.ordinal || a.fileIndex - b.fileIndex;

/** Keep only the best `cap` locations in a max heap. Rank is breadth before depth:
 * first match from each sorted file, then second matches, independently of read order. */
class BoundedCandidates {
  private readonly heap: RankedCandidate[] = [];

  constructor(private readonly cap: number) {}

  add(
    file: string,
    fileIndex: number,
    ordinal: number,
    line: number,
    kind: CredentialCandidate['kind'],
  ): void {
    if (this.cap === 0) return;
    const worst = this.heap[0];
    if (
      this.heap.length === this.cap &&
      worst &&
      (ordinal > worst.ordinal || (ordinal === worst.ordinal && fileIndex >= worst.fileIndex))
    )
      return;
    const entry: RankedCandidate = { ordinal, fileIndex, hit: { file, line, kind } };
    if (this.heap.length < this.cap) {
      let index = this.heap.length;
      this.heap.push(entry);
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (compareRank(this.heap[parent]!, entry) >= 0) break;
        this.heap[index] = this.heap[parent]!;
        index = parent;
      }
      this.heap[index] = entry;
      return;
    }
    let index = 0;
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && compareRank(this.heap[child + 1]!, this.heap[child]!) > 0)
        child++;
      if (compareRank(entry, this.heap[child]!) >= 0) break;
      this.heap[index] = this.heap[child]!;
      index = child;
    }
    this.heap[index] = entry;
  }

  hits(): CredentialCandidate[] {
    return this.heap.sort(compareRank).map((entry) => entry.hit);
  }
}

/** Stream Git's sorted index with backpressure; retain only one unfinished pathname.
 * Filesystem paths that cannot be represented by fs-safe's UTF-8 string interface
 * are counted as unreadable instead of decoding to a different file's name. */
async function* trackedPaths(repoPath: string, checkCancelled: () => void) {
  const child = spawn('git', hardenGitArgs(['ls-files', '-z']), {
    cwd: repoPath,
    env: { ...process.env, ...GIT_BASE_ENV },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = new Promise<{ code?: number | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code) => resolve({ code }));
  });
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = Buffer.alloc(0);
  let oversized = false;
  let lastPath: string | undefined;
  try {
    for await (const chunk of child.stdout) {
      const data = chunk as Buffer;
      let start = 0;
      while (start < data.length) {
        checkCancelled();
        const end = data.indexOf(0, start);
        const part = data.subarray(start, end < 0 ? data.length : end);
        if (!oversized) {
          if (pending.length + part.length > PATH_BYTES) {
            pending = Buffer.alloc(0);
            oversized = true;
          } else pending = Buffer.concat([pending, part]);
        }
        if (end < 0) break;
        let rel: string | null = null;
        if (!oversized) {
          try {
            rel = decoder.decode(pending);
          } catch {
            /* unsupported pathname bytes */
          }
        }
        if (rel === null || (rel.length > 0 && rel !== lastPath)) yield rel;
        lastPath = rel ?? undefined;
        pending = Buffer.alloc(0);
        oversized = false;
        start = end + 1;
      }
    }
    const result = await exited;
    if (result.error) throw result.error;
    if (result.code !== 0 || pending.length || oversized)
      throw new Error('Could not stream the tracked credential inventory');
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    await exited;
  }
}

/** Git's tracked inventory, NOT the RAG collector: build/vendor/core/tests and ignored-but-
 * tracked files all count. Reads are bounded and refuse links in every path component. */
export async function scanForCredentials(
  repoPath: string,
  cap: number,
  checkCancelled: () => void = () => {},
): Promise<CredentialScan> {
  if (!Number.isSafeInteger(cap) || cap < 0)
    throw new RangeError('Invalid credential candidate cap');
  checkCancelled();
  const retained = new BoundedCandidates(cap);
  let total = 0;
  let files = 0;
  let unreadable = 0;
  let truncated = 0;
  const batch: Promise<void>[] = [];
  async function inspect(rel: string | null, index: number) {
    if (rel === null) {
      unreadable++;
      return;
    }
    // Unusable prompt locations must not crowd valid locations out of the cap.
    // Still inspect/count their matches so internal omissions remain exact.
    const usablePath = isSingleLine(rel) && survivesFence(rel);
    const read = await readFileNoFollow(repoPath, rel, { maxBytes: READ_CAP });
    if (read === null) {
      unreadable++;
      return;
    }
    if (read.truncated) truncated++;
    let ordinal = 0;
    visitCredentials(read.data.toString('utf8'), (line, kind) => {
      total++;
      if (usablePath) retained.add(rel, index, ordinal++, line, kind);
    });
  }
  try {
    for await (const rel of trackedPaths(repoPath, checkCancelled)) {
      const read = inspect(rel, files++);
      // Observe immediately; all readers settle before propagating a batch failure.
      void read.catch(() => {});
      batch.push(read);
      if (batch.length === 16) {
        await Promise.all(batch);
        batch.length = 0;
      }
    }
    await Promise.all(batch);
  } finally {
    await Promise.allSettled(batch);
  }
  const hits = retained.hits();
  return { hits, omitted: total - hits.length, files, unreadable, truncated };
}
