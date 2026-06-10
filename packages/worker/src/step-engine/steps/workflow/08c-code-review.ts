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
import { extractFencedJson } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { INSIGHTS_INSTRUCTION } from './08e-insights-triage.js';

// Phase 6 — Code review (legacy phase6-code-review.md). After test management
// and before gate 2, two reviewers run IN PARALLEL via agent mining: a
// peer-reviewer (correctness/maintainability/conventions) and a
// security-code-reviewer (injection/access-control/secrets). Both defer to the
// repo's onboarded agent definition when present, else follow the embedded
// condensed persona. Findings surface at gate 2.
//
// No in-step fix loop (legacy had a 5-round loop that restarted Phase 4): the
// step engine can't cleanly combine parallel mining with a role-based fixer, and
// Haive's gate-2 reject already IS the fix path — rejecting there routes the user
// back to implementation. Mandatory for workflow tasks; formless.

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

interface CodeReviewDetect {
  spec: string;
  implementationFiles: string[];
  debtBlock: string;
}

interface PeerFinding {
  severity: string;
  path?: string;
  lines?: string;
  issue: string;
  snippet?: string;
  fix?: string;
}
interface SecurityFinding {
  severity: string;
  in_scope?: string;
  path?: string;
  line?: string | number;
  cwe?: string;
  issue: string;
  snippet?: string;
  attack?: string;
  fix?: string;
}

interface CodeReviewApply {
  reviewed: boolean;
  peer: { verdict: string; findings: PeerFinding[]; positives: string[] };
  security: { verdict: string; findings: SecurityFinding[] };
  blocking: boolean;
  counts: { peer: number; securityCriticalHigh: number };
}

const peerSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'DISCUSS']).optional(),
  findings: z
    .array(
      z.object({
        severity: z.string().default('suggestion'),
        path: z.string().optional(),
        lines: z.string().optional(),
        issue: z.string(),
        snippet: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
  positives: z.array(z.string()).default([]),
});

const securitySchema = z.object({
  verdict: z.enum(['SECURE', 'NEEDS_FIXES', 'VULNERABLE']).optional(),
  findings: z
    .array(
      z.object({
        severity: z.string().default('low'),
        in_scope: z.string().optional(),
        path: z.string().optional(),
        line: z.union([z.string(), z.number()]).optional(),
        cwe: z.string().optional(),
        issue: z.string(),
        snippet: z.string().optional(),
        attack: z.string().optional(),
        fix: z.string().optional(),
      }),
    )
    .default([]),
});

function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const body = extractFencedJson(raw);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Parse the peer-reviewer JSON; null when unparseable. */
export function parsePeerReview(
  raw: unknown,
): { verdict: string; findings: PeerFinding[]; positives: string[] } | null {
  const parsed = peerSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return {
    verdict: parsed.data.verdict ?? 'DISCUSS',
    findings: parsed.data.findings,
    positives: parsed.data.positives,
  };
}

/** Parse the security-code-reviewer JSON; null when unparseable. */
export function parseSecurityReview(
  raw: unknown,
): { verdict: string; findings: SecurityFinding[] } | null {
  const parsed = securitySchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return { verdict: parsed.data.verdict ?? 'NEEDS_FIXES', findings: parsed.data.findings };
}

/** A review result is blocking when peer requests changes, security is
 *  vulnerable, or any security finding is critical/high. */
export function computeBlocking(
  peer: { verdict: string } | null,
  security: { verdict: string; findings: SecurityFinding[] } | null,
): boolean {
  if (peer?.verdict === 'REQUEST_CHANGES') return true;
  if (security?.verdict === 'VULNERABLE') return true;
  if (
    security?.findings.some((f) => {
      const s = (f.severity ?? '').toLowerCase();
      return s === 'critical' || s === 'high';
    })
  ) {
    return true;
  }
  return false;
}

const SEARCH_LADDER = [
  'When you need conventions or context, search in this order:',
  '1. `rag_search` FIRST, 2. `.claude/knowledge_base/`, 3. Grep / Read the codebase.',
] as const;

const PEER_PERSONA = [
  'You are the Peer Reviewer. Catch bugs and improve quality before merge while keeping feedback',
  'constructive — name what is wrong with a concrete fix, name what was done well, and NEVER',
  'rewrite the code (the author owns it).',
  'Review each changed file in FULL for: correctness (does it do what the spec says, edge/error',
  'cases), maintainability (duplication, oversized functions, unnecessary coupling), and',
  'convention adherence (existing repo patterns + knowledge base). Acknowledge genuine strengths.',
  'Every finding needs a file + line, the offending code snippet, and a concrete fix (with a code',
  'example where it helps); mark critical issues critical (never soften to a suggestion). Report',
  'EVERY finding in full — never just counts. Do NOT edit code and do NOT run git (it is',
  'unavailable here — work from the changed-files list and read them directly).',
] as const;

const SECURITY_PERSONA = [
  'You are the Security Code Reviewer. Think like an attacker: trace every untrusted input from',
  'entry (param, header, cookie, body, upload) to every sink (database, output, file, shell) and',
  'verify sanitization at each step. Check injection (SQL/NoSQL/XSS/command/template),',
  'access-control on every privileged path, secret handling, and data exposure. Report EVERY',
  'finding in full — including pre-existing, low-severity, and dead-code ones — each with',
  'file:line, the offending code snippet, an attack scenario, and a fix, so the author can decide',
  'with full information. Report EVERY finding in full — never just counts. Do NOT edit code and do',
  'NOT run git (it is unavailable here — work from the changed-files list and read them directly).',
] as const;

function reviewAssignment(d: CodeReviewDetect): string {
  return [
    d.implementationFiles.length > 0
      ? `Changed files to review (read each in full):\n- ${d.implementationFiles.join('\n- ')}`
      : 'Determine the recently-changed files from the workspace and read each in full.',
    d.debtBlock ? `\n${d.debtBlock}` : '',
    '',
    ...SEARCH_LADDER,
    '',
    '=== Spec (what the change must deliver) ===',
    d.spec || '(no spec recorded)',
    '',
    INSIGHTS_INSTRUCTION,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildPeerPrompt(d: CodeReviewDetect): string {
  return [
    'If a `.claude/agents/peer-reviewer.md` agent definition exists in the repo, follow it;',
    'otherwise follow the protocol below.',
    ...PEER_PERSONA,
    '',
    reviewAssignment(d),
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "APPROVE|REQUEST_CHANGES|DISCUSS", "findings": [{ "severity": "critical|warning|suggestion", "path": "file", "lines": "start-end", "issue": "...", "snippet": "<offending code>", "fix": "..." }], "positives": ["..."] }',
  ].join('\n');
}

function buildSecurityPrompt(d: CodeReviewDetect): string {
  return [
    'If a `.claude/agents/security-code-reviewer.md` agent definition exists in the repo, follow',
    'it; otherwise follow the protocol below.',
    ...SECURITY_PERSONA,
    '',
    reviewAssignment(d),
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "verdict": "SECURE|NEEDS_FIXES|VULNERABLE", "findings": [{ "severity": "critical|high|medium|low", "in_scope": "yes|no", "path": "file", "line": 0, "cwe": "id or n/a", "issue": "...", "snippet": "<vulnerable code>", "attack": "...", "fix": "..." }] }',
  ].join('\n');
}

function miningResult(results: AgentMiningResult[], agentId: string): unknown {
  const r = results.find((m) => m.agentId === agentId && m.status === 'done');
  return r ? (r.output ?? r.rawOutput) : null;
}

export const codeReviewStep: StepDefinition<CodeReviewDetect, CodeReviewApply> = {
  metadata: {
    id: '08c-code-review',
    workflowType: 'workflow',
    index: 8.8,
    title: 'Phase 6: Code review',
    description:
      'A peer reviewer and a security reviewer review the change in parallel; findings surface at gate 2.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<CodeReviewDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string } | null;
    if (!wt?.worktreePath) {
      throw new Error('08c-code-review requires 01-worktree-setup to have produced a worktree');
    }

    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    // DAG debt: documented compromises reviewers must not flag (07b pattern).
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
          'KNOWN TECHNICAL DEBT (documented compromises): review these with LOWER severity — they',
          'are known and accepted. Only flag if they introduce security vulnerabilities or cascading',
          'failures.',
          ...lines,
        ].join('\n');
      }
    }

    return {
      spec,
      implementationFiles: await collectImplementationFiles(ctx, wt.worktreePath),
      debtBlock,
    };
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: REVIEW_TIMEOUT_MS,
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // Mining has no bypass stub; under test bypass return [] so the smoke
      // doesn't enqueue real CLI jobs (mirrors 03-discovery's empty-persona path).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const d = detected as CodeReviewDetect;
      return [
        { agentId: 'peer-reviewer', agentTitle: 'Peer Reviewer', prompt: buildPeerPrompt(d) },
        {
          agentId: 'security-code-reviewer',
          agentTitle: 'Security Code Reviewer',
          prompt: buildSecurityPrompt(d),
        },
      ];
    },
  },

  async apply(ctx, args): Promise<CodeReviewApply> {
    const results = args.agentMiningResults ?? [];
    const peer = parsePeerReview(miningResult(results, 'peer-reviewer'));
    const security = parseSecurityReview(miningResult(results, 'security-code-reviewer'));

    if (!peer && !security) {
      // No reviews (bypass, or both agents failed) — nothing to block on.
      ctx.logger.info('code review produced no parseable results');
      return {
        reviewed: false,
        peer: { verdict: 'APPROVE', findings: [], positives: [] },
        security: { verdict: 'SECURE', findings: [] },
        blocking: false,
        counts: { peer: 0, securityCriticalHigh: 0 },
      };
    }

    const blocking = computeBlocking(peer, security);
    const securityCriticalHigh = (security?.findings ?? []).filter((f) => {
      const s = (f.severity ?? '').toLowerCase();
      return s === 'critical' || s === 'high';
    }).length;

    ctx.logger.info(
      {
        peerVerdict: peer?.verdict,
        securityVerdict: security?.verdict,
        peerFindings: peer?.findings.length ?? 0,
        securityCriticalHigh,
        blocking,
      },
      'code review complete',
    );

    return {
      reviewed: true,
      peer: peer ?? { verdict: 'DISCUSS', findings: [], positives: [] },
      security: security ?? { verdict: 'NEEDS_FIXES', findings: [] },
      blocking,
      counts: { peer: peer?.findings.length ?? 0, securityCriticalHigh },
    };
  },
};
