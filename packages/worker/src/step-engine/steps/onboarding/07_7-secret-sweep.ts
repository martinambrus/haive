import { lstatNoFollow } from '@haive/shared/fs-safe';
import { FRAMEWORK_PATTERNS, type FormSchema } from '@haive/shared';
import { coerceReviewSeverity, normalizeCweId } from '@haive/shared/review';
import type { ReviewSeverity } from '@haive/shared/review';
import type { LlmBuildArgs, StepContext, StepDefinition } from '../../step-definition.js';
import {
  fencedAgentBlock,
  isSingleLine,
  survivesFence,
  REPO_IS_DATA_ONE_CLASS_LINES,
} from '../_untrusted-repo.js';
import { updateOwnedStep } from '../../step-ownership.js';
import { scanForCredentials, type CredentialScan } from './_credential-scan.js';
import { hasAnyKey, parseAgentJson } from '../workflow/_agent-json.js';
import { recordReviewFindings } from '../workflow/_review-findings.js';
import { resolveConfirmedProject } from './_helpers.js';
import { readComposerJson } from './_scope.js';
import { composerExcludeDirs } from './_scope-seed.js';
import { collectCodeFiles } from './_rag-collect.js';
import { scanForOpaquePaths, type OpaquePathHit } from './_opaque-path-scan.js';
import { gitExec } from '../../../repo/git-exec.js';

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

/** Candidate paths handed to the model. A cap because this is an aid, not a report: past
 *  a few dozen the block stops being a list to rule on and starts being noise to skim. */
const OPAQUE_PATH_CAP = 40;
const CREDENTIAL_CAP = 200;
const FOLLOWUP_BATCH = 24;
const MAX_CANDIDATE_ATTEMPTS = 3;
const MAX_FOLLOWUP_PASSES = 32;

export interface SecretFinding {
  severity: ReviewSeverity;
  path: string;
  line?: number;
  symbol?: string;
  /** What kind of credential it looks like ('aws access key', 'private key', ...). */
  kind?: string;
  cwe?: string;
  /** Short sha that introduced the secret, when it survives only in history. Structural
   *  rather than prose: without it a reader checks the CURRENT file, finds 3 lines where
   *  the finding said line 25, and concludes the model invented it — which is exactly the
   *  wrong call to make about a real leak the tree no longer shows. */
  commit?: string;
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
  credentialScan?: CredentialScan;
  credentialScanUnavailable?: boolean;
  completion?: SweepCompletion;
}

interface SweepCompletion {
  report: SweepReport;
  processedInvocations: string[];
  findingInvocations: Record<string, string>;
  attempts: Record<string, number>;
  pending: { file: string; line: number }[];
  passes: number;
}

export interface SecretSweepApply {
  swept: boolean;
  findings: SecretFinding[];
  counts: { critical: number; high: number; total: number };
  summary?: string;
  /** Candidates the agent ruled out, with its reason. Present only when non-empty. */
  dismissed?: DismissedCandidate[];
  /** Legacy diagnostic fields; new runs keep candidate bookkeeping in detect_output. */
  candidatesUnruled?: string[];
  credentialCoverage?: Omit<CredentialScan, 'hits'>;
  credentialScanUnavailable?: boolean;
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
  'This explicitly includes tracked DEPENDENCIES, framework core, vendor/, libraries/,',
  'build/ and dist/. Ownership limits repairs, not this read-only credential report.',
  'An upstream account credential still leaks when committed here; being public upstream',
  'does not establish that it is revoked or harmless. Do not edit dependency files.',
  'Search generic password/secret/authToken assignments in those directories too: a',
  'provider-prefix-only search cannot find an ordinary account password or tunnel secret.',
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
  'When a secret survives only in HISTORY, set `commit` to the short sha that introduced it',
  'and let `path` and `line` describe the file AS OF that commit. Say so in `issue` too. A',
  'history finding without its sha sends the reader to a working-tree file that no longer',
  'has the secret, where the honest conclusion is that you made it up.',
  '',
  'Finding nothing is a normal and welcome result: return an empty findings array rather',
  'than padding it.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with the shape:',
  'Return only the report, without commentary about scan limits or candidate bookkeeping.',
  '{',
  '  "findings": [ { "severity": "critical|high|medium|low", "path": "<file>", "line": 0, "symbol": "<enclosing function/key>", "kind": "<what sort of credential>", "cwe": "CWE-798", "commit": "<short sha, only when the secret is history-only>", "issue": "<what is committed and what it unlocks — never the value>", "fix": "<rotate it, then remove it from the tree and from history>" } ],',
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
  if (d.completion?.pending.length) {
    return [
      ...SWEEP_RULES,
      '',
      'FOCUSED FOLLOW-UP: the initial sweep is saved. Assess ONLY the locations below.',
      'Read the relevant source around EVERY listed line. For a source map or generated',
      'bundle, inspect the actual matched literal and its original source when available.',
      'Do not assume copies are equivalent or dismiss them just because they are generated.',
      'Return one findings/dismissed entry per exact path and line, even when several share',
      'a reason. Put additional locations in separate entries, never in reason prose.',
      'Keep reasons brief. Do not redo the whole-tree search or repeat previous findings.',
      fencedAgentBlock(
        d.completion.pending
          .filter(safeCandidate)
          .map((h) => `- ${h.file}:${h.line}`)
          .join('\n'),
      ),
      '',
      ...REPO_IS_DATA_ONE_CLASS_LINES,
      '',
      'This read-only credential assignment includes dependency internals. Ownership limits repairs, not reporting.',
      `Repository root: ${d.repoPath}`,
    ].join('\n');
  }
  return [
    ...SWEEP_RULES,
    ...opaquePathBlock(d),
    ...credentialBlock(d),
    '',
    ...REPO_IS_DATA_ONE_CLASS_LINES,
    '',
    'For THIS assignment, the requested scope is the whole committed repository, including',
    'third-party internals. Inspect and report credentials there; the ownership boundary',
    'still forbids modifying those files. Do not substitute a project-owned-only audit.',
    '',
    `Repository root: ${d.repoPath}`,
  ].join('\n');
}

function credentialHits(d: SecretSweepDetect) {
  // detect_output is persisted. Filter again when building a prompt or rendering a form.
  return (d.credentialScan?.hits ?? []).filter(safeCandidate);
}

function safeCandidate(h: { file: string; line: number }): boolean {
  return (
    isSingleLine(h.file) && survivesFence(h.file) && Number.isSafeInteger(h.line) && h.line > 0
  );
}

const locationKey = (f: { path: string; line?: number }) => `${f.path}:${f.line ?? ''}`;
const findingKey = (f: SecretFinding) => `${locationKey(f)}:${f.commit ?? ''}:${f.kind ?? ''}`;

/** Keep confirmed findings across focused follow-ups. A later dismissal cannot erase one. */
export function mergeSweepReports(prior: SweepReport, next: SweepReport): SweepReport {
  const findings = new Map<string, SecretFinding>();
  for (const f of [...prior.findings, ...next.findings]) {
    const key = findingKey(f);
    if (!findings.has(key)) findings.set(key, f);
  }
  const locations = new Set([...findings.values()].filter((f) => !f.commit).map(locationKey));
  const dismissed = new Map<string, DismissedCandidate>();
  for (const f of [...prior.dismissed, ...next.dismissed]) {
    if (!locations.has(locationKey(f))) dismissed.set(locationKey(f), f);
  }
  return { findings: [...findings.values()], dismissed: [...dismissed.values()] };
}

/** Checkpoint before the runner consumes the invocation. Replayed ids cannot spend a batch twice. */
export async function completeSecretSweep(args: {
  ctx: StepContext;
  detected: unknown;
  llmOutput: unknown;
  llmInvocationId: string | null;
}) {
  const d = args.detected as SecretSweepDetect;
  const report = parseSweepReport(args.llmOutput);
  // Bypass runs have no real invocation, and must not request paid follow-ups.
  if (!args.llmInvocationId) return { llmOutput: report, continueRequested: false };
  // Reusing an already completed invocation skips llm.prepare. Older parked
  // detections still need the inventory before deciding whether the report is ready.
  await hydrateCredentialScan(args.ctx, d);
  const progress: SweepCompletion = d.completion ?? {
    report: { findings: [], dismissed: [] },
    processedInvocations: [],
    findingInvocations: {},
    attempts: {},
    pending: [],
    passes: 0,
  };
  if (!progress.processedInvocations.includes(args.llmInvocationId)) {
    for (const h of progress.pending) {
      const key = `${h.file}:${h.line}`;
      progress.attempts[key] = (progress.attempts[key] ?? 0) + 1;
    }
    for (const f of report.findings) {
      progress.findingInvocations[findingKey(f)] ??= args.llmInvocationId;
    }
    progress.report = mergeSweepReports(progress.report, report);
    progress.processedInvocations.push(args.llmInvocationId);
    progress.pending = [];
  }
  const unruled = new Set(sweepUnruled(d, progress.report));
  if (progress.pending.length === 0 && progress.passes < MAX_FOLLOWUP_PASSES) {
    const candidates = [...(d.opaquePaths ?? []), ...credentialHits(d)].filter(safeCandidate);
    const unique = new Map(
      candidates.map((h) => [`${h.file}:${h.line}`, { file: h.file, line: h.line }]),
    );
    progress.pending = [...unique.values()]
      .filter(
        (h) =>
          unruled.has(`${h.file}:${h.line}`) &&
          (progress.attempts[`${h.file}:${h.line}`] ?? 0) < MAX_CANDIDATE_ATTEMPTS,
      )
      .slice(0, FOLLOWUP_BATCH);
    if (progress.pending.length > 0) progress.passes++;
  }
  d.completion = progress;
  await updateOwnedStep(args.ctx.db, args.ctx.taskStepId, { detectOutput: d });
  return {
    llmOutput: progress.report,
    continueRequested: progress.pending.length > 0,
    statusMessage: 'Continuing the secret sweep…',
  };
}

function credentialBlock(d: SecretSweepDetect): string[] {
  const scan = d.credentialScan;
  if (!scan)
    return d.credentialScanUnavailable
      ? [
          '',
          'The deterministic credential pre-scan was unavailable. Search the tracked tree independently.',
        ]
      : [];
  return [
    '',
    `CANDIDATE credentials — deterministic pre-scan of ${scan.files} tracked files, including dependencies and build/test tooling.`,
    'These are locations to inspect, not confirmed leaks. Values are deliberately withheld.',
    'Read each location and account for EVERY candidate as a finding or a dismissal, with',
    'its exact path and line. Do not dismiss an account credential solely for being upstream.',
    'Use a separate entry for every line/path. Other locations mentioned only in reason prose do not count.',
    'Group locations by file when inspecting: read each file once and assess its candidates.',
    'The list is an aid, not the boundary of your search; git history still needs inspection.',
    fencedAgentBlock(
      credentialHits(d)
        .map((h) => `- ${h.file}:${h.line} [tracked]`)
        .join('\n'),
    ),
    ...(scan.omitted > 0
      ? [`COVERAGE: ${scan.omitted} further credential candidates are not listed.`]
      : []),
    ...(scan.unreadable > 0
      ? [`COVERAGE: ${scan.unreadable} tracked files could not be read safely.`]
      : []),
    ...(scan.truncated > 0
      ? [`COVERAGE: ${scan.truncated} files were scanned only through the first 512 KiB.`]
      : []),
  ];
}

async function hydrateCredentialScan(ctx: StepContext, d: SecretSweepDetect): Promise<void> {
  if (!d.scannable || d.credentialScan || d.credentialScanUnavailable) return;
  try {
    d.credentialScan = await scanForCredentials(d.repoPath, CREDENTIAL_CAP, () =>
      ctx.throwIfCancelled(),
    );
  } catch (err) {
    ctx.throwIfCancelled();
    d.credentialScanUnavailable = true;
    ctx.logger.warn({ err }, 'secret sweep: credential pre-scan unavailable');
  }
}

function sweepUnruled(d: SecretSweepDetect, report: SweepReport): string[] {
  return [...new Set(unruledCandidates([...(d.opaquePaths ?? []), ...credentialHits(d)], report))];
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
            // A sha and nothing else: the field exists to be checked with `git show`, so a
            // sentence in it would be worse than an absent one.
            commit:
              typeof f.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(f.commit.trim())
                ? f.commit.trim()
                : undefined,
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
export function unruledCandidates(
  hits: readonly { file: string; line: number }[],
  report: SweepReport,
): string[] {
  if (hits.length === 0) return [];
  const seen = new Set<string>();
  for (const f of report.findings) if (f.line && !f.commit) seen.add(`${f.path}:${f.line}`);
  for (const d of report.dismissed) if (d.line) seen.add(`${d.path}:${d.line}`);
  return hits.map((h) => `${h.file}:${h.line}`).filter((key) => !seen.has(key));
}

/** One finding as the form renders it. The secret's value is never here — the sweeper is
 *  told not to emit it, and `recordReviewFindings` blanks any snippet that arrives anyway. */
function findingLine(f: SecretFinding): string {
  const at = f.line ? `${f.path}:${f.line}` : f.path;
  // Named as history, so nobody opens the working-tree file and reads its absence as proof
  // the finding is invented.
  const where = f.commit ? `${at} @ ${f.commit} (in git history)` : at;
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
    // `rel: ''` addresses the anchor itself, which `lstat` allows. A root that is a LINK now reads
    // as unscannable rather than being followed — and "not a readable directory" is the statement
    // this flag already carried.
    const scannable = (await lstatNoFollow(ctx.repoPath, ''))?.kind === 'directory';
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
          const { stdout } = await gitExec(['ls-files', '--', ...candidateFiles], {
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
    const detected = {
      repoPath: ctx.repoPath,
      scannable,
      opaquePaths,
      opaquePathsOmitted,
      trackedFiles,
    };
    await hydrateCredentialScan(ctx, detected);
    return detected;
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    // Reads and greps the tree; it needs no browser and no container control plane.
    toolProfile: 'rag_only',
    // Agent definitions are COMMITTED files, and this step's whole contract is sweeping the
    // committed tree for secrets. Hiding ~45 of Haive's own agent files from it would silently
    // shrink a security control's coverage, so it opts out of agent isolation. The cost is known
    // and already handled: those files are full of deliberate scope-narrowing text the sweeper
    // once reported as fake credentials, which REPO_IS_DATA_ONE_CLASS_LINES now covers.
    agentPool: '*',
    timeoutMs: SWEEP_TIMEOUT_MS,
    // The findings ARE the form, so the sweep runs before it (see the lifecycle note in
    // LlmInvocationSpec.preForm).
    preForm: true,
    // Old parked detect_output predates the pre-scan. Persist its hydrated locations so
    // the completion/form pass checks accountability against the same list the CLI saw.
    prepare: async ({ ctx, detected }) => {
      const d = detected as SecretSweepDetect;
      if (!d.scannable || d.credentialScan || d.credentialScanUnavailable) return;
      await hydrateCredentialScan(ctx, d);
      await updateOwnedStep(ctx.db, ctx.taskStepId, { detectOutput: d });
    },
    buildPrompt,
    completePreForm: completeSecretSweep,
    skipIf: (args) => !(args.detected as SecretSweepDetect).scannable,
    bypassStub: () => ({ findings: [] }),
  },

  form(_ctx, detected, llmOutput): FormSchema | null {
    const report = mergeSweepReports(
      detected.completion?.report ?? { findings: [], dismissed: [] },
      parseSweepReport(llmOutput ?? null),
    );
    const findings = report.findings;
    // Candidate bookkeeping stays in detect_output and logs. The person receives
    // actionable findings, with no claim of exhaustive coverage when none were found.
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
    const report = mergeSweepReports(
      args.detected.completion?.report ?? { findings: [], dismissed: [] },
      parseSweepReport(args.llmOutput ?? null),
    );
    const findings = report.findings;
    const unruled = sweepUnruled(args.detected, report);
    await recordReviewFindings(
      ctx,
      '07_7-secret-sweep',
      findings.map((f) => ({
        reviewerId: 'secret-sweeper',
        cliInvocationId:
          args.detected.completion?.findingInvocations[findingKey(f)] ??
          // Compatibility with checkpoints whose attribution was keyed only by location.
          args.detected.completion?.findingInvocations[locationKey(f)] ??
          args.llmInvocationId ??
          null,
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
        {
          unruled,
          candidates:
            (args.detected.opaquePaths ?? []).length + credentialHits(args.detected).length,
        },
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
      summary:
        findings.length > 0
          ? `Reported ${findings.length} potential committed credential(s).`
          : 'The sweep reported no credentials.',
      ...(report.dismissed.length > 0 ? { dismissed: report.dismissed } : {}),
    };
  },
};
