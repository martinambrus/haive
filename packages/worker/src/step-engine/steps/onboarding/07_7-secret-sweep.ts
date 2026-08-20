import { stat } from 'node:fs/promises';
import type { FormSchema } from '@haive/shared';
import { coerceReviewSeverity, normalizeCweId } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { REPO_IS_DATA_LINES } from '../_untrusted-repo.js';
import { hasAnyKey, parseAgentJson } from '../workflow/_agent-json.js';
import { recordReviewFindings } from '../workflow/_review-findings.js';

// Onboarding — committed-secret sweep. Nothing in Haive looked for a secret that is
// already IN the repository. `secret-mask` performs the opposite operation (it hides
// UNTRACKED secret files from the agent, and CLAUDE.md states committed ones are out of
// its scope), and `security-code-reviewer` only ever sees a change's diff — so a key
// committed before Haive ever saw the repo was invisible forever.
//
// One pass over the whole tree, once per repo, at onboarding. Borrowed from the
// claude-security plugin's dedicated secrets sweep, including its scope INVERSION: this
// is the one pass for which fixtures and test data are in scope rather than skipped,
// because a real key committed to a test file is a real leak.
//
// WARNS, never blocks. A finding pauses onboarding only long enough to be read, and the
// user continues whatever it says — a false positive must not be able to wedge a repo
// import. Nothing is written to disk: 11-final-review writes `.claude/onboarding-review.md`
// and 13-onboarding-push pushes `.claude/` artifacts, so routing sweep output through
// either would commit the very secret being reported.

const SWEEP_TIMEOUT_MS = 30 * 60 * 1000;

/** Enough to show the user the shape of the problem; the durable rows carry them all. */
const MAX_LISTED_IN_FORM = 25;

export interface SecretFinding {
  severity: ReviewSeverity;
  path: string;
  line?: number;
  symbol?: string;
  /** What kind of credential it looks like ('aws access key', 'private key', ...). */
  kind?: string;
  cwe?: string;
  issue: string;
  fix?: string;
}

interface SecretSweepDetect {
  repoPath: string;
  scannable: boolean;
}

export interface SecretSweepApply {
  swept: boolean;
  findings: SecretFinding[];
  counts: { critical: number; high: number; total: number };
}

const SWEEP_RULES = [
  'You are a SECRET SWEEPER. Your single job is to find credentials that are COMMITTED to',
  'this repository: API keys, access tokens, private keys, passwords, connection strings',
  'with embedded credentials, signing secrets, and service-account JSON.',
  '',
  'Search the WHOLE tree, and note the one inversion of the usual rule: tests, fixtures,',
  'sample data, seed files and example configuration ARE in scope for this pass. A real key',
  'committed to a test file is a real leak — it is live at the provider whatever directory',
  'it sits in.',
  '',
  'Distinguish a real credential from a placeholder. `AKIAIOSFODNN7EXAMPLE`, `xxx`,',
  '`your-api-key-here`, `changeme`, an obvious dummy in documentation, and a value read from',
  'the environment at runtime are NOT findings. A high-entropy string in a provider-specific',
  'format, a `-----BEGIN ... PRIVATE KEY-----` block, or a password in a URL is.',
  '',
  'NEVER put the secret itself in your output — not in `issue`, not in `fix`, not anywhere.',
  'The path, the line and the enclosing symbol locate it perfectly well, and your report is',
  'stored. Name the KIND of credential and where it is; quote nothing.',
  '',
  'Severity is about what the credential unlocks, not how sure you are:',
  '- critical: a live-looking credential for a real service (cloud provider, payment,',
  '  production database, signing key).',
  '- high: a credential-shaped value that plausibly still works, or a private key whose',
  '  purpose you could not establish.',
  '- medium: a committed secret that looks scoped to development, or one already rotated',
  '  or revoked as far as the repo shows.',
  '- low: hygiene — a secret-shaped value that is almost certainly inert but should not be',
  '  in version control.',
  '',
  'Do NOT edit any file and do NOT run git. Finding nothing is a normal and welcome result:',
  'return an empty findings array rather than padding it.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{ "findings": [ { "severity": "critical|high|medium|low", "path": "<file>", "line": 0, "symbol": "<enclosing function/key>", "kind": "<what sort of credential>", "cwe": "CWE-798", "issue": "<what is committed and what it unlocks — never the value>", "fix": "<rotate it, then remove it from the tree and from history>" } ] }',
] as const;

function buildPrompt(args: LlmBuildArgs): string {
  const d = args.detected as SecretSweepDetect;
  return [...SWEEP_RULES, '', ...REPO_IS_DATA_LINES, '', `Repository root: ${d.repoPath}`].join(
    '\n',
  );
}

/** The sweeper's own report names a findings list; a JSON fixture it opened while
 *  searching does not. Same guard as the review steps — without it, an empty array read
 *  out of some config file parses as "this repository is clean". */
const SWEEP_KEYS = ['findings'] as const;

export function parseSecretFindings(raw: unknown): SecretFinding[] {
  return (
    parseAgentJson(raw, (candidate) => {
      if (!hasAnyKey(candidate, SWEEP_KEYS)) return null;
      const findings = candidate.findings;
      if (!Array.isArray(findings)) return null;
      return findings
        .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
        .map((f) => {
          const line = Number(f.line);
          return {
            // An unrecognised severity lands on high, not medium: this sweeper reports
            // one kind of thing, and the cost of under-rating a live key is unbounded
            // while the cost of over-rating an inert one is a line the user scrolls past.
            severity: coerceReviewSeverity(f.severity, 'high'),
            path: typeof f.path === 'string' ? f.path : '',
            line: Number.isFinite(line) && line > 0 ? line : undefined,
            symbol: typeof f.symbol === 'string' ? f.symbol : undefined,
            kind: typeof f.kind === 'string' ? f.kind : undefined,
            cwe: normalizeCweId(f.cwe) ?? undefined,
            issue: typeof f.issue === 'string' ? f.issue : '',
            fix: typeof f.fix === 'string' ? f.fix : undefined,
          };
        })
        .filter((f) => f.path !== '' && f.issue !== '');
    }) ?? []
  );
}

/** One finding as the form renders it. The secret's value is never here — the sweeper is
 *  told not to emit it, and `recordReviewFindings` blanks any snippet that arrives anyway. */
function findingLine(f: SecretFinding): string {
  const where = f.line ? `${f.path}:${f.line}` : f.path;
  const kind = f.kind ? ` ${f.kind}` : '';
  return `**${f.severity.toUpperCase()}**${kind} — \`${where}\`${f.symbol ? ` (${f.symbol})` : ''}\n${f.issue}${f.fix ? `\n\n_Fix:_ ${f.fix}` : ''}`;
}

export const secretSweepStep: StepDefinition<SecretSweepDetect, SecretSweepApply> = {
  metadata: {
    id: '07_7-secret-sweep',
    workflowType: 'onboarding',
    index: 8.5,
    title: 'Committed secret sweep',
    description:
      'Searches the whole repository — fixtures and test data included — for credentials committed to version control. Reports what it finds; never blocks onboarding.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<SecretSweepDetect> {
    // A root that is not a readable directory means there is no tree to sweep, which is
    // a different statement from "no secrets found" and must not be reported as one.
    let scannable = false;
    try {
      scannable = (await stat(ctx.repoPath)).isDirectory();
    } catch {
      scannable = false;
    }
    if (!scannable) {
      ctx.logger.warn({ repoPath: ctx.repoPath }, 'secret sweep has no readable repository root');
    }
    return { repoPath: ctx.repoPath, scannable };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // Reads and greps the tree; it needs no browser and no container control plane.
    toolProfile: 'rag_only',
    timeoutMs: SWEEP_TIMEOUT_MS,
    // The findings ARE the form, so the sweep runs before it (see the lifecycle note in
    // LlmInvocationSpec.preForm).
    preForm: true,
    buildPrompt,
    skipIf: (args) => !(args.detected as SecretSweepDetect).scannable,
    bypassStub: () => ({ findings: [] }),
  },

  form(_ctx, _detected, llmOutput): FormSchema | null {
    const findings = parseSecretFindings(llmOutput ?? null);
    // Nothing found: no form, so onboarding flows straight through. A form here would
    // pause every clean repo to say nothing.
    if (findings.length === 0) return null;
    const shown = findings.slice(0, MAX_LISTED_IN_FORM);
    const hidden = findings.length - shown.length;
    return {
      title: 'Committed secrets',
      description:
        'These credentials appear to be committed to the repository. Rotate anything real — removing the file is not enough, since the value stays in git history and may already have been cloned. Onboarding continues either way.',
      fields: [
        ...shown.map((f, i) => ({
          id: `finding_${i}`,
          type: 'note' as const,
          label: f.kind ? `${f.kind} in ${f.path}` : f.path,
          body: findingLine(f),
          variant: (f.severity === 'critical' || f.severity === 'high' ? 'warning' : 'info') as
            'warning' | 'info',
        })),
        ...(hidden > 0
          ? [
              {
                id: 'truncated',
                type: 'note' as const,
                label: 'More findings',
                body: `${hidden} further finding(s) are not listed here. All of them are recorded against this task.`,
                variant: 'info' as const,
              },
            ]
          : []),
        {
          id: 'acknowledged',
          type: 'checkbox' as const,
          label: 'I have read these findings',
          description: 'Ticking this is a note to yourself; it does not change what happens next.',
          default: false,
        },
      ],
    };
  },

  async apply(ctx, args): Promise<SecretSweepApply> {
    // skipIf leaves llmOutput undefined — nothing was swept, so report that rather than
    // an empty (clean-looking) result.
    if (!args.detected.scannable) {
      return { swept: false, findings: [], counts: { critical: 0, high: 0, total: 0 } };
    }
    const findings = parseSecretFindings(args.llmOutput ?? null);
    await recordReviewFindings(
      ctx,
      '07_7-secret-sweep',
      findings.map((f) => ({
        reviewerId: 'secret-sweeper',
        severity: f.severity,
        issue: f.issue,
        path: f.path,
        lines: f.line,
        fix: f.fix,
        // Reported, never blocking: this step gates nothing.
        blocking: false,
        raw: f,
      })),
    );
    const counts = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      total: findings.length,
    };
    ctx.logger.info(counts, 'committed-secret sweep complete');
    return { swept: true, findings, counts };
  },
};
