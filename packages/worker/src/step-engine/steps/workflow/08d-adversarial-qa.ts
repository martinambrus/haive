import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type {
  StepContext,
  StepDefinition,
  AgentMiningDispatch,
  AgentMiningResult,
} from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { parseJsonLoose } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { loadAppBootOutput } from './_task-meta.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';

// Phase 7 — Adversarial QA (legacy phase7-adversarial-qa.md). Opt-in per task
// (tasks.adversarial_qa_level: poc|standard|enterprise). After code review and
// before gate 2, N adversarial agents actively try to BREAK the change — edge
// cases, auth bypass, injection, logic flaws — and report proof-of-concept
// findings. Proof-of-concept only: no persistence, no data deletion, no prod
// disruption. Blocking findings (critical/high) drive the fixLoop below — routing
// back to implementation like 08c — while the rest surface at gate 2. Formless;
// gated by shouldRun.
//
// Each prompt defers to the repo's onboarded adversarial agent definition
// (.claude/agents/<id>.md — Haive onboards all six) when present, and embeds a
// condensed persona inline as the fallback, the same convention as 08a/08b/08c.

const QA_TIMEOUT_MS = 45 * 60 * 1000;

type QaLevel = 'poc' | 'standard' | 'enterprise';

interface AdversaryDef {
  id: string;
  title: string;
  persona: string;
}

// Roster, cumulative by level (poc ⊂ standard ⊂ enterprise).
const ADVERSARIES: AdversaryDef[] = [
  {
    id: 'edge-case-breaker',
    title: 'Edge Case Breaker',
    persona:
      'Attack boundaries and degenerate inputs: null/empty/whitespace, zero and negative, max/overflow, huge payloads, unicode and encoding tricks, missing/extra fields, and concurrent/duplicate requests. Find inputs the change mishandles.',
  },
  {
    id: 'workflow-disruptor',
    title: 'Workflow Disruptor',
    persona:
      'Break the user flow: out-of-order steps, double-submit, back/forward navigation, refresh mid-flow, abandoned sessions, and state that survives when it should not. Find flows that corrupt or leak state.',
  },
  {
    id: 'auth-bandit',
    title: 'Auth Bandit',
    persona:
      'Attack authentication and authorization: missing access checks, horizontal/vertical privilege escalation, IDOR, session fixation/replay, and forced browsing to privileged paths. Find any privileged action reachable without the right identity.',
  },
  {
    id: 'injection-infector',
    title: 'Injection Infector',
    persona:
      'Attempt injection at every untrusted sink: SQL/NoSQL, XSS (stored/reflected), command, template, header, and path traversal. Trace each input to its sink and confirm exploitability with a non-destructive proof.',
  },
  {
    id: 'logic-lunatic',
    title: 'Logic Lunatic',
    persona:
      'Attack business logic: race conditions, time-of-check/time-of-use, negative-quantity and rounding abuse, replayed or reordered operations, and invariant violations. Find ways to reach an impossible or unfair state.',
  },
  {
    id: 'chaos-creator',
    title: 'Chaos Creator',
    persona:
      'Think laterally: combine weaknesses, abuse error paths and partial failures, exhaust resources, and exploit framework-specific defaults. Find the creative attack the other reviewers would miss.',
  },
];

function rosterForLevel(level: QaLevel): AdversaryDef[] {
  if (level === 'poc') return ADVERSARIES.slice(0, 2);
  if (level === 'standard') return ADVERSARIES.slice(0, 4);
  return ADVERSARIES.slice(0, 6);
}

interface AdversarialDetect {
  level: QaLevel;
  spec: string;
  implementationFiles: string[];
  appUrl: string | null;
  debtBlock: string;
}

interface AdversarialFinding {
  severity: string;
  category?: string;
  location?: string;
  poc?: string;
  impact?: string;
  fix?: string;
}

interface AdversarialApply {
  ran: boolean;
  level: QaLevel | null;
  findings: AdversarialFinding[];
  counts: { critical: number; high: number; total: number };
  blocking: boolean;
}

const adversaryOutputSchema = z.object({
  verdict: z.enum(['PASS', 'NEEDS_FIXES', 'FAIL']).optional(),
  findings: z
    .array(
      z.object({
        severity: z.string().default('low'),
        category: z.string().optional(),
        location: z.string().optional(),
        poc: z.string().optional(),
        impact: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
});

function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  // parseJsonLoose extracts the fenced/balanced JSON and runs a jsonrepair salvage
  // pass, so a truncated/malformed adversary turn is recovered instead of dropped.
  return parseJsonLoose(raw);
}

/** Parse one adversarial agent's JSON; null when unparseable. */
export function parseAdversaryOutput(raw: unknown): AdversarialFinding[] | null {
  const parsed = adversaryOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return parsed.data.findings;
}

/** Roster size per level — exported for the unit test. */
export function adversaryIdsForLevel(level: QaLevel): string[] {
  return rosterForLevel(level).map((a) => a.id);
}

const SEARCH_LADDER = [
  'When you need context, search in this order:',
  '1. `rag_search` FIRST, 2. `.claude/knowledge_base/`, 3. Grep / Read the codebase.',
] as const;

const SAFETY = [
  'SAFETY: proof-of-concept ONLY. Do NOT persist changes, delete or corrupt data, exfiltrate',
  'secrets, or disrupt any running service. Demonstrate exploitability with the minimum',
  'non-destructive proof and stop.',
] as const;

function buildAdversaryPrompt(a: AdversaryDef, d: AdversarialDetect): string {
  return [
    `If a \`.claude/agents/${a.id}.md\` agent definition exists in the repo, follow it;`,
    'otherwise follow the persona below.',
    `You are ${a.title}, an adversarial QA agent. Your job is to BREAK the implemented change.`,
    a.persona,
    '',
    ...SAFETY,
    '',
    d.implementationFiles.length > 0
      ? `Changed files (attack surface):\n- ${d.implementationFiles.join('\n- ')}`
      : 'Determine the changed files from the workspace.',
    d.appUrl ? `Running app URL (for runtime attacks): ${d.appUrl}` : '',
    d.debtBlock ? `\n${d.debtBlock}` : '',
    'Do NOT edit code and do NOT run git.',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "PASS|NEEDS_FIXES|FAIL", "findings": [{ "severity": "critical|high|medium|low", "category": "<attack type>", "location": "file:line or URL", "poc": "<non-destructive proof>", "impact": "<what could happen>", "fix": "<recommendation>" }] }',
    '',
    '=== Spec (the intended behavior) ===',
    d.spec || '(no spec recorded)',
    '',
    INSIGHTS_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n');
}

export const adversarialQaStep: StepDefinition<AdversarialDetect, AdversarialApply> = {
  metadata: {
    id: '08d-adversarial-qa',
    workflowType: 'workflow',
    index: 8.9,
    title: 'Phase 7: Adversarial QA',
    description:
      'Adversarial agents actively try to break the change (edge cases, auth, injection, logic). Findings surface at gate 2. Opt-in per task.',
    requiresCli: false,
  },

  // Fix-loop: blocking adversarial-QA findings (critical/high) route back to implementation.
  fixLoop: {
    evaluate: (out) => {
      if (!out.blocking) return null;
      const diagnosis = out.findings
        .map(
          (f) =>
            `- [${f.severity}] ${f.category ?? 'issue'}${f.location ? ` @ ${f.location}` : ''}: ${f.impact ?? ''}${f.fix ? ` — fix: ${f.fix}` : ''}`,
        )
        .join('\n');
      return { blocking: true, diagnosis: diagnosis || 'Adversarial QA found blocking issues.' };
    },
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { adversarialQaLevel: true },
    });
    const level = task?.adversarialQaLevel;
    return level === 'poc' || level === 'standard' || level === 'enterprise';
  },

  async detect(ctx: StepContext): Promise<AdversarialDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { adversarialQaLevel: true },
    });
    const level = (task?.adversarialQaLevel ?? 'poc') as QaLevel;

    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string } | null;
    const workspace = wt?.worktreePath ?? ctx.workspacePath;

    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    const browser = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08a-browser-verify');
    const appUrl = (browser?.output as { appUrl?: string } | null)?.appUrl ?? boot?.appUrl ?? null;

    // DAG debt (07b/08c pattern).
    let debtBlock = '';
    const dagPlan = await ctx.db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.taskId, ctx.taskId),
      columns: { mode: true },
    });
    if (dagPlan?.mode === 'dag') {
      const issues = await ctx.db
        .select({
          issueKey: schema.taskDagIssues.issueKey,
          title: schema.taskDagIssues.title,
          debtItems: schema.taskDagIssues.debtItems,
        })
        .from(schema.taskDagIssues)
        .where(eq(schema.taskDagIssues.taskId, ctx.taskId));
      const lines = issues
        .filter((i) => ((i.debtItems ?? []) as unknown[]).length > 0)
        .map((i) => `- ${i.issueKey} (${i.title}): ${JSON.stringify(i.debtItems).slice(0, 500)}`);
      if (lines.length > 0) {
        debtBlock = [
          'KNOWN TECHNICAL DEBT (documented compromises): only flag these if they are actually',
          'exploitable; do not report them as new issues otherwise.',
          ...lines,
        ].join('\n');
      }
    }

    return {
      level,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, workspace),
      appUrl,
      debtBlock,
    };
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: QA_TIMEOUT_MS,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // No bypass stub for mining; return [] under test bypass (08c pattern).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as AdversarialDetect;
      return rosterForLevel(d.level).map((a) => ({
        agentId: a.id,
        agentTitle: a.title,
        prompt: buildAdversaryPrompt(a, d),
      }));
    },
  },

  async apply(ctx, args): Promise<AdversarialApply> {
    const results: AgentMiningResult[] = args.agentMiningResults ?? [];
    const detected = args.detected;

    // Aggregate findings across agents; dedupe by location keeping highest severity.
    const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const byLocation = new Map<string, AdversarialFinding>();
    const unlocated: AdversarialFinding[] = [];
    for (const r of results) {
      if (r.status !== 'done') continue;
      const raw = r.output ?? r.rawOutput;
      const parsed = parseAdversaryOutput(raw);
      if (parsed == null) {
        // Adversary ran but its output was unparseable (even after jsonrepair salvage).
        // Do NOT treat that as "no vulnerabilities" — surface a visible QA-gap finding
        // so it shows at gate 2 (the Tier-3 retry will re-roll the agent upstream).
        if (raw != null) {
          unlocated.push({
            severity: 'medium',
            category: 'qa-gap',
            impact: `Adversarial agent "${r.agentId}" produced unparseable output — its findings may be missing; re-run adversarial QA.`,
          });
        }
        continue;
      }
      for (const f of parsed) {
        const key = (f.location ?? '').trim().toLowerCase();
        if (!key) {
          unlocated.push(f);
          continue;
        }
        const existing = byLocation.get(key);
        if (
          !existing ||
          (rank[(f.severity ?? '').toLowerCase()] ?? 0) >
            (rank[(existing.severity ?? '').toLowerCase()] ?? 0)
        ) {
          byLocation.set(key, f);
        }
      }
    }
    // Consolidate: sort by severity (critical → low), like the legacy phase-7b consolidator.
    const findings = [...byLocation.values(), ...unlocated].sort(
      (a, b) =>
        (rank[(b.severity ?? '').toLowerCase()] ?? 0) -
        (rank[(a.severity ?? '').toLowerCase()] ?? 0),
    );
    const critical = findings.filter((f) => (f.severity ?? '').toLowerCase() === 'critical').length;
    const high = findings.filter((f) => (f.severity ?? '').toLowerCase() === 'high').length;
    const blocking = critical + high > 0;
    const ran = results.some((r) => r.status === 'done');

    ctx.logger.info(
      { level: detected.level, agents: results.length, findings: findings.length, blocking },
      'adversarial QA complete',
    );

    return {
      ran,
      level: ran ? detected.level : null,
      findings,
      counts: { critical, high, total: findings.length },
      blocking,
    };
  },
};
