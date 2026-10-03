import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ensureDirNoFollow, readTextNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { ensureSandboxWritableTree } from '../../../repo/worktree-permissions.js';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import {
  TaskCancelledError,
  type StepContext,
  type StepDefinition,
} from '../../step-definition.js';
import { recordLedgerEntry } from '../../task-ledger.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { hasWorkspaceEntry } from '../../workspace-probe.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import {
  DDEV_PROJECT_MOUNT,
  ddevExec,
  type DdevRunnerHandle,
} from '../../../sandbox/ddev-runner.js';
import { appRunnerExec } from '../../../sandbox/app-runner.js';
import { ensureAppServing, withDdevProgress, type ServingRuntime } from './_app-runtime.js';
import {
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
} from '../../../sandbox/ddev-playwright.js';
import { classifyTestEnvFailure } from './_test-env-guard.js';
import type { TestFramework } from './08b-test-management.js';
import { isDdevAgentFixableFailure } from '../../../sandbox/ddev-build-guard.js';
import { collectChangedLineMap, type ChangedLineMap } from './_impl-changes.js';
import {
  parsePhpcsJsonReport,
  phpcsReportFlags,
  preExistingFact,
  renderBlockingList,
  scopePhpcsReport,
  type ScopedReport,
} from './_lint-scope.js';

// Phase 5 verify: runs the project's test / lint / typecheck checks and records
// the outcome for gate 2. Each of the three slots is framework-aware — a JS
// package.json script, a composer.json script, or a framework binary
// (phpunit/pytest for test, phpcs for lint, phpstan for typecheck). PHP/Python
// commands run inside the per-task DDEV runner when the project uses DDEV
// (where the toolchain lives), else host-side. The 3-checkbox form is unchanged.

const exec = promisify(execFile);

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'none';

/** A resolved command for one verify slot. `host` runs via execFile in the
 *  workspace; `ddev` runs via ddevExec inside the runner (argv is the ddev
 *  subcommand, without the leading `ddev`). null = nothing detected for the slot. */
export interface SlotCommand {
  kind: 'host' | 'ddev';
  label: string;
  argv: string[];
}

type SlotRunner = 'pm' | 'composer' | 'phpunit' | 'pytest' | 'phpcs' | 'phpstan';

interface VerifyDetect {
  workspacePath: string;
  ddevMode: boolean;
  /** The project's test framework, carried over from 08b-test-management's detect — the only
   *  place it is identified. This step resolves a SlotCommand with a LABEL, not a framework,
   *  so it cannot classify an environment failure on its own. Optional because detect_output
   *  is persisted and replayed: a payload written before this field existed reads as null and
   *  behaves exactly as it did. */
  testFramework?: TestFramework | null;
  test: SlotCommand | null;
  lint: SlotCommand | null;
  typecheck: SlotCommand | null;
}

interface CheckResult {
  ran: boolean;
  passed: boolean;
  command: string | null;
  output: string;
  /** Set only when the verdict was limited to the lines this change wrote. */
  scope?: { blocking: number; preExisting: number };
  /** Why the verdict is qualified: not limited to the change, or the check could not run. */
  note?: string;
}

/** Mandatory post-implementation HTTP smoke: boots the app once and records what
 *  it actually serves, independent of test/lint detection or `browserTesting`.
 *  Kept OUT of `passed` (so it never routes back to implement via the fixLoop) and
 *  surfaced at gate-2 for a human decision. `ran:false` = no servable runtime, or
 *  the probe itself was unavailable — gate-2 treats that as non-blocking. */
interface RuntimeSmoke {
  ran: boolean;
  passed: boolean;
  httpStatus: number | null;
  url: string | null;
  errorExcerpt: string;
}

interface VerifyApply {
  test: CheckResult;
  lint: CheckResult;
  typecheck: CheckResult;
  passed: boolean;
  runtimeSmoke: RuntimeSmoke | null;
  /** Amber caveat for the step card, read by the runner's computeDegradedNote. Set only when
   *  NO check ran — `passed` is true there because nothing failed, which reads as a green
   *  verification of a workspace nothing was verified in. */
  degradedNote?: string;
}

/**
 * The amber caveat for the step card.
 *
 * Both inputs can be true at once — an environment blocker is itself a reason nothing ran —
 * so they are JOINED rather than one winning, and the blocker leads because it is the half
 * that names a repair. `''` when neither applies, which is the green path.
 */
export function buildVerifyDegradedNote(
  blocker: { reason: string; repair: string } | null,
  unverified: string,
  lintNote = '',
): string {
  return [
    blocker
      ? `The test suite could not be run: ${blocker.reason}. The suite is NOT known to be ` +
        `green, and no fix round can repair this. Repair with: ${blocker.repair}`
      : '',
    unverified,
    lintNote,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Why no check ran, named per slot, or `''` when at least one did.
 *
 *  `passed` is computed as "nothing that ran failed", so three skipped slots produce
 *  `passed: true` — the same value a fully green run produces. Gate 2 reads that as
 *  `allPassed` and pre-selects Approve, while its status table omits every non-run check, so
 *  the developer is shown a clean gate for a workspace where test, lint and typecheck were
 *  never executed. Same rule as 07b's `excludedDimensions`: a check nobody ran yields exactly
 *  the same empty result as one that passed, and only saying so keeps the two apart.
 *
 *  Deliberately per-slot: "no runner exists in this repo" and "a runner exists and you
 *  unticked it" are different facts, and only the first is nobody's decision. */
export function buildUnverifiedNote(
  slots: { test: SlotCommand | null; lint: SlotCommand | null; typecheck: SlotCommand | null },
  results: { test: CheckResult; lint: CheckResult; typecheck: CheckResult },
): string {
  if (results.test.ran || results.lint.ran || results.typecheck.ran) return '';
  const undetected: string[] = [];
  const unticked: string[] = [];
  for (const name of ['test', 'lint', 'typecheck'] as const) {
    if (results[name].note) continue;
    (slots[name] === null ? undetected : unticked).push(name);
  }
  const parts = [
    `No verification check ran this pass, so this step passing means nothing was checked — not that everything passed.`,
  ];
  if (undetected.length > 0) {
    parts.push(
      `No runner was detected in this workspace for: ${undetected.join(', ')}. Only the workspace ROOT is searched for a package.json / composer.json script or a phpunit / pytest / phpcs / phpstan config, so a project whose tooling lives in a subdirectory reports none.`,
    );
  }
  if (unticked.length > 0) {
    parts.push(`Detected but not selected for this pass: ${unticked.join(', ')}.`);
  }
  return parts.join('\n\n');
}

/**
 * Build the command for a verify slot from the detected runner. Pure (no IO) so
 * it is unit-testable. PHP/Python runners go through DDEV when `ddevMode`, else
 * run the binary host-side; JS package scripts always run host-side.
 */
export function buildVerifyCommand(
  spec: { runner: SlotRunner; pm?: PackageManager; script?: string },
  ddevMode: boolean,
): SlotCommand | null {
  switch (spec.runner) {
    case 'pm': {
      if (!spec.pm || spec.pm === 'none' || !spec.script) return null;
      return {
        kind: 'host',
        label: `${spec.pm} run ${spec.script}`,
        argv: [spec.pm, 'run', spec.script],
      };
    }
    case 'composer': {
      if (!spec.script) return null;
      if (ddevMode)
        return {
          kind: 'ddev',
          label: `ddev composer ${spec.script}`,
          argv: ['composer', spec.script],
        };
      return { kind: 'host', label: `composer ${spec.script}`, argv: ['composer', spec.script] };
    }
    case 'phpunit':
      if (ddevMode)
        return {
          kind: 'ddev',
          label: 'ddev exec vendor/bin/phpunit',
          argv: ['exec', 'vendor/bin/phpunit'],
        };
      return { kind: 'host', label: 'vendor/bin/phpunit', argv: ['vendor/bin/phpunit'] };
    case 'phpcs':
      if (ddevMode)
        return {
          kind: 'ddev',
          label: 'ddev exec vendor/bin/phpcs',
          argv: ['exec', 'vendor/bin/phpcs'],
        };
      return { kind: 'host', label: 'vendor/bin/phpcs', argv: ['vendor/bin/phpcs'] };
    case 'phpstan':
      if (ddevMode)
        return {
          kind: 'ddev',
          label: 'ddev exec vendor/bin/phpstan analyse',
          argv: ['exec', 'vendor/bin/phpstan', 'analyse'],
        };
      return {
        kind: 'host',
        label: 'vendor/bin/phpstan analyse',
        argv: ['vendor/bin/phpstan', 'analyse'],
      };
    case 'pytest':
      if (ddevMode) return { kind: 'ddev', label: 'ddev exec pytest', argv: ['exec', 'pytest'] };
      return { kind: 'host', label: 'pytest', argv: ['pytest'] };
  }
}

async function readJsonScripts(workspace: string, file: string): Promise<Record<string, string>> {
  // One lenient read for the probe and the read together: `null` is absent, unreadable or refused,
  // and all three already meant "no scripts" here.
  const { anchor, prefix } = workspaceAnchor(workspace);
  const raw = await readTextNoFollow(anchor, `${prefix}${file}`);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const s = parsed?.scripts;
    return s && typeof s === 'object' ? (s as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function detectPackageManager(workspace: string): Promise<PackageManager> {
  if (await hasWorkspaceEntry(workspace, 'pnpm-lock.yaml')) return 'pnpm';
  if (await hasWorkspaceEntry(workspace, 'yarn.lock')) return 'yarn';
  if (await hasWorkspaceEntry(workspace, 'package-lock.json')) return 'npm';
  if (await hasWorkspaceEntry(workspace, 'package.json')) return 'npm';
  return 'none';
}

function pick(scripts: Record<string, string>, names: string[]): string | null {
  for (const n of names) {
    if (typeof scripts[n] === 'string' && scripts[n].length > 0) return n;
  }
  return null;
}

/** Resolve the three verify-slot commands across JS / composer / PHP / Python.
 *  Precedence per slot: JS package script → composer script → framework binary. */
async function resolveSlots(
  workspace: string,
  ddevMode: boolean,
): Promise<{ test: SlotCommand | null; lint: SlotCommand | null; typecheck: SlotCommand | null }> {
  const pmScripts = await readJsonScripts(workspace, 'package.json');
  const composerScripts = await readJsonScripts(workspace, 'composer.json');
  const pm = await detectPackageManager(workspace);
  const has = async (...names: string[]) => {
    for (const n of names) if (await hasWorkspaceEntry(workspace, n)) return true;
    return false;
  };
  const hasPhpunit = await has('phpunit.xml', 'phpunit.xml.dist');
  const hasPytest = await has('pytest.ini', 'pyproject.toml', 'tox.ini');
  const hasPhpcs = await has('phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml');
  const hasPhpstan = await has('phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon');

  const testJs = pick(pmScripts, ['test', 'test:unit', 'test:ci']);
  const test = testJs
    ? buildVerifyCommand({ runner: 'pm', pm, script: testJs }, ddevMode)
    : composerScripts.test !== undefined
      ? buildVerifyCommand({ runner: 'composer', script: 'test' }, ddevMode)
      : hasPhpunit
        ? buildVerifyCommand({ runner: 'phpunit' }, ddevMode)
        : hasPytest
          ? buildVerifyCommand({ runner: 'pytest' }, ddevMode)
          : null;

  const lintJs = pick(pmScripts, ['lint', 'lint:check', 'eslint']);
  const lintComposer = pick(composerScripts, ['lint', 'phpcs', 'cs']);
  const lint = lintJs
    ? buildVerifyCommand({ runner: 'pm', pm, script: lintJs }, ddevMode)
    : lintComposer
      ? buildVerifyCommand({ runner: 'composer', script: lintComposer }, ddevMode)
      : hasPhpcs
        ? buildVerifyCommand({ runner: 'phpcs' }, ddevMode)
        : null;

  const typeJs = pick(pmScripts, ['typecheck', 'type-check', 'tsc']);
  const typeComposer = pick(composerScripts, ['phpstan', 'analyse', 'analyze', 'stan']);
  const typecheck = typeJs
    ? buildVerifyCommand({ runner: 'pm', pm, script: typeJs }, ddevMode)
    : typeComposer
      ? buildVerifyCommand({ runner: 'composer', script: typeComposer }, ddevMode)
      : hasPhpstan
        ? buildVerifyCommand({ runner: 'phpstan' }, ddevMode)
        : null;

  return { test, lint, typecheck };
}

interface SlotRun {
  ran: boolean;
  exitCode: number;
  output: string;
}

/** A shell reports a missing command as 127; a host binary that cannot start reads the same. */
const NOT_FOUND_EXIT = 127;

async function execSlot(
  cmd: SlotCommand,
  ctx: StepContext,
  workspace: string,
  handle: DdevRunnerHandle | null,
  extraArgs: string[] = [],
): Promise<SlotRun> {
  if (cmd.kind === 'ddev') {
    if (!handle) return { ran: false, exitCode: 1, output: 'DDEV runner unavailable — skipped' };
    // A full suite is minutes of silence, and a fixed status line is indistinguishable from a
    // stuck task. Same live status every long DDEV op already uses: latest line + an elapsed
    // counter that ticks through silent phases.
    const res = await withDdevProgress(
      ctx,
      `Running ${cmd.label}`,
      (onLine) =>
        ddevExec(handle, [...cmd.argv, ...extraArgs].join(' '), { timeoutMs: 600_000, onLine }),
      { initialLine: cmd.argv.join(' ') },
    );
    return { ran: true, exitCode: res.exitCode, output: res.output.slice(-4000) };
  }
  try {
    const [bin, ...rest] = cmd.argv;
    // execFile buffers, so there is no line to stream — the elapsed counter is the half that
    // matters here, and withDdevProgress ticks it for an op with no output of its own.
    const { stdout, stderr } = await withDdevProgress(ctx, `Running ${cmd.label}`, () =>
      exec(bin!, [...rest, ...extraArgs], {
        cwd: workspace,
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
    return { ran: true, exitCode: 0, output: `${stdout}${stderr}`.slice(-4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    const exitCode = typeof e.code === 'number' ? e.code : e.code === 'ENOENT' ? NOT_FOUND_EXIT : 1;
    return { ran: true, exitCode, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-4000) };
  }
}

async function runSlot(
  cmd: SlotCommand,
  ctx: StepContext,
  workspace: string,
  handle: DdevRunnerHandle | null,
): Promise<CheckResult> {
  const run = await execSlot(cmd, ctx, workspace, handle);
  return {
    ran: run.ran,
    passed: run.ran && run.exitCode === 0,
    command: cmd.label,
    output: run.output,
  };
}

const REPORT_DIR = '.haive/verify';
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PHPCS_NOT_FOUND = 'vendor/bin/phpcs not found — lint not run';

const isDirectPhpcs = (cmd: SlotCommand): boolean => cmd.argv.at(-1) === 'vendor/bin/phpcs';

const unscoped = (check: CheckResult, reason: string): CheckResult =>
  check.ran && !check.passed ? { ...check, note: `lint verdict unscoped: ${reason}` } : check;

function scopedCheck(command: string, { blocking, preExisting }: ScopedReport): CheckResult {
  const passed = blocking.length === 0;
  const output = !passed
    ? renderBlockingList(blocking, preExisting)
    : preExisting > 0
      ? `${preExistingFact(preExisting)} — not blocking.`
      : '';
  return {
    ran: true,
    passed,
    command,
    output,
    scope: { blocking: blocking.length, preExisting },
  };
}

type ScopedRun = { check: CheckResult } | { reason: string };

/** A reason instead of a check means the verdict could not be scoped. */
async function runScopedPhpcs(
  cmd: SlotCommand,
  ctx: StepContext,
  workspace: string,
  handle: DdevRunnerHandle | null,
  changed: ChangedLineMap,
): Promise<ScopedRun> {
  const { anchor, prefix } = workspaceAnchor(workspace);
  const dirRel = `${prefix}${REPORT_DIR}`;
  const name = `phpcs-${randomBytes(8).toString('hex')}.json`;
  const reportRel = `${dirRel}/${name}`;
  const ddev = cmd.kind === 'ddev';
  const root = ddev ? DDEV_PROJECT_MOUNT : path.resolve(workspace);
  let flags: string[];
  try {
    flags = phpcsReportFlags(`${root}/${REPORT_DIR}/${name}`, root);
    await ensureDirNoFollow(anchor, dirRel);
    // Only the DDEV user is a different uid from this worker, which writes the host report itself.
    if (ddev) await ensureSandboxWritableTree(anchor, dirRel);
  } catch (err) {
    ctx.logger.warn({ err }, 'phpcs report directory could not be prepared');
    return { reason: 'the report directory could not be prepared' };
  }
  try {
    const run = await execSlot(cmd, ctx, workspace, handle, flags);
    if (run.exitCode === 0) {
      return { check: { ran: true, passed: true, command: cmd.label, output: run.output } };
    }
    if (run.exitCode === NOT_FOUND_EXIT) {
      const check = {
        ran: false,
        passed: false,
        command: cmd.label,
        output: PHPCS_NOT_FOUND,
        note: PHPCS_NOT_FOUND,
      };
      return { check };
    }
    const text = await readTextNoFollow(anchor, reportRel, { maxBytes: MAX_REPORT_BYTES });
    const report = text === null ? null : parsePhpcsJsonReport(text);
    if (report === null) {
      return { reason: text === null ? 'phpcs wrote no report' : 'the report is malformed' };
    }
    return { check: scopedCheck(cmd.label, scopePhpcsReport(report, changed)) };
  } finally {
    await removeNoFollow(anchor, reportRel).catch((err: unknown) =>
      ctx.logger.warn({ err }, 'phpcs report could not be removed'),
    );
  }
}

async function runLint(
  cmd: SlotCommand,
  ctx: StepContext,
  workspace: string,
  handle: DdevRunnerHandle | null,
): Promise<CheckResult> {
  if (!isDirectPhpcs(cmd)) {
    return unscoped(await runSlot(cmd, ctx, workspace, handle), 'project script');
  }
  if (cmd.kind === 'ddev' && !handle) return runSlot(cmd, ctx, workspace, handle);
  const changed = await collectChangedLineMap(ctx, workspace);
  const scoped = changed
    ? await runScopedPhpcs(cmd, ctx, workspace, handle, changed)
    : { reason: 'the change could not be measured' };
  return 'check' in scoped
    ? scoped.check
    : unscoped(await runSlot(cmd, ctx, workspace, handle), scoped.reason);
}

const skippedResult = (): CheckResult => ({
  ran: false,
  passed: false,
  command: null,
  output: 'skipped',
});

// Body/exit signatures that mean the app did NOT come up cleanly. Conservative on
// purpose — PHP fatals and DB-down strings only — so a normal page never trips it.
// A legacy app often renders its DB-connection failure as HTTP 200 with the error
// in the BODY, so a status-only check is insufficient; these patterns plus the
// always-attached excerpt are what catch it.
const FATAL_PATTERNS =
  /Fatal error:|Parse error:|Uncaught\b|Call to undefined function|SQLSTATE|Connection (?:refused|was refused)|No such file or directory/i;

// Tail-safe status sentinel. `ddevExec` keeps only the LAST 8000 chars of output
// (tuned for `ddev start`, whose verdict lands at the END). For `curl -i` the
// `HTTP/… NNN` status line is at the HEAD, so a response body larger than the kept
// window pushed it out — the parser then saw no status and reported a false "no HTTP
// response". curl's `-w` writes this marker AFTER the body, so it always survives the
// tail-slice. Private contract: we emit it (probe) and we parse it (below); no spaces
// / quotes / backslashes in the format so it passes through `ddev exec`'s inner shell
// unmangled. `%{http_code}` is the FINAL response code (matches the last-status-line
// fallback semantics for the no-redirect case).
const SMOKE_STATUS_MARKER = 'HAIVE_HTTP_CODE=';

/** Parse a `curl -i` dump into a smoke verdict. Pure (no IO) so it is unit-testable.
 *  Prefers the tail-safe `-w` status marker the probe appends after the body (it
 *  survives ddevExec's tail-slice when a large body would otherwise push the head
 *  status line out of the kept window); falls back to the LAST `HTTP/… NNN` status
 *  line (so a redirect chain still reports the final code) for the app-runner path
 *  and legacy output without the marker. A null status with a command-missing
 *  message means the probe binary was absent (ran:false, not a failure); a null
 *  status otherwise means the app never answered (a failure). */
export function parseRuntimeSmokeOutput(raw: string): {
  ran: boolean;
  passed: boolean;
  httpStatus: number | null;
  errorExcerpt: string;
} {
  const text = raw ?? '';
  const marked = text.match(new RegExp(`${SMOKE_STATUS_MARKER}(\\d{3})`));
  const lineCodes = [...text.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)].map((m) => Number(m[1]));
  const httpStatus = marked
    ? Number(marked[1])
    : lineCodes.length > 0
      ? lineCodes[lineCodes.length - 1]!
      : null;
  // Drop the sentinel from the human-facing excerpt so it shows the page, not our marker.
  const cleaned = text.replace(new RegExp(`\\s*${SMOKE_STATUS_MARKER}\\d{3}\\s*$`), '');
  const errorExcerpt = cleaned.trim().slice(-1500);
  if (
    httpStatus === null &&
    /command not found|executable file not found|not installed|:\s*not found/i.test(text)
  ) {
    return { ran: false, passed: false, httpStatus: null, errorExcerpt };
  }
  const passed = httpStatus !== null && httpStatus < 500 && !FATAL_PATTERNS.test(cleaned);
  return { ran: true, passed, httpStatus, errorExcerpt };
}

function notProbed(url: string | null, reason: string): RuntimeSmoke {
  return { ran: false, passed: false, httpStatus: null, url, errorExcerpt: reason };
}

/** What a failed DDEV boot leaves this step as: its own error, which `fixLoopOnError` classifies by
 *  message. A Stop is no boot failure and stays the cancel the step runner knows by its class. */
function ddevBootError(err: unknown): Error {
  if (err instanceof TaskCancelledError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`DDEV environment could not start for runtime verification: ${message}`);
}

/** Boot the app once (idempotent via ensureAppServing) and curl it from INSIDE its
 *  container, where loopback/DNS resolve. A DDEV boot error is fatal: without a
 *  running DDEV environment, following checks would verify the wrong thing (or
 *  nothing at all), so the step must stop as retryable. Probe failures after a
 *  successful boot remain recorded in the smoke result for gate-2 review. */
export async function runRuntimeSmoke(
  ctx: StepContext,
  opts: { failOnDdevBootError?: boolean } = {},
): Promise<RuntimeSmoke> {
  let rt: ServingRuntime;
  try {
    rt = await ensureAppServing(ctx);
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    if (opts.failOnDdevBootError) throw ddevBootError(err);
    ctx.logger.warn({ err }, 'runtime smoke could not start the app — recording as not probed');
    return notProbed(null, `Runtime smoke could not run: ${(err as Error).message}`);
  }

  try {
    if (rt.mode === 'none') return notProbed(null, 'No servable runtime recorded for this task.');
    if (rt.mode === 'host') return notProbed(rt.url, 'Host runtime is not smoke-probed.');
    // `-w …%{http_code}` appends the tail-safe status marker AFTER the body (see
    // SMOKE_STATUS_MARKER). No spaces/quotes/backslashes in the format so it survives
    // `ddev exec`'s inner shell intact.
    const probeFlags = `-sS -i -m 20 -w ${SMOKE_STATUS_MARKER}%{http_code}`;
    const output =
      rt.mode === 'ddev'
        ? (
            await ddevExec(rt.handle, `exec curl ${probeFlags} http://127.0.0.1/`, {
              timeoutMs: 30_000,
            })
          ).output
        : (await appRunnerExec(rt.handle, `curl ${probeFlags} ${rt.url}`, { timeoutMs: 30_000 }))
            .output;
    const parsed = parseRuntimeSmokeOutput(output);
    ctx.logger.info(
      { mode: rt.mode, httpStatus: parsed.httpStatus, passed: parsed.passed, ran: parsed.ran },
      'runtime smoke complete',
    );
    return { ...parsed, url: rt.url };
  } catch (err) {
    ctx.logger.warn({ err }, 'runtime smoke could not run — recording as not probed');
    return notProbed(null, `Runtime smoke could not run: ${(err as Error).message}`);
  }
}

export const phase5VerifyStep: StepDefinition<VerifyDetect, VerifyApply> = {
  needsRuntime: 'if-serving',
  metadata: {
    id: '08-phase-5-verify',
    workflowType: 'workflow',
    index: 8,
    title: 'Phase 5: Verify',
    description:
      'Runs the project verification suite (tests, lint, typecheck) against the workspace and records the outcome for gate 2.',
    requiresCli: false,
    // Under auto-continue, run the detected checks on their defaults (each slot
    // ticked when a command is detected) instead of parking; a failure routes back
    // to implement via fixLoop. A 06-run-config pre-answer still wins when present;
    // manual mode still gates.
    autoSubmitDefaults: true,
  },

  // The same route for a THROWN failure, which the fixLoop below cannot see: this step
  // fails outright when the DDEV env will not boot (`failOnDdevBootError`), and the config
  // that stops it booting is the implementation's own work. Without this the task dies at
  // a step whose cause a retry cannot clear — the offending file is still there. Scoped by
  // the same predicate 07c uses, so a host-level failure (version constraint, reaped
  // runner, OOM) keeps the hard-fail path that exposes Retry / Retry with AI.
  fixLoopOnError: isDdevAgentFixableFailure,

  // Fix-loop: a failing verification suite routes back to implementation with the
  // failing command output(s) as the diagnosis.
  fixLoop: {
    evaluate: (out) => {
      if (out.passed) return null;
      const parts: string[] = [];
      for (const [name, check] of [
        ['tests', out.test],
        ['lint', out.lint],
        ['typecheck', out.typecheck],
      ] as const) {
        if (check.ran && !check.passed) {
          const shown = check.scope ? check.output : check.output.slice(-2000);
          parts.push(
            `### ${name} failed${check.command ? ` (\`${check.command}\`)` : ''}\n${shown}`,
          );
        }
      }
      return { blocking: true, diagnosis: parts.join('\n\n') || 'Verification failed.' };
    },
  },

  async detect(ctx: StepContext): Promise<VerifyDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    let workspace = worktreeOutput?.worktreePath ?? ctx.workspacePath;
    let ddevMode = false;
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await hasWorkspaceEntry(ws.workspace, '.ddev/config.yaml'))) {
      ddevMode = true;
      workspace = ws.workspace;
    }
    // 08b-test-management runs immediately before this step (index 7.9 against 8), so its
    // detect is the freshest identification of the framework in this workspace.
    const infra = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08b-test-management');
    const testFramework =
      ((infra?.detect ?? null) as { primary?: TestFramework | null } | null)?.primary ?? null;
    const slots = await resolveSlots(workspace, ddevMode);
    return { workspacePath: workspace, ddevMode, testFramework, ...slots };
  },

  form(_ctx, detected): FormSchema {
    const label = (c: SlotCommand | null) => (c ? c.label : 'none detected');
    return {
      title: 'Phase 5: Verify',
      description: [
        `Workspace: ${detected.workspacePath}`,
        detected.ddevMode ? 'PHP/Python checks run inside the DDEV runner.' : '',
        `test: ${label(detected.test)}`,
        `lint: ${label(detected.lint)}`,
        `typecheck: ${label(detected.typecheck)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        { type: 'checkbox', id: 'runTest', label: 'Run tests', default: detected.test !== null },
        { type: 'checkbox', id: 'runLint', label: 'Run lint', default: detected.lint !== null },
        {
          type: 'checkbox',
          id: 'runTypecheck',
          label: 'Run typecheck',
          default: detected.typecheck !== null,
        },
      ],
      submitLabel: 'Run verification',
    };
  },

  async apply(ctx, args): Promise<VerifyApply> {
    const values = args.formValues as {
      runTest?: boolean;
      runLint?: boolean;
      runTypecheck?: boolean;
    };
    const {
      workspacePath,
      ddevMode,
      testFramework,
      test: testCmd,
      lint: lintCmd,
      typecheck: typeCmd,
    } = args.detected;

    // A runner gone since 01c reads as a failing check and spends a fix round on "No such
    // container", so DDEV mode ensures it first, with the boot-failure routing the smoke has.
    let runtime: ServingRuntime | undefined;
    if (ddevMode) {
      try {
        runtime = await ensureAppServing(ctx);
      } catch (err) {
        throw ddevBootError(err);
      }
    }
    const ddevHandle = runtime?.mode === 'ddev' ? runtime.handle : null;

    // The DDEV web image ships no browser runtime, and a full suite is exactly where that
    // surfaces on a repo whose root `test` script drives one. 08b provisions before its own
    // selective run, but only when it HAS a run to make — a change touching no test file
    // leaves the container cold for this step. Idempotent, so the usual case costs seconds.
    if (
      values.runTest &&
      testCmd &&
      testCmd.kind === 'ddev' &&
      ddevHandle &&
      testFramework === 'playwright'
    ) {
      await ensureDdevPlaywrightBrowsers(ddevHandle, '');
      await killStalePlaywrightRuns(ddevHandle);
    }
    let test =
      values.runTest && testCmd
        ? await runSlot(testCmd, ctx, workspacePath, ddevHandle)
        : skippedResult();
    // An environment that cannot run a browser is not a failing test, and this step's fixLoop
    // routes ANY failing check back to implementation — so without this a missing browser
    // burns a whole round on something no agent can repair, which is the exact failure 08b's
    // own guard exists for. `ran: false` keeps it out of `passed` the same way a skipped slot
    // is kept out, and the note below says so rather than letting it read as green.
    const testEnvBlocker =
      test.ran && !test.passed ? classifyTestEnvFailure(testFramework ?? null, test.output) : null;
    if (testEnvBlocker) test = { ...test, ran: false };
    const lint =
      values.runLint && lintCmd
        ? await runLint(lintCmd, ctx, workspacePath, ddevHandle)
        : skippedResult();
    const typecheck =
      values.runTypecheck && typeCmd
        ? await runSlot(typeCmd, ctx, workspacePath, ddevHandle)
        : skippedResult();

    const passed =
      (!test.ran || test.passed) &&
      (!lint.ran || lint.passed) &&
      (!typecheck.ran || typecheck.passed);

    // Always smoke the running app, regardless of the test/lint checkboxes — this
    // is the only step that catches a runtime failure (e.g. a DB-connection error
    // page) before gate-2. Kept out of `passed` so it never routes to implement.
    const runtimeSmoke = await runRuntimeSmoke(ctx, {
      // A DDEV boot failure is an environment failure, not a failed test result. Do
      // not let it be recorded as a benign "not probed" smoke result and allow the
      // workflow to continue; fail this retryable step instead.
      failOnDdevBootError: ddevMode,
    });

    ctx.logger.info(
      {
        test: test.ran ? (test.passed ? 'pass' : 'fail') : 'skip',
        lint: lint.ran ? (lint.passed ? 'pass' : 'fail') : 'skip',
        typecheck: typecheck.ran ? (typecheck.passed ? 'pass' : 'fail') : 'skip',
        smoke: runtimeSmoke.ran ? (runtimeSmoke.passed ? 'pass' : 'fail') : 'skip',
      },
      'verify phase complete',
    );

    // This step has no agent — the facts it establishes are the COMMANDS that exist in
    // this workspace and whether they pass. Every later agent otherwise re-derives the
    // same thing by probing for a test runner that may not be there.
    const verdict = (r: CheckResult): string => {
      if (!r.scope) return r.passed ? 'passes' : 'FAILS';
      if (!r.passed) return 'FAILS on lines this change wrote';
      return r.scope.preExisting > 0
        ? `passes on changed lines (${r.scope.preExisting} pre-existing)`
        : 'passes';
    };
    const slotFact = (name: string, r: CheckResult): string =>
      r.ran
        ? `${name}: \`${r.command}\` ${verdict(r)}`
        : r.note
          ? `${name}: ${r.note}`
          : r.command
            ? `${name}: \`${r.command}\` exists but was not run this pass`
            : `${name}: no runner detected in this workspace`;
    await recordLedgerEntry(ctx.db, ctx.taskId, ctx.taskStepId, {
      stepId: '08-phase-5-verify',
      round: ctx.round,
      text: [
        slotFact('test', test),
        slotFact('lint', lint),
        slotFact('typecheck', typecheck),
        runtimeSmoke.ran
          ? `runtime smoke: ${runtimeSmoke.url} answered ${runtimeSmoke.httpStatus ?? 'nothing'}`
          : 'runtime smoke: no servable runtime',
      ].join('; '),
    });
    const unverified = buildUnverifiedNote(
      { test: testCmd, lint: lintCmd, typecheck: typeCmd },
      { test, lint, typecheck },
    );
    const degradedNote = buildVerifyDegradedNote(testEnvBlocker, unverified, lint.note);
    return {
      test,
      lint,
      typecheck,
      passed,
      runtimeSmoke,
      ...(degradedNote ? { degradedNote } : {}),
    };
  },
};
