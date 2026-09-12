import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { FRAMEWORK_PATTERNS, type FormSchema } from '@haive/shared';
import { coerceReviewSeverity, normalizeCweId } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import { REPO_IS_DATA_ONE_CLASS_LINES } from '../_untrusted-repo.js';
import { hasAnyKey, parseAgentJson } from '../workflow/_agent-json.js';
import { recordReviewFindings } from '../workflow/_review-findings.js';
import { resolveConfirmedProject } from './_helpers.js';
import { readComposerJson } from './_scope.js';
import { composerExcludeDirs } from './_scope-seed.js';
import { collectCodeFiles } from './_rag-collect.js';
import { scanForOpaquePaths, type OpaquePathHit } from './_opaque-path-scan.js';

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

const execFileAsync = promisify(execFile);

const SWEEP_TIMEOUT_MS = 30 * 60 * 1000;

/** Enough to show the user the shape of the problem; the durable rows carry them all. */
const MAX_LISTED_IN_FORM = 25;

/** Candidate paths handed to the model. A cap because this is an aid, not a report: past
 *  a few dozen the block stops being a list to rule on and starts being noise to skim. */
const OPAQUE_PATH_CAP = 40;

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

/** A candidate the agent ruled out, and why. The reason is the whole point: a candidate
 *  missing from both lists and one the agent considered and rejected used to look
 *  identical from here. */
export interface DismissedCandidate {
  path: string;
  line?: number;
  reason: string;
}

export interface SweepReport {
  findings: SecretFinding[];
  dismissed: DismissedCandidate[];
}

interface SecretSweepDetect {
  repoPath: string;
  scannable: boolean;
  /** Candidate FILES git tracks, resolved host-side. `undefined` means it could not be
   *  read (no git, or a tree that has not been committed yet) and must never render as
   *  "untracked"; `[]` means none of the candidates are tracked. */
  trackedFiles?: string[];
  /** Registration paths carrying a generated-looking segment, found deterministically so
   *  recall does not depend on whether this run has semantic search. Optional: a detect
   *  payload persisted before this existed replays without them. */
  opaquePaths?: OpaquePathHit[];
  opaquePathsOmitted?: number;
}

export interface SecretSweepApply {
  swept: boolean;
  findings: SecretFinding[];
  counts: { critical: number; high: number; total: number };
  /** Candidates the agent ruled out, with its reason. Present only when non-empty. */
  dismissed?: DismissedCandidate[];
  /** Candidates in neither list: the agent never said. Present only when non-empty,
   *  because a silent drop and a considered dismissal must not read the same. */
  candidatesUnruled?: string[];
}

const SWEEP_RULES = [
  'You are a SECRET SWEEPER. Your single job is to find credentials that are COMMITTED to',
  'this repository: API keys, access tokens, private keys, passwords, connection strings',
  'with embedded credentials, signing secrets, and service-account JSON.',
  '',
  'A SHARED SECRET counts even when it does not look like a credential. A fixed string that',
  'is the only thing standing between an anonymous caller and a privileged operation IS one',
  '— a guessable URL path segment guarding an unauthenticated endpoint, a static token',
  'compared with ==, a hard-coded webhook or cron key. Judge by what the string GUARDS, not',
  'by whether it is shaped like a key.',
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
  'Severity is about what the credential unlocks, not how sure you are, and not where the',
  'file sits. "Scoped to development" is about REACH — a throwaway value that only ever',
  'addresses a local container — never about the directory: a password for a real account',
  'on a real host is not development-scoped because it lives under a tests folder. That is',
  'the same rule as the inversion above.',
  '- critical: a live-looking credential for a real service (cloud provider, payment,',
  '  production database, signing key).',
  '- high: a credential-shaped value that plausibly still works, or a private key whose',
  '  purpose you could not establish. A password for a named account on a real host is',
  '  here, wherever it is committed.',
  '- medium: a committed secret whose REACH is a local/dev-only service, or one already',
  '  rotated or revoked as far as the repo shows.',
  '- low: hygiene — a secret-shaped value that is almost certainly inert but should not be',
  '  in version control.',
  '',
  'One tie-break, because medium and high can both fit the same string. When a credential',
  "names a REAL account — a person or a role at an organisation's own domain, an account on",
  'a host you did not create — it is HIGH even when the configuration beside it points at a',
  'local container. The value is what leaks, and the same value is what the real host',
  'accepts. Medium is for a credential whose reach is a throwaway local service and nothing',
  'else: a container default, a password generated for a dev stack.',
  '',
  'COMMITTED is the boundary of this pass. A secret counts when it sits in a TRACKED file or',
  'in git history. A file that merely exists in the working tree and is NOT tracked is a',
  "different mechanism's job and is not a finding here — if a tracked sibling carries the",
  'same value, report THAT path instead (a `.sample`, `.dist` or `.example` twin very often',
  'is the tracked one), and if the file was committed and later untracked, report it as',
  'history.',
  '',
  'You may run READ-ONLY git to settle that, and you should: `git ls-files -- <path>` prints',
  'the path when it is tracked and nothing when it is not, and `git log --oneline -- <path>`',
  'shows whether it was ever committed. Do NOT edit any file and do NOT run any git command',
  'that writes.',
  '',
  'Finding nothing is a normal and welcome result: return an empty findings array rather',
  'than padding it.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  '{',
  '  "findings": [ { "severity": "critical|high|medium|low", "path": "<file>", "line": 0, "symbol": "<enclosing function/key>", "kind": "<what sort of credential>", "cwe": "CWE-798", "issue": "<what is committed and what it unlocks — never the value>", "fix": "<rotate it, then remove it from the tree and from history>" } ],',
  '  "dismissed": [ { "path": "<file>", "line": 0, "reason": "<why this candidate is not a committed secret>" } ]',
  '}',
] as const;

/** The candidate block, or nothing when the pre-scan found none.
 *
 *  Framed as candidates to RULE ON rather than as findings: most are ordinary, and a
 *  block that reads as an accusation produces an obedient report instead of a judgement.
 *  The omission count is stated because a silently truncated list reads as a complete
 *  one — the same rule `changedFilesBlock` follows. */
function opaquePathBlock(d: SecretSweepDetect): string[] {
  const hits = d.opaquePaths ?? [];
  if (hits.length === 0) return [];
  const omitted = d.opaquePathsOmitted ?? 0;
  // Absent means UNKNOWN, which must not render as "untracked" — a payload written before
  // this existed, or a tree with no git, would otherwise put every candidate out of scope.
  const tracked = d.trackedFiles ? new Set(d.trackedFiles) : null;
  const mark = (file: string): string => {
    if (!tracked) return '';
    return tracked.has(file) ? ' [tracked]' : ' [UNTRACKED]';
  };
  return [
    '',
    'CANDIDATE registration paths — a deterministic pre-scan found these quoted paths',
    'carrying a segment that looks generated rather than named. Most will be ordinary:',
    'build hashes, vendored package paths, pack-format strings. Rule on each one, and',
    'report ONLY those where the segment is what authorizes the request. Read the',
    'registration around it — a route whose access check is `TRUE`, or absent, is the',
    'case that matters. This list is an aid, NOT the boundary of your search.',
    ...hits.map(
      (h) => `- ${h.file}:${h.line}${mark(h.file)} — \`${h.literal}\` (segment: \`${h.segment}\`)`,
    ),
    ...(omitted > 0
      ? [`- ...and ${omitted} more not listed; say so if you think the cap hid something.`]
      : []),
    '',
    'Account for EVERY candidate listed above. Each must come back exactly once: as an',
    'entry in `findings`, or as an entry in `dismissed` carrying its path and its line',
    'exactly as written above plus a one-line reason. A candidate you leave out of both is',
    'indistinguishable from one you never opened.',
  ];
}

function buildPrompt(args: LlmBuildArgs): string {
  const d = args.detected as SecretSweepDetect;
  return [
    ...SWEEP_RULES,
    ...opaquePathBlock(d),
    '',
    ...REPO_IS_DATA_ONE_CLASS_LINES,
    '',
    `Repository root: ${d.repoPath}`,
  ].join('\n');
}

/** The sweeper's own report names a findings list; a JSON fixture it opened while
 *  searching does not. Same guard as the review steps — without it, an empty array read
 *  out of some config file parses as "this repository is clean". */
const SWEEP_KEYS = ['findings'] as const;

export function parseSecretFindings(raw: unknown): SecretFinding[] {
  return parseSweepReport(raw).findings;
}

/** Both halves come off ONE accepted object: `dismissed` is read only from a payload that
 *  already carries `findings`, so the guard that stops a JSON fixture being read as the
 *  sweeper's own report covers it too. */
export function parseSweepReport(raw: unknown): SweepReport {
  return (
    parseAgentJson(raw, (candidate): SweepReport | null => {
      if (!hasAnyKey(candidate, SWEEP_KEYS)) return null;
      const findings = candidate.findings;
      if (!Array.isArray(findings)) return null;
      const parsedFindings = findings
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
      const rawDismissed = Array.isArray(candidate.dismissed) ? candidate.dismissed : [];
      const dismissed = rawDismissed
        .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
        .map((d) => {
          const line = Number(d.line);
          return {
            path: typeof d.path === 'string' ? d.path : '',
            line: Number.isFinite(line) && line > 0 ? line : undefined,
            reason: typeof d.reason === 'string' ? d.reason : '',
          };
        })
        .filter((d) => d.path !== '' && d.reason !== '');
      return { findings: parsedFindings, dismissed };
    }) ?? { findings: [], dismissed: [] }
  );
}

/** Candidates the report accounts for in neither list, as `file:line`.
 *
 *  Matched on the EXACT line, deliberately: four of this repo's candidates sit in one
 *  file, so a file-only match would let one finding mark all four ruled on. The prompt
 *  asks for the line verbatim for that reason. */
export function unruledCandidates(hits: readonly OpaquePathHit[], report: SweepReport): string[] {
  if (hits.length === 0) return [];
  const seen = new Set<string>();
  for (const f of report.findings) if (f.line) seen.add(`${f.path}:${f.line}`);
  for (const d of report.dismissed) if (d.line) seen.add(`${d.path}:${d.line}`);
  return hits.map((h) => `${h.file}:${h.line}`).filter((key) => !seen.has(key));
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
    // Candidate registration paths carrying a generated-looking segment. Deterministic
    // because the sweep's recall must not depend on a tool the run may not have:
    // MEASURED across three onboarding runs of one repo, the two whose prompt wired
    // `rag_search` found the secret route segments and the `ragMode: 'none'` task —
    // told to "discover with grep / ripgrep instead" — missed them TWICE, before and
    // after the class was named in the prompt. There is no keyword to grep for in
    // `cron-trash-cleanup/19dd78sa09dsa`.
    //
    // Scoped by the framework's own excludePaths (plus composer's declared layout) only
    // to keep the LIST readable — MEASURED, without it 28 of 31 candidates were
    // `includes/password.inc`'s base64 alphabet, core tar pack-format strings and
    // vendored `polyfill-mbstring`. It is not the sweep's boundary: the prompt still
    // says to search the whole tree, and this is an aid on top of that.
    let opaquePaths: OpaquePathHit[] = [];
    let opaquePathsOmitted = 0;
    let trackedFiles: string[] | undefined;
    if (scannable) {
      try {
        const { framework } = await resolveConfirmedProject(ctx.db, ctx.taskId);
        const pattern = framework
          ? FRAMEWORK_PATTERNS[framework as keyof typeof FRAMEWORK_PATTERNS]
          : undefined;
        const files = await collectCodeFiles(ctx.repoPath, {
          exclude: [
            ...(pattern?.excludePaths ?? []),
            ...composerExcludeDirs(await readComposerJson(ctx.repoPath)),
          ],
        });
        const scan = await scanForOpaquePaths(ctx.repoPath, files, OPAQUE_PATH_CAP);
        opaquePaths = scan.hits;
        opaquePathsOmitted = scan.omitted;
      } catch (err) {
        // An aid, never a gate: a sweep with no candidate list is the sweep that shipped
        // before this existed, and must still run.
        ctx.logger.warn(
          { err },
          'secret sweep: opaque-path pre-scan failed; continuing without it',
        );
      }
      // Which candidate FILES git actually tracks. Resolved HOST-SIDE because "committed"
      // is this step's whole boundary and nothing could previously tell the two apart:
      // the prompt forbade git outright, and MEASURED on four runs of one repo all four
      // models reported `test-playwright/.env` as a committed secret when that file had
      // been untracked since `cef2449` and the tracked copy was its `.env.sample` twin.
      const candidateFiles = [...new Set(opaquePaths.map((h) => h.file))];
      if (candidateFiles.length > 0) {
        try {
          const { stdout } = await execFileAsync('git', ['ls-files', '--', ...candidateFiles], {
            cwd: ctx.repoPath,
            maxBuffer: 4 * 1024 * 1024,
          });
          trackedFiles = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
        } catch (err) {
          // No git, or a tree onboarding before its first commit. Left UNDEFINED so the
          // prompt renders no marker: "unknown" must not print as "untracked".
          ctx.logger.warn({ err }, 'secret sweep: could not read tracked-file state');
        }
      }
    }
    return { repoPath: ctx.repoPath, scannable, opaquePaths, opaquePathsOmitted, trackedFiles };
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

  form(_ctx, detected, llmOutput): FormSchema | null {
    const report = parseSweepReport(llmOutput ?? null);
    const findings = report.findings;
    // Nothing found: no form, so onboarding flows straight through. A form here would
    // pause every clean repo to say nothing. An unruled candidate is NOT a reason to
    // raise one either — it is a gap in the report, not a claim about the repository.
    if (findings.length === 0) return null;
    const unruled = unruledCandidates(detected.opaquePaths ?? [], report);
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
        ...(unruled.length > 0
          ? [
              {
                id: 'unruled',
                type: 'note' as const,
                label: 'Candidates not ruled on',
                body: `The sweep was handed ${(detected.opaquePaths ?? []).length} candidate path(s) and did not say either way about ${unruled.length} of them: ${unruled.join(', ')}. They are neither reported nor cleared.`,
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
    const report = parseSweepReport(args.llmOutput ?? null);
    const findings = report.findings;
    const unruled = unruledCandidates(args.detected.opaquePaths ?? [], report);
    await recordReviewFindings(
      ctx,
      '07_7-secret-sweep',
      findings.map((f) => ({
        reviewerId: 'secret-sweeper',
        cliInvocationId: args.llmInvocationId ?? null,
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
    if (unruled.length > 0) {
      ctx.logger.warn(
        { unruled, candidates: (args.detected.opaquePaths ?? []).length },
        'secret sweep: candidates the agent ruled on neither way',
      );
    }
    ctx.logger.info(
      { ...counts, dismissed: report.dismissed.length, unruled: unruled.length },
      'committed-secret sweep complete',
    );
    return {
      swept: true,
      findings,
      counts,
      ...(report.dismissed.length > 0 ? { dismissed: report.dismissed } : {}),
      ...(unruled.length > 0 ? { candidatesUnruled: unruled } : {}),
    };
  },
};
