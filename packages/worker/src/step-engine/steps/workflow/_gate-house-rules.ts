import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StatusSummaryItem } from '@haive/shared';
import { isBlockingSeverity, type ReviewSeverity } from '@haive/shared/review';
import {
  houseRuleShortIds,
  parseHouseRulesStamp,
  type HouseRulesStamp,
} from '@haive/shared/global-kb';
import { changeFingerprint } from '../../../orchestrator/house-rules-dispatch.js';
import type { StepContext } from '../../step-definition.js';
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

/** A check's file list is capped, while a rule is matched against the whole change. */
export interface ChangedFilesCoverage {
  listed: number;
  total: number;
  /** The check the list was given to; the validator where absent. */
  givenTo?: 'code review';
  /** A read of the change failed (at detect or after a fix), so the list may lack some of it. */
  scanFailed?: true;
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
  /** The check had a rule in play: an entry, or a files rule that matched nothing in the change it read. */
  inPlay?: true;
  /** The change moved after the last check, which had a rule in play. */
  modifiedAfterCheck?: boolean;
}

const RULE_REF_CHARS = 64;
const TEXT_CHARS = 500;
const CONFLICTS_MAX = 20;
export const REREAD_FAILED = 'the change could not be re-read after a fix';
const UNREAD_CHANGE = 'the change could not be fully read';

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
      const { rule, file, path, reason } = (item ?? {}) as Record<string, unknown>;
      const ref = parseRuleRef(rule);
      const why = oneLine(reason, TEXT_CHARS);
      if (ref === undefined || why === '') return [];
      const where = oneLine(file, TEXT_CHARS) || oneLine(path, TEXT_CHARS);
      return [{ rule: ref, ...(where === '' ? {} : { file: where }), reason: why }];
    })
    .slice(0, CONFLICTS_MAX);
}

function parseChangedFilesCoverage(
  value: unknown,
  givenTo?: ChangedFilesCoverage['givenTo'],
): ChangedFilesCoverage | undefined {
  const { listed, total, scanFailed } = (value ?? {}) as Record<string, unknown>;
  return typeof listed === 'number' && typeof total === 'number'
    ? {
        listed,
        total,
        ...(givenTo === undefined ? {} : { givenTo }),
        ...(scanFailed === true ? { scanFailed } : {}),
      }
    : undefined;
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

/** True when the item's `rule` names one of the short ids a pass was given. */
export const namesGivenRule = (item: { rule?: string }, given: ReadonlySet<string>): boolean =>
  item.rule !== undefined && given.has(normalizeRuleRef(item.rule));

/** Short ids of the house rules a pass was given, from the stamp of its own invocation. Read only
 *  when an item names a rule. */
export async function givenRuleIds(
  db: Database,
  items: readonly { rule?: string }[],
  invocationId: string | null | undefined,
): Promise<Set<string>> {
  if (!invocationId || !items.some((item) => item.rule !== undefined)) return new Set();
  const stamp = await loadInvocationStamp(db, invocationId);
  return new Set(stamp ? houseRuleShortIds(stamp.entries.map((entry) => entry.id)).values() : []);
}

/** A violation of a rule the pass was given blocks, whatever severity the model gave it. */
export function raiseRuleViolations<T extends { severity: ReviewSeverity; rule?: string }>(
  items: T[],
  given: ReadonlySet<string>,
): { items: T[]; raised: number; stamped: number } {
  const raised = items.map((item) =>
    namesGivenRule(item, given) && !isBlockingSeverity(item.severity)
      ? { ...item, severity: 'high' as const }
      : item,
  );
  return {
    items: raised,
    raised: raised.filter((item, i) => item !== items[i]).length,
    stamped: items.filter((item) => namesGivenRule(item, given)).length,
  };
}

/** What one check found against its rules, as its step stored it. */
interface StoredFinding {
  rule: unknown;
  file: unknown;
  description: unknown;
}

/** One check's row data: the rules its invocation was given and what it found against them. */
function checkOf(
  stamp: HouseRulesStamp,
  found: StoredFinding[],
  conflicts: unknown,
  coverage: unknown,
  givenTo?: ChangedFilesCoverage['givenTo'],
): GateHouseRules {
  const shortIds = houseRuleShortIds(stamp.entries.map((entry) => entry.id));
  const entries = stamp.entries.map((entry) => ({
    shortId: shortIds.get(entry.id)!,
    title: oneLine(entry.title, TEXT_CHARS),
    why: entry.why,
  }));
  const named = new Map(entries.map((entry) => [entry.shortId, entry] as const));
  const violations = found.flatMap((item) => {
    const entry = typeof item.rule === 'string' ? named.get(normalizeRuleRef(item.rule)) : null;
    if (!entry) return [];
    return [
      {
        shortId: entry.shortId,
        title: entry.title,
        file: oneLine(item.file, TEXT_CHARS),
        description: oneLine(item.description, TEXT_CHARS),
      },
    ];
  });
  const listed = parseChangedFilesCoverage(coverage, givenTo);
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
    conflicts: parseRuleConflicts(conflicts),
    ...(listed === undefined ? {} : { changedFilesCoverage: listed }),
  };
}

const recordsOf = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []).map((item) => (item ?? {}) as Record<string, unknown>);

async function stampNamedBy(db: Database, invocationId: unknown): Promise<HouseRulesStamp | null> {
  if (typeof invocationId !== 'string' || invocationId === '') return null;
  return loadInvocationStamp(db, invocationId);
}

/** A check's row data with what the gate compares the change by: the fingerprint the check stored
 *  (none in an output written before there was one) and whether a rule was in play for it. */
interface Check {
  rules: GateHouseRules;
  fingerprint: string | null;
  inPlay: boolean;
}

const checkWith = (
  rules: GateHouseRules,
  stamp: HouseRulesStamp,
  output: Record<string, unknown>,
): Check => {
  const inPlay = stamp.entries.length > 0 || (stamp.filesRulesUnmatched ?? 0) > 0;
  return {
    rules: inPlay ? { ...rules, inPlay } : rules,
    fingerprint:
      typeof output.changeFingerprint === 'string' && output.changeFingerprint !== ''
        ? output.changeFingerprint
        : null,
    inPlay,
  };
};

async function validationCheck(db: Database, taskId: string): Promise<Check | null> {
  const validation = await loadPreviousStepOutput(db, taskId, '07b-phase-4-validate');
  const output = (validation?.output ?? {}) as Record<string, unknown>;
  const stamp = await stampNamedBy(db, output.validatorInvocationId);
  if (stamp === null) return null;
  const rules = checkOf(
    stamp,
    recordsOf(output.issues).map((issue) => ({
      rule: issue.rule,
      file: issue.file,
      description: issue.description,
    })),
    output.ruleConflicts,
    output.changedFilesCoverage,
  );
  return checkWith(rules, stamp, output);
}

async function codeReviewCheck(db: Database, taskId: string): Promise<Check | null> {
  const review = await loadPreviousStepOutput(db, taskId, '08c-code-review');
  const output = (review?.output ?? {}) as Record<string, unknown>;
  const stamp = await stampNamedBy(db, output.peerInvocationId);
  if (stamp === null) return null;
  const peer = (output.peer ?? {}) as Record<string, unknown>;
  const rules = checkOf(
    stamp,
    recordsOf(peer.findings).map((finding) => ({
      rule: finding.rule,
      file: [oneLine(finding.path, TEXT_CHARS), oneLine(finding.lines, TEXT_CHARS)]
        .filter(Boolean)
        .join(':'),
      description: finding.issue,
    })),
    output.ruleConflicts,
    output.coverage,
    'code review',
  );
  return checkWith(rules, stamp, output);
}

/** From the stamp of the invocation 07b's latest output names, never one picked by title, message or age.
 *  `withCodeReview` adds 08c's peer reviewer, the later check: its state replaces 07b's, both lists merge. */
export async function loadGateHouseRules(
  db: Database,
  taskId: string,
  {
    withCodeReview = false,
    currentFingerprint,
  }: { withCodeReview?: boolean; currentFingerprint?: () => Promise<string | null> } = {},
): Promise<GateHouseRules | null> {
  const validation = await validationCheck(db, taskId);
  const review = withCodeReview ? await codeReviewCheck(db, taskId) : null;
  const last = review ?? validation;
  if (last === null) return null;
  const rules =
    review === null || validation === null
      ? last.rules
      : mergeChecks(validation.rules, review.rules);
  if (currentFingerprint === undefined || last.fingerprint === null || !last.inPlay) return rules;
  const now = await currentFingerprint();
  return now === null || now === last.fingerprint ? rules : { ...rules, modifiedAfterCheck: true };
}

function mergeChecks(validation: GateHouseRules, review: GateHouseRules): GateHouseRules {
  const coverage = review.changedFilesCoverage ?? validation.changedFilesCoverage;
  return {
    ...review,
    violations: [...validation.violations, ...review.violations],
    conflicts: [...validation.conflicts, ...review.conflicts],
    ...(coverage === undefined ? {} : { changedFilesCoverage: coverage }),
  };
}

/** The fingerprint a check stores and a gate compares, of the worktree 01-worktree-setup made. */
export async function taskChangeFingerprint(
  ctx: Pick<StepContext, 'db' | 'taskId'>,
): Promise<string | null> {
  const setup = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const made = (setup?.output ?? {}) as { worktreePath?: unknown; baseBranch?: unknown };
  if (typeof made.worktreePath !== 'string' || made.worktreePath === '') return null;
  return changeFingerprint(
    made.worktreePath,
    typeof made.baseBranch === 'string' ? made.baseBranch : null,
  );
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

const ruleInPlay = (data: GateHouseRules): boolean =>
  data.inPlay === true || data.entries.length > 0;

/** A check's list, when a rule was in play for it and it did not list every changed file. */
function cappedList(data: GateHouseRules): ChangedFilesCoverage | null {
  const coverage = data.changedFilesCoverage;
  return ruleInPlay(data) && coverage !== undefined && coverage.listed < coverage.total
    ? coverage
    : null;
}

/** A check with a rule in play whose list may lack part of the change: a read of it failed. */
const unreadChange = (data: GateHouseRules): boolean =>
  ruleInPlay(data) && data.changedFilesCoverage?.scanFailed === true;

function caseOf(data: GateHouseRules): HouseCase | null {
  if (data.conflicts.length > 0) return 'conflict';
  if (data.violations.length > 0) return 'violated';
  if (data.reason === 'unavailable' || data.reason === 'too_large') return 'notChecked';
  if (data.reason === 'switched_off') return 'off';
  if (
    data.omitted.length > 0 ||
    cappedList(data) !== null ||
    unreadChange(data) ||
    data.modifiedAfterCheck === true
  ) {
    return 'partial';
  }
  if (data.entries.length > 0) return 'enforced';
  return null;
}

const checkName = (coverage: ChangedFilesCoverage): string =>
  coverage.givenTo === undefined ? 'the validator' : `the ${coverage.givenTo}`;

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
                `${capped.total - capped.listed} changed files beyond ${checkName(capped)}'s list of ${capped.listed}`,
              ),
            ]),
        ...(unreadChange(data) ? [bullet('files the read missed, if any', UNREAD_CHANGE)] : []),
        ...(data.modifiedAfterCheck === true
          ? [bullet('changes made after the last house-rules check')]
          : []),
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
      : `${checkName(capped)} was given ${capped.listed} of ${capped.total} changed files`,
    unreadChange(data) ? UNREAD_CHANGE : '',
    data.modifiedAfterCheck === true
      ? 'the change was modified after the last house-rules check'
      : '',
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
