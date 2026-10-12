import { randomBytes } from 'node:crypto';
import {
  ensureDirNoFollow,
  readdirNoFollow,
  readTextNoFollow,
  removeNoFollow,
} from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { ensureSandboxWritableTree } from '../../../repo/worktree-permissions.js';
import type { FormSchema, VerifyCommands } from '@haive/shared';
import {
  AdvisedStepError,
  TaskCancelledError,
  type StepContext,
  type StepDefinition,
} from '../../step-definition.js';
import { recordLedgerEntry } from '../../task-ledger.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { hasWorkspaceEntry } from '../../workspace-probe.js';
import { loadDeclaredVerifyCommands, resolveDdevWorkspace } from './_task-meta.js';
import {
  DDEV_PROJECT_MOUNT,
  ddevExec,
  ddevRunnerLife,
  type DdevRunnerHandle,
  type RunnerLife,
} from '../../../sandbox/ddev-runner.js';
import { appRunnerExec } from '../../../sandbox/app-runner.js';
import { shellQuote } from '../../../sandbox/shell-quote.js';
import { SANDBOX_WORKDIR } from '../../../sandbox/sandbox-runner.js';
import { runStepCommandInSandbox } from '../../../sandbox/step-command.js';
import { ensureAppServing, withDdevProgress, type ServingRuntime } from './_app-runtime.js';
import {
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
} from '../../../sandbox/ddev-playwright.js';
import { checkOutputExcerpt } from './_fix-loop.js';
import { classifyTestEnvFailure } from './_test-env-guard.js';
import { runtimeSmokeVerdict } from './_runtime-smoke-verdict.js';
import { DRUPAL_CORE_MARKER, type TestFramework } from './08b-test-management.js';
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
// (where the toolchain lives), else in the task's sandbox. The 3-checkbox form is unchanged.

type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'none';

/** A resolved command for one verify slot. `host` runs in the task's sandbox, in the
 *  workspace; `ddev` runs via ddevExec inside the runner (argv is the ddev
 *  subcommand, without the leading `ddev`). null = nothing detected for the slot. */
export interface SlotCommand {
  kind: 'host' | 'ddev';
  label: string;
  argv: string[];
  /** Set when the repository declared this command; `label` is then the declared text. */
  source?: 'declared';
}

export type VerifySlotName = 'test' | 'lint' | 'typecheck';

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
  /** The PHP lint runner beside a root JS lint script; absent when `lint` is the only runner. */
  phpLint?: SlotCommand | null;
  typecheck: SlotCommand | null;
  /** Tooling configs one level below the root that were seen and not used, each with its reason.
   *  Optional because detect_output is persisted and replayed; absent when nothing was declined. */
  declinedConfigs?: string[];
  /** Slots the repository turned off: no runner, whatever the workspace holds. Optional because
   *  detect_output is persisted and replayed; absent when no slot is off. */
  offSlots?: VerifySlotName[];
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
  /** null = a 4xx response without a runtime-error signature; human review needed. */
  passed: boolean | null;
  httpStatus: number | null;
  url: string | null;
  errorExcerpt: string;
}

interface VerifyApply {
  test: CheckResult;
  lint: CheckResult;
  phpLint?: CheckResult;
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
  slotNotes = '',
): string {
  return [
    blocker
      ? `The test suite could not be run: ${blocker.reason}. The suite is NOT known to be ` +
        `green, and no fix round can repair this. Repair with: ${blocker.repair}`
      : '',
    unverified,
    slotNotes,
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
  slots: {
    test: SlotCommand | null;
    lint: SlotCommand | null;
    typecheck: SlotCommand | null;
    phpLint?: SlotCommand | null;
  },
  results: {
    test: CheckResult;
    lint: CheckResult;
    typecheck: CheckResult;
    phpLint?: CheckResult;
  },
  declinedConfigs?: string[],
  offSlots?: VerifySlotName[],
): string {
  if (results.test.ran || results.lint.ran || results.typecheck.ran || results.phpLint?.ran) {
    return '';
  }
  const undetected: string[] = [];
  const unticked: string[] = [];
  const turnedOff: string[] = [];
  for (const name of ['test', 'lint', 'phpLint', 'typecheck'] as const) {
    const result = results[name];
    if (!result || result.note) continue;
    if (name !== 'phpLint' && offSlots?.includes(name)) {
      turnedOff.push(name);
      continue;
    }
    (slots[name] === null ? undetected : unticked).push(name === 'phpLint' ? 'php lint' : name);
  }
  const parts = [
    `No verification check ran this pass, so this step passing means nothing was checked — not that everything passed.`,
  ];
  if (undetected.length > 0) {
    parts.push(
      `No runner was detected in this workspace for: ${undetected.join(', ')}. Only the workspace ROOT is searched for a package.json / composer.json script or a phpunit / pytest / phpcs / phpstan config, so a project whose tooling lives in a subdirectory reports none. ${TOOLING_PAGE_HINT}`,
    );
    const declined = declinedConfigsSentence(declinedConfigs);
    if (declined) parts.push(declined);
  }
  if (turnedOff.length > 0) {
    parts.push(`Turned off for this repository: ${turnedOff.join(', ')}.`);
  }
  if (unticked.length > 0) {
    parts.push(`Detected but not selected for this pass: ${unticked.join(', ')}.`);
  }
  return parts.join('\n\n');
}

/** Appended to every root-only sentence: declaring commands is how a repo past root-only detection runs. */
export const TOOLING_PAGE_HINT = "Declare commands on the repository's Tooling page.";

/** What gate 2 and the unverified note say about the configs one level down that were not used. */
export function declinedConfigsSentence(declined: string[] | undefined): string {
  if (!declined || declined.length === 0) return '';
  return `Searched: the repository root. Found one level below it and not used: ${declined.join(', ')}. Verify runs only the project's own root tooling.`;
}

/** Exit of the guard below; DDEV ships npm but pnpm and yarn only with `corepack_enable: true`. */
const PM_MISSING_EXIT = 199;

/** `ddev exec` re-parses its words in the container, so `$` is escaped once more than quotes. */
const DDEV_PM_GUARD = shellQuote(
  `command -v "\\$1" >/dev/null 2>&1 || exit ${PM_MISSING_EXIT}; exec "\\$@"`,
);

/** The guard run in its place: it prints `marker` before its exit, so a script's own 199 never reads as a missing tool. */
function markedPmGuard(marker: string): string {
  return shellQuote(
    `command -v "\\$1" >/dev/null 2>&1 || { echo ${marker}; exit ${PM_MISSING_EXIT}; }; exec "\\$@"`,
  );
}

/** A package-script slot a detect from before DDEV routing persisted as `host` is re-resolved, so
 *  a replayed row never runs the script on the worker. */
export function ddevSlot(cmd: SlotCommand | null, ddevMode: boolean): SlotCommand | null {
  if (!cmd || !ddevMode || cmd.kind !== 'host') return cmd;
  const [pm, verb, script] = cmd.argv;
  if ((pm === 'pnpm' || pm === 'npm' || pm === 'yarn') && verb === 'run' && script) {
    return buildVerifyCommand({ runner: 'pm', pm, script }, true);
  }
  return cmd;
}

/**
 * Build the command for a verify slot from the detected runner. Pure (no IO) so
 * it is unit-testable. Every runner goes through DDEV when `ddevMode`, else
 * runs the binary host-side.
 */
export function buildVerifyCommand(
  spec: { runner: SlotRunner; pm?: PackageManager; script?: string },
  ddevMode: boolean,
): SlotCommand | null {
  switch (spec.runner) {
    case 'pm': {
      if (!spec.pm || spec.pm === 'none' || !spec.script) return null;
      if (ddevMode)
        return {
          kind: 'ddev',
          label: `ddev exec ${spec.pm} run ${spec.script}`,
          argv:
            spec.pm === 'npm'
              ? ['exec', spec.pm, 'run', spec.script]
              : ['exec', 'sh', '-c', DDEV_PM_GUARD, 'sh', spec.pm, 'run', spec.script],
        };
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

/** One shell string. DDEV runs it raw, so the runner's shell sees exactly one quoted word. */
export function buildDeclaredCommand(command: string, ddevMode: boolean): SlotCommand {
  if (ddevMode) {
    return {
      kind: 'ddev',
      label: command,
      argv: ['exec', '--raw', '--', 'bash', '-c', shellQuote(command)],
      source: 'declared',
    };
  }
  return { kind: 'host', label: command, argv: ['sh', '-c', command], source: 'declared' };
}

interface ResolvedSlots {
  test: SlotCommand | null;
  lint: SlotCommand | null;
  phpLint?: SlotCommand | null;
  typecheck: SlotCommand | null;
}

/** Overlay the repository's declared commands on the detected slots: a command replaces the slot,
 *  null empties it, an absent key leaves detection alone. A declared or off lint drops phpLint too. */
export function applyDeclaredCommands(
  slots: ResolvedSlots,
  declared: VerifyCommands | null,
  ddevMode: boolean,
): { slots: ResolvedSlots; offSlots: VerifySlotName[] } {
  if (!declared) return { slots, offSlots: [] };
  const out = { ...slots };
  const offSlots: VerifySlotName[] = [];
  for (const name of ['test', 'lint', 'typecheck'] as const) {
    const value = declared[name];
    if (value === undefined) continue;
    if (value === null) {
      out[name] = null;
      offSlots.push(name);
    } else {
      out[name] = buildDeclaredCommand(value, ddevMode);
    }
    if (name === 'lint') delete out.phpLint;
  }
  return { slots: out, offSlots };
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

const PHPUNIT_CONFIGS = ['phpunit.xml', 'phpunit.xml.dist'];
const PYTEST_CONFIGS = ['pytest.ini', 'pyproject.toml', 'tox.ini'];
const PHPCS_CONFIGS = ['phpcs.xml', 'phpcs.xml.dist', '.phpcs.xml'];
const PHPSTAN_CONFIGS = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'];

/** Resolve the three verify-slot commands across JS / composer / PHP / Python.
 *  Precedence per slot: JS package script → composer script → framework binary. */
async function resolveSlots(
  workspace: string,
  ddevMode: boolean,
): Promise<{
  test: SlotCommand | null;
  lint: SlotCommand | null;
  phpLint?: SlotCommand | null;
  typecheck: SlotCommand | null;
}> {
  const pmScripts = await readJsonScripts(workspace, 'package.json');
  const composerScripts = await readJsonScripts(workspace, 'composer.json');
  const pm = await detectPackageManager(workspace);
  const has = async (...names: string[]) => {
    for (const n of names) if (await hasWorkspaceEntry(workspace, n)) return true;
    return false;
  };
  const hasPhpunit = await has(...PHPUNIT_CONFIGS);
  const hasPytest = await has(...PYTEST_CONFIGS);
  const hasPhpcs = await has(...PHPCS_CONFIGS);
  const hasPhpstan = await has(...PHPSTAN_CONFIGS);

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

  const phpLint = lintJs
    ? lintComposer
      ? buildVerifyCommand({ runner: 'composer', script: lintComposer }, ddevMode)
      : hasPhpcs
        ? buildVerifyCommand({ runner: 'phpcs' }, ddevMode)
        : null
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

  return { test, lint, ...(phpLint ? { phpLint } : {}), typecheck };
}

const DECLINED_CONFIG_FILES = [
  ...PHPUNIT_CONFIGS,
  ...PYTEST_CONFIGS,
  ...PHPCS_CONFIGS,
  ...PHPSTAN_CONFIGS,
  'jest.config.js',
  'jest.config.ts',
  'jest.config.mjs',
  'jest.config.cjs',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
];

const THIRD_PARTY_DIRS = new Set([
  'contrib',
  'libraries',
  'third_party',
  'third-party',
  'thirdparty',
]);

function declinedReason(dir: string, drupalCore: boolean): string {
  if (dir === 'core' && drupalCore) return 'Drupal core';
  if (dir === 'vendor' || dir === 'node_modules') return 'vendor';
  if (THIRD_PARTY_DIRS.has(dir)) return "not the project's";
  return 'below the repository root';
}

/** Tooling configs exactly one level below the root: seen, never used. Sorted; empty when none. */
async function findDeclinedConfigs(workspace: string): Promise<string[]> {
  const { anchor, prefix } = workspaceAnchor(workspace);
  const entries = (await readdirNoFollow(anchor, prefix === '' ? '' : prefix.slice(0, -1))) ?? [];
  const found: string[] = [];
  const drupalCore = await hasWorkspaceEntry(workspace, DRUPAL_CORE_MARKER);
  for (const dir of entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))) {
    const hits: string[] = [];
    for (const name of ['package.json', 'composer.json']) {
      const scripts = await readJsonScripts(workspace, `${dir.name}/${name}`);
      if (Object.keys(scripts).length > 0) hits.push(name);
    }
    for (const name of DECLINED_CONFIG_FILES) {
      if (await hasWorkspaceEntry(workspace, `${dir.name}/${name}`)) hits.push(name);
    }
    for (const name of hits)
      found.push(`${dir.name}/${name} (${declinedReason(dir.name, drupalCore)})`);
  }
  return found.sort();
}

interface SlotRun {
  ran: boolean;
  exitCode: number;
  output: string;
  /** Why a command did not run. */
  note?: string;
  /** The whole output, for a classifier; never stored. */
  raw: string;
}

/** A shell reports a missing command as 127. */
const NOT_FOUND_EXIT = 127;

/** A shell reports a command it found but could not execute as 126. */
const NOT_EXECUTABLE_EXIT = 126;

const SLOT_TIMEOUT_MS = 600_000;

/** Whether the runner went away or started again during a run; unknown either side says no. */
function runnerLost(before: RunnerLife, after: RunnerLife): boolean {
  if (after === null) return false;
  if (after.state !== 'up') return true;
  return before !== null && before.state === 'up' && before.startedAt !== after.startedAt;
}

async function execSlot(
  cmd: SlotCommand,
  ctx: StepContext,
  handle: DdevRunnerHandle | null,
  extraArgs: string[] = [],
): Promise<SlotRun> {
  if (cmd.kind === 'ddev') {
    if (!handle)
      return {
        ran: false,
        exitCode: 1,
        output: 'DDEV runner unavailable — skipped',
        raw: 'DDEV runner unavailable — skipped',
      };
    // A full suite is minutes of silence, and a fixed status line is indistinguishable from a
    // stuck task. Same live status every long DDEV op already uses: latest line + an elapsed
    // counter that ticks through silent phases.
    const guardAt = cmd.argv.indexOf(DDEV_PM_GUARD);
    const marker = `pm-missing-${randomBytes(8).toString('hex')}`;
    const argv = cmd.argv.map((word, i) => (i === guardAt ? markedPmGuard(marker) : word));
    const before = await ddevRunnerLife(handle);
    const res = await withDdevProgress(
      ctx,
      `Running ${cmd.label}`,
      (onLine) =>
        ddevExec(handle, [...argv, ...extraArgs].join(' '), {
          timeoutMs: SLOT_TIMEOUT_MS,
          onLine,
        }),
      { initialLine: cmd.argv.join(' ') },
    );
    // A runner lost mid-run (Docker restart, OOM, an external rm) is no failure an agent can fix.
    if (res.exitCode !== 0 && runnerLost(before, await ddevRunnerLife(handle))) {
      const note = `the DDEV runner stopped during ${cmd.label} — not run`;
      return { ran: false, note, exitCode: res.exitCode, output: note, raw: res.output };
    }
    if (guardAt >= 0 && res.exitCode === PM_MISSING_EXIT && res.output.includes(marker)) {
      const note = `${cmd.argv[guardAt + 2]} is not available in the DDEV web container (set corepack_enable: true in .ddev/config.yaml)`;
      return { ran: false, note, exitCode: res.exitCode, output: note, raw: res.output };
    }
    return {
      ran: true,
      exitCode: res.exitCode,
      output: checkOutputExcerpt(res.output),
      raw: res.output,
    };
  }
  const res = await withDdevProgress(
    ctx,
    `Running ${cmd.label}`,
    (onLine) =>
      runStepCommandInSandbox(ctx, {
        argv: [...cmd.argv, ...extraArgs],
        timeoutMs: SLOT_TIMEOUT_MS,
        onWait: (busy, cap) => onLine(`waiting for an agent slot (${busy} of ${cap} busy)`),
      }),
    { initialLine: cmd.argv.join(' ') },
  );
  if (!res.ran) return { ran: false, exitCode: 1, output: res.note, raw: res.note, note: res.note };
  return {
    ran: true,
    exitCode: res.exitCode,
    output: checkOutputExcerpt(res.output),
    raw: res.output,
  };
}

/** A declared command the shell could not start is a repository setting to correct, not a defect a fix round can repair. */
function declaredNotRunnable(cmd: SlotCommand, slot: string, run: SlotRun): SlotRun {
  if (cmd.source !== 'declared' || !run.ran) return run;
  if (run.exitCode !== NOT_FOUND_EXIT && run.exitCode !== NOT_EXECUTABLE_EXIT) return run;
  const note = `the declared ${slot} command was not run — command not found / not executable (exit ${run.exitCode})`;
  return { ran: false, note, exitCode: run.exitCode, output: note, raw: run.raw };
}

async function runSlotRaw(
  slot: 'test' | 'lint' | 'typecheck',
  cmd: SlotCommand,
  ctx: StepContext,
  handle: DdevRunnerHandle | null,
): Promise<{ check: CheckResult; raw: string }> {
  const run = declaredNotRunnable(cmd, slot, await execSlot(cmd, ctx, handle));
  const check = {
    ran: run.ran,
    passed: run.ran && run.exitCode === 0,
    command: cmd.label,
    output: run.output,
    ...(run.ran ? {} : { note: run.note ?? `DDEV runner unavailable — ${slot} not run` }),
  };
  return { check, raw: run.raw };
}

async function runSlot(
  slot: 'test' | 'lint' | 'typecheck',
  cmd: SlotCommand,
  ctx: StepContext,
  handle: DdevRunnerHandle | null,
): Promise<CheckResult> {
  return (await runSlotRaw(slot, cmd, ctx, handle)).check;
}

const REPORT_DIR = '.haive/verify';
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const PHPCS_NOT_FOUND = 'vendor/bin/phpcs not found — lint not run';
const PHPCS_TIMED_OUT = 'phpcs reached its time limit — lint not verified';
/** A kill timer can fire a little before the clock this step reads agrees. */
const TIME_LIMIT_SLACK_MS = 5_000;

const isDirectPhpcs = (cmd: SlotCommand): boolean =>
  cmd.source !== 'declared' && cmd.argv.at(-1) === 'vendor/bin/phpcs';

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
  const root = ddev ? DDEV_PROJECT_MOUNT : SANDBOX_WORKDIR;
  let flags: string[];
  try {
    flags = phpcsReportFlags(`${root}/${REPORT_DIR}/${name}`, root);
    await ensureDirNoFollow(anchor, dirRel);
    await ensureSandboxWritableTree(anchor, dirRel);
  } catch (err) {
    ctx.logger.warn({ err }, 'phpcs report directory could not be prepared');
    return { reason: 'the report directory could not be prepared' };
  }
  try {
    const startedAt = performance.now();
    const run = await execSlot(cmd, ctx, handle, flags);
    const elapsedMs = performance.now() - startedAt;
    if (!run.ran || run.exitCode === NOT_FOUND_EXIT) {
      const why = run.note ?? PHPCS_NOT_FOUND;
      return {
        check: { ran: false, passed: false, command: cmd.label, output: why, note: why },
      };
    }
    // ignore_errors_on_exit and ignore_warnings_on_exit hide violations from the exit code.
    const text = await readTextNoFollow(anchor, reportRel, { maxBytes: MAX_REPORT_BYTES });
    const report = text === null ? null : parsePhpcsJsonReport(text);
    if (report === null) {
      if (run.exitCode === 0) {
        return { check: { ran: true, passed: true, command: cmd.label, output: run.output } };
      }
      // Only the clock tells a kill from another exit 1. A re-run would spend the limit again, and a
      // fix round cannot repair a timeout, so it is reported as not run rather than as a failure.
      if (elapsedMs >= SLOT_TIMEOUT_MS - TIME_LIMIT_SLACK_MS) {
        const output = run.output;
        return {
          check: { ran: false, passed: false, command: cmd.label, output, note: PHPCS_TIMED_OUT },
        };
      }
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
    return unscoped(
      await runSlot('lint', cmd, ctx, handle),
      cmd.source === 'declared' ? 'declared command' : 'project script',
    );
  }
  if (cmd.kind === 'ddev' && !handle) return runSlot('lint', cmd, ctx, handle);
  const changed = await collectChangedLineMap(ctx, workspace);
  const scoped = changed
    ? await runScopedPhpcs(cmd, ctx, workspace, handle, changed)
    : { reason: 'the change could not be measured' };
  return 'check' in scoped
    ? scoped.check
    : unscoped(await runSlot('lint', cmd, ctx, handle), scoped.reason);
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
  passed: boolean | null;
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
  const passed =
    httpStatus === null || httpStatus >= 500 || FATAL_PATTERNS.test(cleaned)
      ? false
      : httpStatus >= 400
        ? null
        : true;
  return { ran: true, passed, httpStatus, errorExcerpt };
}

function notProbed(url: string | null, reason: string): RuntimeSmoke {
  return { ran: false, passed: false, httpStatus: null, url, errorExcerpt: reason };
}

/** What a failed DDEV boot leaves this step as: its own error, which `fixLoopOnError` classifies by
 *  message. A Stop is no boot failure and stays the cancel the step runner knows by its class. */
function ddevBootError(err: unknown): Error {
  if (err instanceof TaskCancelledError) return err;
  const lead = 'DDEV environment could not start for runtime verification: ';
  if (err instanceof AdvisedStepError) {
    return new AdvisedStepError(`${lead}${err.message}`, `${lead}${err.diagnosis}`, err.advice);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`${lead}${message}`);
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
        ['php lint', out.phpLint],
        ['typecheck', out.typecheck],
      ] as const) {
        if (check?.ran && !check.passed) {
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
    const declared = await loadDeclaredVerifyCommands(ctx.db, ctx.taskId, ctx.logger);
    const { slots, offSlots } = applyDeclaredCommands(
      await resolveSlots(workspace, ddevMode),
      declared,
      ddevMode,
    );
    const declinedConfigs = await findDeclinedConfigs(workspace);
    return {
      workspacePath: workspace,
      ddevMode,
      testFramework,
      ...slots,
      ...(declinedConfigs.length > 0 ? { declinedConfigs } : {}),
      ...(offSlots.length > 0 ? { offSlots } : {}),
    };
  },

  form(_ctx, detected): FormSchema {
    const off = detected.offSlots ?? [];
    const label = (c: SlotCommand | null, slot?: VerifySlotName) =>
      c
        ? c.source === 'declared'
          ? `${c.label} (declared)`
          : c.label
        : slot && off.includes(slot)
          ? 'turned off for this repository'
          : 'none detected';
    return {
      title: 'Phase 5: Verify',
      description: [
        `Workspace: ${detected.workspacePath}`,
        detected.ddevMode ? 'PHP/Python checks run inside the DDEV runner.' : '',
        `test: ${label(detected.test, 'test')}`,
        `lint: ${label(detected.lint, 'lint')}`,
        detected.phpLint ? `php lint: ${label(detected.phpLint)}` : '',
        `typecheck: ${label(detected.typecheck, 'typecheck')}`,
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
    const { workspacePath, ddevMode, testFramework } = args.detected;
    const testCmd = ddevSlot(args.detected.test, ddevMode);
    const lintCmd = ddevSlot(args.detected.lint, ddevMode);
    const phpLintCmd = ddevSlot(args.detected.phpLint ?? null, ddevMode);
    const typeCmd = ddevSlot(args.detected.typecheck, ddevMode);

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
    const testRun =
      values.runTest && testCmd
        ? await runSlotRaw('test', testCmd, ctx, ddevHandle)
        : { check: skippedResult(), raw: '' };
    let test = testRun.check;
    // An environment that cannot run a browser is not a failing test, and this step's fixLoop
    // routes ANY failing check back to implementation — so without this a missing browser
    // burns a whole round on something no agent can repair, which is the exact failure 08b's
    // own guard exists for. `ran: false` keeps it out of `passed` the same way a skipped slot
    // is kept out, and the note below says so rather than letting it read as green.
    // A declared command may drive Playwright wherever 08b looked; its own error IDs decide then.
    const envFramework = testCmd?.source === 'declared' ? 'playwright' : (testFramework ?? null);
    const testEnvBlocker =
      test.ran && !test.passed ? classifyTestEnvFailure(envFramework, testRun.raw) : null;
    if (testEnvBlocker) {
      test = {
        ...test,
        ran: false,
        note: 'test run stopped by its environment, not a test failure',
      };
    }
    const lint =
      values.runLint && lintCmd
        ? await runLint(lintCmd, ctx, workspacePath, ddevHandle)
        : skippedResult();
    const phpLint = phpLintCmd
      ? values.runLint
        ? await runLint(phpLintCmd, ctx, workspacePath, ddevHandle)
        : skippedResult()
      : undefined;
    const typecheck =
      values.runTypecheck && typeCmd
        ? await runSlot('typecheck', typeCmd, ctx, ddevHandle)
        : skippedResult();

    const passed =
      (!test.ran || test.passed) &&
      (!lint.ran || lint.passed) &&
      (!phpLint?.ran || phpLint.passed) &&
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
        ...(phpLint ? { phpLint: phpLint.ran ? (phpLint.passed ? 'pass' : 'fail') : 'skip' } : {}),
        typecheck: typecheck.ran ? (typecheck.passed ? 'pass' : 'fail') : 'skip',
        smoke: runtimeSmokeVerdict(runtimeSmoke),
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
    const off = args.detected.offSlots ?? [];
    const slotFact = (name: string, r: CheckResult, slot?: VerifySlotName): string =>
      slot && off.includes(slot) && !r.ran
        ? `${name}: turned off for this repository`
        : r.ran
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
        slotFact('test', test, 'test'),
        slotFact('lint', lint, 'lint'),
        ...(phpLint ? [slotFact('php lint', phpLint)] : []),
        slotFact('typecheck', typecheck, 'typecheck'),
        runtimeSmoke.ran
          ? `runtime smoke: ${runtimeSmoke.url} answered ${runtimeSmoke.httpStatus ?? 'nothing'}`
          : 'runtime smoke: no servable runtime',
      ].join('; '),
    });
    const unverified = buildUnverifiedNote(
      {
        test: testCmd,
        lint: lintCmd,
        typecheck: typeCmd,
        ...(phpLintCmd ? { phpLint: phpLintCmd } : {}),
      },
      { test, lint, typecheck, ...(phpLint ? { phpLint } : {}) },
      args.detected.declinedConfigs,
      args.detected.offSlots,
    );
    const anyRan = test.ran || lint.ran || typecheck.ran || phpLint?.ran === true;
    const slotUndetected =
      (args.detected.test === null && !off.includes('test')) ||
      (args.detected.lint === null && !off.includes('lint')) ||
      (args.detected.typecheck === null && !off.includes('typecheck'));
    const slotNotes = [
      test.note,
      lint.note,
      phpLint?.note,
      typecheck.note,
      anyRan && slotUndetected ? declinedConfigsSentence(args.detected.declinedConfigs) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const degradedNote = buildVerifyDegradedNote(testEnvBlocker, unverified, slotNotes);
    return {
      test,
      lint,
      ...(phpLint ? { phpLint } : {}),
      typecheck,
      passed,
      runtimeSmoke,
      ...(degradedNote ? { degradedNote } : {}),
    };
  },
};
