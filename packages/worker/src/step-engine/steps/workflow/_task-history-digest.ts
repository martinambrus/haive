import { asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/* ------------------------------------------------------------------ */
/* Task-history digest — mines the PERSISTED run history (fix-loop     */
/* diagnoses, validation/review/QA findings, the user's gate reactions,*/
/* runtime/browser errors) into a curated, BOUNDED, complexity-tiered  */
/* digest for the learning agent. NEVER feeds raw cli_invocation       */
/* transcripts — only structured outputs + capped diagnoses. Depth     */
/* scales with how much actually went wrong.                            */
/* ------------------------------------------------------------------ */

export type DigestTier = 'low' | 'medium' | 'high';

export interface TaskHistoryDigest {
  /** Rendered markdown digest to inject into the learning prompt. */
  text: string;
  tier: DigestTier;
  maxRound: number;
  fixLoopCount: number;
  findingCount: number;
  /** Mid-run steering events mined from this task (a friction signal). */
  steerCount: number;
}

const TIER_TOTAL_CAP: Record<DigestTier, number> = { low: 1500, medium: 6000, high: 20000 };
const DIAGNOSIS_ITEM_CAP: Record<DigestTier, number> = { low: 700, medium: 1000, high: 2500 };
const DIAGNOSIS_COUNT: Record<DigestTier, number> = { low: 1, medium: 3, high: 12 };
const SOFT_FINDING_CAP: Record<DigestTier, number> = { low: 4, medium: 12, high: 40 };

/** Steps whose `output` carries severity-bearing findings. */
const FINDING_STEP_IDS = new Set(['07b-phase-4-validate', '08c-code-review', '08d-adversarial-qa']);

interface Finding {
  severity: string;
  where: string;
  desc: string;
  fix: string;
  source: string;
}

function sevRank(s: string): number {
  switch (s.toLowerCase()) {
    case 'critical':
      return 0;
    case 'high':
      return 1;
    case 'medium':
      return 2;
    case 'low':
      return 3;
    default:
      return 4;
  }
}

function clip(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}… [truncated]` : t;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Normalize one finding-step's structured output into severity-bearing findings. */
function extractFindings(stepId: string, output: unknown): Finding[] {
  if (!output || typeof output !== 'object') return [];
  const o = output as Record<string, unknown>;
  const out: Finding[] = [];

  if (stepId === '07b-phase-4-validate') {
    for (const it of asArray(o.issues)) {
      const i = it as Record<string, unknown>;
      out.push({
        severity: str(i.severity) || 'unspecified',
        where: str(i.file),
        desc: str(i.description),
        fix: str(i.fix),
        source: '07b-validate',
      });
    }
  } else if (stepId === '08c-code-review') {
    for (const it of asArray((o.peer as Record<string, unknown> | undefined)?.findings)) {
      const i = it as Record<string, unknown>;
      out.push({
        severity: str(i.severity) || 'unspecified',
        where: str(i.path),
        desc: str(i.issue),
        fix: str(i.fix),
        source: '08c-peer',
      });
    }
    for (const it of asArray((o.security as Record<string, unknown> | undefined)?.findings)) {
      const i = it as Record<string, unknown>;
      const cwe = str(i.cwe);
      out.push({
        severity: str(i.severity) || 'unspecified',
        where: str(i.path),
        desc: `${cwe ? `[${cwe}] ` : ''}${str(i.issue)}`,
        fix: str(i.fix),
        source: '08c-security',
      });
    }
    for (const lens of asArray(o.extraLenses)) {
      const l = lens as Record<string, unknown>;
      for (const it of asArray(l.findings)) {
        const i = it as Record<string, unknown>;
        out.push({
          severity: str(i.severity) || 'unspecified',
          where: str(i.path),
          desc: str(i.issue),
          fix: str(i.fix),
          source: `08c-${str(l.id) || 'lens'}`,
        });
      }
    }
  } else if (stepId === '08d-adversarial-qa') {
    for (const it of asArray(o.findings)) {
      const i = it as Record<string, unknown>;
      out.push({
        severity: str(i.severity) || 'unspecified',
        where: str(i.location),
        desc: str(i.impact) || str(i.category),
        fix: str(i.fix),
        source: '08d-qa',
      });
    }
  }
  return out.filter((f) => f.desc);
}

/** Runtime / browser errors (not severity-bearing) from 08 + 08a outputs. */
function extractRuntimeErrors(stepId: string, output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const o = output as Record<string, unknown>;
  const out: string[] = [];
  if (stepId === '08-phase-5-verify') {
    const rs = o.runtimeSmoke as Record<string, unknown> | null;
    if (rs && rs.ran === true && rs.passed === false) {
      out.push(`runtime smoke (HTTP ${rs.httpStatus ?? '?'}): ${clip(str(rs.errorExcerpt), 600)}`);
    }
  } else if (stepId === '08a-browser-verify') {
    for (const e of asArray(o.consoleErrors).slice(0, 5)) out.push(`console: ${clip(str(e), 300)}`);
    for (const e of asArray(o.networkErrors).slice(0, 5)) out.push(`network: ${clip(str(e), 300)}`);
    for (const f of asArray(o.failures).slice(0, 5)) {
      const ff = f as Record<string, unknown>;
      out.push(`browser-test: ${clip(str(ff.description), 300)}`);
    }
  }
  return out;
}

/** Build the curated, bounded, complexity-tiered digest of what happened during
 *  the task: per-round diagnoses, findings (by severity), human gate reactions,
 *  and runtime/browser errors. */
export interface DigestStepInput {
  stepId: string;
  round: number;
  output: unknown;
}

export interface DigestEventInput {
  eventType: string;
  payload: Record<string, unknown> | null;
}

/** Fetch the task's steps + events, then render the digest. */
export async function buildTaskHistoryDigest(
  db: Database,
  taskId: string,
): Promise<TaskHistoryDigest> {
  const steps = await db
    .select()
    .from(schema.taskSteps)
    .where(eq(schema.taskSteps.taskId, taskId))
    .orderBy(asc(schema.taskSteps.stepIndex), asc(schema.taskSteps.round));
  const events = await db
    .select()
    .from(schema.taskEvents)
    .where(eq(schema.taskEvents.taskId, taskId))
    .orderBy(asc(schema.taskEvents.createdAt));
  return renderTaskHistoryDigest(steps, events);
}

/** Pure renderer (exported for unit tests) over already-fetched step + event rows. */
export function renderTaskHistoryDigest(
  steps: DigestStepInput[],
  events: DigestEventInput[],
): TaskHistoryDigest {
  const maxRound = steps.reduce((m, s) => Math.max(m, s.round ?? 0), 0);
  const fixLoopEvents = events.filter((e) => e.eventType === 'fix_loop.requested');
  const fixLoopCount = fixLoopEvents.length;
  const escalated = events.some(
    (e) => e.eventType === 'fix_loop.oscillation_detected' || e.eventType === 'fix_loop.escalated',
  );

  const findings: Finding[] = [];
  const runtimeErrors: string[] = [];
  for (const s of steps) {
    if (FINDING_STEP_IDS.has(s.stepId)) findings.push(...extractFindings(s.stepId, s.output));
    runtimeErrors.push(...extractRuntimeErrors(s.stepId, s.output));
  }
  const findingCount = findings.length;

  // Mid-run steering events = a high-value friction signal (the user only nudges
  // when the agent drifted). Mine them like gate reactions and let them raise the
  // tier so a heavily-steered task is learned from in more depth.
  const steerEvents = events.filter((e) => e.eventType === 'steering.nudge');
  const steerCount = steerEvents.length;
  const steers = steerEvents
    .map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return { round: typeof p.round === 'number' ? p.round : 0, text: str(p.text) };
    })
    .filter((s) => s.text.trim());

  const tier: DigestTier =
    maxRound >= 3 || fixLoopCount >= 3 || findingCount >= 15 || escalated || steerCount >= 3
      ? 'high'
      : maxRound === 0 && findingCount <= 3 && steerCount === 0
        ? 'low'
        : 'medium';

  // Gate reactions — ALL reject feedback, verbatim (short, high-value: the human
  // reactions the old note-taking workflow lost). Gate-2 feedback rides the
  // fix-loop diagnosis, so it surfaces in the diagnoses section instead.
  const reactions: string[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.eventType === 'business_requirements.rejected' && str(p.feedback).trim()) {
      reactions.push(`Requirements rejected: "${clip(str(p.feedback), 500)}"`);
    } else if (e.eventType === 'spec.rejected' && str(p.feedback).trim()) {
      reactions.push(`Spec rejected: "${clip(str(p.feedback), 500)}"`);
    }
  }

  // Per-round diagnoses, chronological (the INITIAL problem is most informative
  // when the tier caps the count); high tier keeps the full progression.
  const diagnoses = fixLoopEvents
    .map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      return {
        round: typeof p.round === 'number' ? p.round : 0,
        source: str(p.sourceStepId),
        diagnosis: str(p.diagnosis),
      };
    })
    .filter((d) => d.diagnosis.trim())
    .slice(0, DIAGNOSIS_COUNT[tier]);

  const lines: string[] = [
    `(complexity: ${tier} — ${maxRound} fix-loop round(s), ${fixLoopCount} loop-back(s), ${findingCount} finding(s)${steerCount > 0 ? `, ${steerCount} user steer(s)` : ''}${escalated ? ', escalated to a human gate' : ''})`,
  ];

  if (diagnoses.length > 0) {
    lines.push('', '## What blocked it (round by round)');
    for (const d of diagnoses) {
      lines.push(
        `- round ${d.round} via ${d.source || 'review'}: ${clip(d.diagnosis, DIAGNOSIS_ITEM_CAP[tier])}`,
      );
    }
  }

  if (reactions.length > 0) {
    lines.push('', '## Human reviewer reactions');
    for (const r of reactions) lines.push(`- ${r}`);
  }

  // Mid-run steering — the user course-corrected a running agent. Verbatim and
  // never truncated away (human signal), like gate reactions.
  if (steers.length > 0) {
    lines.push('', '## User steering (mid-run course-corrections)');
    for (const s of steers) lines.push(`- round ${s.round}: "${clip(s.text, 500)}"`);
  }

  if (findings.length > 0) {
    const sorted = [...findings].sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
    const critHigh = sorted.filter((f) => sevRank(f.severity) <= 1);
    const lower = sorted.filter((f) => sevRank(f.severity) > 1);
    const lowerShown = lower.slice(0, SOFT_FINDING_CAP[tier]);
    lines.push('', '## Findings (validation / review / QA)');
    for (const f of [...critHigh, ...lowerShown]) {
      const fixPart = f.fix ? ` -> ${clip(f.fix, 200)}` : '';
      lines.push(
        `- [${f.severity}] ${f.where ? `${f.where}: ` : ''}${clip(f.desc, 300)}${fixPart} (${f.source})`,
      );
    }
    const dropped = lower.length - lowerShown.length;
    if (dropped > 0) lines.push(`- (+${dropped} more lower-severity findings)`);
  }

  if (runtimeErrors.length > 0) {
    lines.push('', '## Runtime / browser errors');
    for (const e of runtimeErrors) lines.push(`- ${e}`);
  }

  let text = lines.join('\n').trim();
  if (text.length > TIER_TOTAL_CAP[tier]) {
    text = `${text.slice(0, TIER_TOTAL_CAP[tier])}\n… [digest truncated at ${tier}-tier cap]`;
  }

  return { text, tier, maxRound, fixLoopCount, findingCount, steerCount };
}
