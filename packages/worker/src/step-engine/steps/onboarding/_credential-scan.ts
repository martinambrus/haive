import { readFileNoFollow } from '@haive/shared/fs-safe';
import { gitExec } from '../../../repo/git-exec.js';

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
const ASSIGNMENT =
  /\b(?:[\w]*password|passwd|[\w]*secret|[\w]*token|[\w]*api[_-]?key|[\w]*access[_-]?key|[\w]*private[_-]?key)\b["']?\s*(?:=>|[:=])\s*(["'`])([^"'`\r\n]{8,})\1/gi;
// .env and YAML commonly use bare scalars. Require a scalar terminator rather
// than matching the prefix of a function call or another compound expression.
const UNQUOTED_ASSIGNMENT =
  /\b(?:[\w]*password|passwd|[\w]*secret|[\w]*token|[\w]*api[_-]?key|[\w]*access[_-]?key|[\w]*private[_-]?key)\b["']?[ \t]*(?:=>|[:=])[ \t]*([^\s"'`#,;{}\[\]()\\]{8,4096})(?=[ \t]*(?:[,;#}\r\n]|$))/gi;
const PROVIDER_KEY =
  /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:'"<>]+:([^\s/@'"<>]{3,})@[^\s/'"<>]+/i;

function placeholder(value: string): boolean {
  return (
    /^(?:\$|\{|<|your[-_ ]|example|placeholder|dummy|changeme|change[-_ ]?me|redacted|process\.env\.|import\.meta\.env\.|x{3,}|\*{3,}|\.{3,})/i.test(
      value,
    ) ||
    /^(?:undefined|null|none|false|true)$/i.test(value) ||
    value === 'AKIAIOSFODNN7EXAMPLE'
  );
}

/** Deliberately candidates, never verdicts. Tests, examples and upstream files need judgement. */
export function scanTextForCredentials(file: string, content: string): CredentialCandidate[] {
  if (content.includes('\0')) return [];
  const hits: CredentialCandidate[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    // One location per line keeps accountability unambiguous when multiple patterns match.
    let kind: CredentialCandidate['kind'] | undefined;
    if (PRIVATE_KEY.test(text)) kind = 'private key';
    else if (PROVIDER_KEY.test(text) && !text.includes('AKIAIOSFODNN7EXAMPLE'))
      kind = 'provider key';
    else if ([...text.matchAll(ASSIGNMENT)].some((m) => !placeholder(m[2]!)))
      kind = 'credential assignment';
    else if ([...text.matchAll(UNQUOTED_ASSIGNMENT)].some((m) => !placeholder(m[1]!)))
      kind = 'credential assignment';
    else {
      const url = CREDENTIAL_URL.exec(text);
      if (url && !placeholder(url[1]!)) kind = 'credential URL';
    }
    if (kind) hits.push({ file, line: i + 1, kind });
  }
  return hits;
}

/** Git's tracked inventory, NOT the RAG collector: build/vendor/core/tests and ignored-but-
 * tracked files all count. Reads are bounded and refuse links in every path component. */
export async function scanForCredentials(
  repoPath: string,
  cap: number,
  checkCancelled: () => void = () => {},
): Promise<CredentialScan> {
  const { stdout } = await gitExec(['ls-files', '-z'], { cwd: repoPath });
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort();
  const results: CredentialCandidate[][] = new Array(files.length);
  let next = 0;
  let unreadable = 0;
  let truncated = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < files.length) {
        checkCancelled();
        const index = next++;
        const rel = files[index]!;
        const read = await readFileNoFollow(repoPath, rel, { maxBytes: READ_CAP });
        if (read === null) {
          unreadable++;
          results[index] = [];
          continue;
        }
        if (read.truncated) truncated++;
        results[index] = scanTextForCredentials(rel, read.data.toString('utf8'));
      }
    }),
  );
  // Breadth before depth: one fixture with hundreds of assignments must not take the cap.
  const hits: CredentialCandidate[] = [];
  const groups = results.filter((group) => group.length > 0);
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  for (let line = 0; hits.length < Math.min(total, cap); line++) {
    for (const group of groups) {
      if (group[line]) hits.push(group[line]!);
      if (hits.length === cap) break;
    }
  }
  return { hits, omitted: total - hits.length, files: files.length, unreadable, truncated };
}
