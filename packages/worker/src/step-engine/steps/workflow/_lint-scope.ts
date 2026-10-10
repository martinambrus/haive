import { collapseToLine, safeNote } from '../_untrusted-repo.js';
import { isListableName, type ChangedFileLines, type ChangedLineMap } from './_impl-changes.js';

const SHELL_SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

const BLOCKING_LIST_CHARS = 2000;

/** Raised on the file as a whole (a parse failure, a crashed sniff), at a line the change need
 *  not have written. */
const INTERNAL_SOURCE_PREFIX = 'Internal.';

/** `--report=full` comes first: the first `--report*` flag replaces the default console report.
 *  Both paths go into a `bash -lc` string, hence the charset. */
export function phpcsReportFlags(reportPath: string, basepath: string): string[] {
  if (!SHELL_SAFE_PATH.test(reportPath) || !SHELL_SAFE_PATH.test(basepath)) {
    throw new Error('a phpcs report path may only use letters, digits and . _ / -');
  }
  return ['--report=full', `--report-json=${reportPath}`, `--basepath=${basepath}`];
}

export interface PhpcsMessage {
  message: string;
  source: string;
  type: 'ERROR' | 'WARNING';
  line: number;
}

export interface Violation extends PhpcsMessage {
  path: string;
}

export interface PhpcsReport {
  files: Map<string, PhpcsMessage[]>;
}

export function parsePhpcsJsonReport(text: string): PhpcsReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const files = (raw as { files?: unknown } | null)?.files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
  const report: PhpcsReport = { files: new Map() };
  for (const [path, entry] of Object.entries(files)) {
    const messages = (entry as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) return null;
    const parsed: PhpcsMessage[] = [];
    for (const m of messages) {
      const { message, source, type, line } = (m ?? {}) as Record<string, unknown>;
      if (
        typeof message !== 'string' ||
        typeof source !== 'string' ||
        (type !== 'ERROR' && type !== 'WARNING') ||
        !Number.isInteger(line)
      ) {
        return null;
      }
      parsed.push({ message, source, type, line: line as number });
    }
    report.files.set(path, parsed);
  }
  return report;
}

function writtenByChange(lines: ChangedFileLines, m: PhpcsMessage): boolean {
  if (lines.whole) return true;
  if (m.source.startsWith(INTERNAL_SOURCE_PREFIX)) return lines.ranges.length > 0;
  return lines.ranges.some(([start, end]) => m.line >= start && m.line <= end);
}

export interface ScopedReport {
  blocking: Violation[];
  preExisting: number;
}

export function scopePhpcsReport(report: PhpcsReport, changed: ChangedLineMap): ScopedReport {
  const blocking: Violation[] = [];
  let preExisting = 0;
  for (const [path, messages] of report.files) {
    const lines = changed.get(path);
    for (const m of messages) {
      if (lines !== undefined && writtenByChange(lines, m)) blocking.push({ path, ...m });
      else preExisting += 1;
    }
  }
  return { blocking, preExisting };
}

export const preExistingFact = (n: number): string =>
  `${n} pre-existing violation(s) elsewhere predate this change`;

/** A path is a name the agent opens, so one that cannot be a single line is left out, not
 *  rewritten; a message is prose, so it is collapsed and capped. */
const violationLine = (v: Violation): string | null =>
  isListableName(v.path)
    ? `${v.path}:${v.line}: [${v.type}] ${safeNote(v.message)} (${collapseToLine(v.source)})`
    : null;

export function renderBlockingList(blocking: Violation[], preExisting: number): string {
  const moreLine = (n: number): string => `(+${n} more not shown)`;
  const closing =
    preExisting > 0 ? `${preExistingFact(preExisting)} — do not edit code to clear them.` : '';
  const room = BLOCKING_LIST_CHARS - closing.length - moreLine(blocking.length).length - 2;
  const shown: string[] = [];
  let used = 0;
  for (const v of blocking) {
    const line = violationLine(v);
    if (line === null) continue;
    const cost = line.length + (shown.length > 0 ? 1 : 0);
    if (used + cost > room) break;
    shown.push(line);
    used += cost;
  }
  const hidden = blocking.length - shown.length;
  return [...shown, hidden > 0 ? moreLine(hidden) : '', closing].filter(Boolean).join('\n');
}
