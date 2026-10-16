import type { ZodError } from 'zod';

const TRUNCATED_MARK = '\n[truncated]';

/** The first issue of a failed parse as one line of at most `maxLength` characters. */
export function describeIssue(error: ZodError, maxLength: number): string {
  const issue = error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return `invalid arguments: ${where}${issue?.message ?? 'not accepted'}`.slice(0, maxLength);
}

/** At most `maxBytes` of UTF-8, marked as cut, never ending inside a character. */
export function cutToBytes(text: string, maxBytes: number, alreadyCut = false): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes && !alreadyCut) return text;
  let end = Math.min(bytes.length, maxBytes - Buffer.byteLength(TRUNCATED_MARK));
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATED_MARK;
}
