import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StatusSummaryItem } from '@haive/shared';
import {
  houseRuleShortIds,
  parseHouseRulesStamp,
  type HouseRulesStamp,
} from '@haive/shared/global-kb';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { collapseToLine } from '../_untrusted-repo.js';
import { code } from './_plan-ops.js';
import { asPlainText } from './_similar-sites.js';

/** A rule the approved spec or a person requires breaking: reported to a person, never repaired. */
export interface RuleConflict {
  rule: string;
  file?: string;
  reason: string;
}

/** The validator's file list is capped, while a rule is matched against the whole change. */
export interface ChangedFilesCoverage {
  listed: number;
  total: number;
}

export interface GateHouseRules {
  mode: HouseRulesStamp['mode'];
  reason?: HouseRulesStamp['reason'];
  errorClass?: HouseRulesStamp['errorClass'];
  entries: { shortId: string; title: string; why: HouseRulesStamp['entries'][number]['why'] }[];
  omitted: { title: string; why: HouseRulesStamp['omitted'][number]['why'] }[];
  violations: { shortId: string; title: string; file: string; description: string }[];
  conflicts: RuleConflict[];
  changedFilesCoverage?: ChangedFilesCoverage;
}

const RULE_REF_CHARS = 64;
const TEXT_CHARS = 500;
const CONFLICTS_MAX = 20;

// Cut by character, not by UTF-16 unit, so a pair is never split.
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return [...collapseToLine(value)].slice(0, max).join('').trimEnd();
}

export function normalizeRuleRef(rule: string): string {
  const ref = rule.trim().toLowerCase();
  return ref.startsWith('rule ') ? ref.slice('rule '.length) : ref;
}

export const parseRuleRef = (value: unknown): string | undefined =>
  oneLine(value, RULE_REF_CHARS) || undefined;

export function parseRuleConflicts(value: unknown): RuleConflict[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item: unknown) => {
      const { rule, file, reason } = (item ?? {}) as Record<string, unknown>;
      const ref = parseRuleRef(rule);
      const why = oneLine(reason, TEXT_CHARS);
      if (ref === undefined || why === '') return [];
      const where = oneLine(file, TEXT_CHARS);
      return [{ rule: ref, ...(where === '' ? {} : { file: where }), reason: why }];
    })
    .slice(0, CONFLICTS_MAX);
}

function parseChangedFilesCoverage(value: unknown): ChangedFilesCoverage | undefined {
  const { listed, total } = (value ?? {}) as Record<string, unknown>;
  return typeof listed === 'number' && typeof total === 'number' ? { listed, total } : undefined;
}

export async function loadInvocationStamp(
  db: Database,
  invocationId: string,
): Promise<HouseRulesStamp | null> {
  const [row] = await db
    .select({ houseRules: schema.cliInvocations.houseRules })
    .from(schema.cliInvocations)
    .where(eq(schema.cliInvocations.id, invocationId))
    .limit(1);
  return parseHouseRulesStamp(row?.houseRules);
}

/** From the stamp of the invocation 07b's latest output names, never one picked by title, message or age. */
export async function loadGateHouseRules(
  db: Database,
  taskId: string,
): Promise<GateHouseRules | null> {
  const validation = await loadPreviousStepOutput(db, taskId, '07b-phase-4-validate');
  const output = (validation?.output ?? {}) as Record<string, unknown>;
  const invocationId = output.validatorInvocationId;
  if (typeof invocationId !== 'string' || invocationId === '') return null;
  const stamp = await loadInvocationStamp(db, invocationId);
  if (stamp === null) return null;

  const shortIds = houseRuleShortIds(stamp.entries.map((entry) => entry.id));
  const entries = stamp.entries.map((entry) => ({
    shortId: shortIds.get(entry.id)!,
    title: oneLine(entry.title, TEXT_CHARS),
    why: entry.why,
  }));
  const named = new Map(entries.map((entry) => [entry.shortId, entry] as const));
  const issues: unknown[] = Array.isArray(output.issues) ? output.issues : [];
  const violations = issues.flatMap((item) => {
    const issue = (item ?? {}) as Record<string, unknown>;
    const entry = typeof issue.rule === 'string' ? named.get(normalizeRuleRef(issue.rule)) : null;
    if (!entry) return [];
    return [
      {
        shortId: entry.shortId,
        title: entry.title,
        file: oneLine(issue.file, TEXT_CHARS),
        description: oneLine(issue.description, TEXT_CHARS),
      },
    ];
  });
  const coverage = parseChangedFilesCoverage(output.changedFilesCoverage);
  return {
    mode: stamp.mode,
    ...(stamp.reason === undefined ? {} : { reason: stamp.reason }),
    ...(stamp.errorClass === undefined ? {} : { errorClass: stamp.errorClass }),
    entries,
    omitted: stamp.omitted.map((rule) => ({
      title: oneLine(rule.title, TEXT_CHARS),
      why: rule.why,
    })),
    violations,
    conflicts: parseRuleConflicts(output.ruleConflicts),
    ...(coverage === undefined ? {} : { changedFilesCoverage: coverage }),
  };
}

type HouseCase = 'conflict' | 'violated' | 'notChecked' | 'off' | 'partial' | 'enforced';

const CASES: Record<
  HouseCase,
  { status: StatusSummaryItem['status']; label: string; holdsApprove: boolean }
> = {
  conflict: { status: 'warn', label: 'CONFLICT', holdsApprove: true },
  violated: { status: 'fail', label: 'VIOLATED', holdsApprove: true },
  notChecked: { status: 'warn', label: 'NOT CHECKED', holdsApprove: true },
  off: { status: 'info', label: 'OFF', holdsApprove: false },
  partial: { status: 'warn', label: 'PARTIAL', holdsApprove: true },
  enforced: { status: 'pass', label: 'ENFORCED', holdsApprove: false },
};

/** The validator's list, when rules were given to it and it did not list every changed file. */
function cappedList(data: GateHouseRules): ChangedFilesCoverage | null {
  const coverage = data.changedFilesCoverage;
  return data.entries.length > 0 && coverage !== undefined && coverage.listed < coverage.total
    ? coverage
    : null;
}

function caseOf(data: GateHouseRules): HouseCase | null {
  if (data.conflicts.length > 0) return 'conflict';
  if (data.violations.length > 0) return 'violated';
  if (data.reason === 'unavailable' || data.reason === 'too_large') return 'notChecked';
  if (data.reason === 'switched_off') return 'off';
  if (data.omitted.length > 0 || cappedList(data) !== null) return 'partial';
  if (data.entries.length > 0) return 'enforced';
  return null;
}

function reasonText(data: GateHouseRules): string {
  if (data.reason === 'unavailable') {
    return `the global KB could not be read${data.errorClass ? ` (${data.errorClass})` : ''}`;
  }
  if (data.reason === 'too_large') return 'the prompt was too large for the CLI';
  return data.reason === 'switched_off' ? 'house rules are switched off' : '';
}

const OMITTED_WHY = {
  budget: 'left out of the prompt: it did not fit the prompt budget',
  refused: 'left out of the prompt: its text was refused',
} as const;

function scopeText(why: GateHouseRules['entries'][number]['why']): string {
  if (why.scope === 'always') return 'every change';
  return why.glob === null ? 'files (change not measured)' : `files matching ${code(why.glob)}`;
}

const bullet = (head: string, ...tail: string[]): string => {
  const rest = tail.filter(Boolean).join(': ');
  return rest === '' ? `- ${head}` : `- ${head} — ${rest}`;
};

const ruleHead = (shortId: string | null, title: string): string =>
  `Rule${shortId === null ? '' : ` ${code(shortId)}`}${title === '' ? '' : ` ${asPlainText(title)}`}`;

function bodyOf(data: GateHouseRules): string {
  const titles = new Map(data.entries.map((entry) => [entry.shortId, entry.title] as const));
  const capped = cappedList(data);
  const sections: [string, string[]][] = [
    ['Checked', data.entries.map((e) => bullet(ruleHead(e.shortId, e.title), scopeText(e.why)))],
    [
      'Not checked',
      [
        ...data.omitted.map((rule) => bullet(ruleHead(null, rule.title), OMITTED_WHY[rule.why])),
        ...(capped === null
          ? []
          : [
              bullet(
                `${capped.total - capped.listed} changed files beyond the validator's list of ${capped.listed}`,
              ),
            ]),
      ],
    ],
    [
      'Conflicts',
      data.conflicts.map((c) => {
        const ref = normalizeRuleRef(c.rule);
        const shortId = titles.has(ref) ? ref : c.rule;
        return bullet(
          ruleHead(shortId, titles.get(shortId) ?? ''),
          c.file === undefined ? '' : code(c.file),
          asPlainText(c.reason),
        );
      }),
    ],
    [
      'Violations open',
      data.violations.map((v) =>
        bullet(
          ruleHead(v.shortId, v.title),
          v.file === '' ? '' : code(v.file),
          asPlainText(v.description),
        ),
      ),
    ],
  ];
  return sections
    .filter(([, lines]) => lines.length > 0)
    .map(([heading, lines]) => [`## ${heading}`, ...lines].join('\n'))
    .join('\n\n');
}

/** Its state comes from structural fields only: counts, the stamp's reason, never message text. */
export function houseRulesRow(data: GateHouseRules | null | undefined): StatusSummaryItem | null {
  if (!data) return null;
  const kind = caseOf(data);
  if (kind === null) return null;
  const { status, label } = CASES[kind];
  const capped = cappedList(data);
  const counts = [
    data.entries.length > 0 ? `${data.entries.length} rule(s) checked` : '',
    data.omitted.length > 0 ? `${data.omitted.length} not checked` : '',
    capped === null
      ? ''
      : `the validator was given ${capped.listed} of ${capped.total} changed files`,
    data.conflicts.length > 0 ? `${data.conflicts.length} conflict(s)` : '',
    data.violations.length > 0 ? `${data.violations.length} violation(s) open` : '',
  ];
  const body = bodyOf(data);
  return {
    label: 'House rules',
    status,
    statusLabel: label,
    detail: [reasonText(data), ...counts].filter(Boolean).join('; '),
    ...(body === '' ? {} : { body }),
    defaultOpen: status !== 'pass' && status !== 'info',
  };
}

export function houseRulesHoldApprove(data: GateHouseRules | null | undefined): boolean {
  const kind = data ? caseOf(data) : null;
  return kind !== null && CASES[kind].holdsApprove;
}
