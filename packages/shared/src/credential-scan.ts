/** The committed-secret scanner's pure text rules, shared by discovery and evidence sinks. */
export interface CredentialCandidate {
  file: string;
  line: number;
  kind: 'credential assignment' | 'provider key' | 'private key' | 'credential URL';
}

// Classify a captured whole key separately to avoid greedy keyword-prefix/suffix
// patterns backtracking quadratically on long, repeated identifiers.
const CREDENTIAL_NAME =
  /(?:^|[_-])(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?=$|[_-])/i;
const ASSIGNMENT = /(?<![\w-])([\w-]+)["']?(?:[ \t]*\])?\s*(?:=>|[:=])\s*(["'`])([^"'`\r\n]+)\2/gi;
// .env and YAML commonly use bare scalars. Require a scalar terminator rather
// than matching the prefix of a function call or another compound expression.
const UNQUOTED_ASSIGNMENT =
  /(?<![\w-])([\w-]+)["']?(?:[ \t]*\])?[ \t]*(?:=>|[:=])[ \t]*([^\s"'`#,;{}\[\]()\\]{1,4096})(?=[ \t]*(?:[,;#}\r\n]|$))/gi;
const PROVIDER_KEY =
  /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk_live_[A-Za-z0-9]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|AIza[A-Za-z0-9_-]{35}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
const CREDENTIAL_URL =
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:'"<>]*:([^\s/@'"<>]+)@[^\s/'"<>]+/i;

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
    const key = match[1]!
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2');
    if (CREDENTIAL_NAME.test(key) && !placeholder(match[group]!)) return true;
  }
  return false;
}

/** Visit matches without accumulating source text, regex matches or candidate objects. */
export function visitCredentials(
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

/** Matches are line locations, so withhold each nominated line, preserving other
 * bytes and line endings. A private-key marker also withholds its multiline body
 * through the corresponding end marker (or EOF for an unfinished key). */
export const CREDENTIAL_WITHHELD = 'content withheld by secret policy.';
export function redactCredentialText(content: string): string {
  const lines = new Map<number, CredentialCandidate['kind']>();
  visitCredentials(content, (line, kind) => lines.set(line, kind));
  if (!lines.size) return content;
  let line = 0;
  let privateKeyEnd: string | undefined;
  return content.replace(/[^\n]*(?:\n|$)/g, (text) => {
    if (!text) return text;
    const kind = lines.get(++line);
    if (kind === 'private key' && !privateKeyEnd) {
      const start = text.indexOf('-----BEGIN ');
      const end = text.indexOf('PRIVATE KEY-----', start) + 'PRIVATE KEY-----'.length;
      privateKeyEnd = text.slice(start, end).replace('-----BEGIN ', '-----END ');
    }
    if (!kind && !privateKeyEnd) return text;
    if (privateKeyEnd && text.includes(privateKeyEnd)) privateKeyEnd = undefined;
    const ending = text.endsWith('\r\n') ? '\r\n' : text.endsWith('\n') ? '\n' : '';
    return CREDENTIAL_WITHHELD + ending;
  });
}
