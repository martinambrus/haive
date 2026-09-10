import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CONFIG_KEYS, configService, type FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { agentDefinitionGuidance, retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { hasAnyKey, parseAgentJson } from './_agent-json.js';
import {
  changedFilesBlock,
  collectImplementationFiles,
  type ImplementationFileSet,
} from './_impl-changes.js';
import { loadPlanImpactContext, planImpactBlock } from './_plan-impact.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { ensureAppServing, withDdevProgress } from './_app-runtime.js';
import {
  runnerHandleForTask,
  ddevExec,
  ddevRunnerRunning,
  DDEV_PROJECT_MOUNT,
} from '../../../sandbox/ddev-runner.js';
import {
  ensureDdevPlaywrightBrowsers,
  killStalePlaywrightRuns,
} from '../../../sandbox/ddev-playwright.js';
import { isDdevAgentFixableFailure } from '../../../sandbox/ddev-build-guard.js';
import { classifyTestEnvFailure } from './_test-env-guard.js';
import {
  findExistingSpecFiles,
  findMissingEnvFiles,
  preflightGateSchema,
  type TestPreflightBlock,
} from './_test-preflight.js';
import { cleanText, contentFingerprint } from '../../task-ledger.js';

// Phase 5b — Test management (legacy phase5b-test-management.md). Runs straight
// after the implementation chain and BEFORE 08-phase-5-verify, so the suite verify
// runs has already been reconciled with the change: deterministically detect the
// test infrastructure (no LLM), let the user pick the action (the legacy mandatory
// questions, folded into the one-shot form), run ONE tester agent to
// create/update/delete tests following the project's conventions, then optionally
// run ONLY the related tests (never the full suite) — in the per-task DDEV runner
// when the repo uses DDEV — looping a fix agent on failures (legacy cap: 5
// attempts, then fixLoop back to implementation). No detectable infrastructure →
// the step is skipped.

const exec = promisify(execFile);

export type TestFramework =
  | 'playwright'
  | 'cypress'
  | 'vitest'
  | 'jest'
  | 'phpunit'
  | 'pytest'
  | 'pkg-script'
  | 'composer-script';

interface TestManagementDetect {
  workspacePath: string;
  sandboxWorktreePath: string;
  frameworks: TestFramework[];
  primary: TestFramework | null;
  /** Where each detected framework's PROJECT ROOT is, repo-relative — `''` for the workspace
   *  root, `null` when no config file for it was found anywhere. Optional because
   *  `task_steps.detect_output` is persisted and replayed: a payload written before this
   *  field existed must still build the command it built then, which is the `''` case. */
  frameworkRoots?: Record<string, string | null>;
  testDirs: string[];
  ddev: boolean;
  ddevPlaywrightAddon: boolean;
  repoSubpath: string | null;
  spec: string;
  implementationFiles: ImplementationFileSet;
  /** What the project plan says stands on the components this change touches, and
   *  the tests recorded against them, pre-rendered. Empty on a repo with no plan,
   *  a spec that named no component, or a disabled canvas — the prompt is then
   *  what it always was. */
  planImpact: string;
  /** Set only when the pre-flight probe RAN and the runner could load none of the repo's
   *  existing tests. Optional and absent by default: `task_steps.detect_output` is persisted
   *  and replayed, so a payload written before this existed must still render the ordinary
   *  form — which is exactly what an absent field produces. */
  preflight?: TestPreflightBlock | null;
}

interface TestRunResult {
  ran: boolean;
  passed: boolean;
  command: string;
  output: string;
}

interface TestManagementApply {
  action: string;
  testsCreated: string[];
  testsUpdated: string[];
  testsDeleted: string[];
  notes: string;
  testRun: TestRunResult | null;
  /** null = no selective run happened; false escalates at gate-2. */
  testsPassed: boolean | null;
  fixPasses: number;
  /** Amber caveat for the step card, read by the runner's computeDegradedNote. Set only when
   *  the tests were written but could NOT be run — never on an ordinary pass or failure. */
  degradedNote?: string;
}

const testerOutputSchema = z.object({
  tests_created: z.array(z.string()).default([]),
  tests_updated: z.array(z.string()).default([]),
  tests_deleted: z.array(z.string()).default([]),
  notes: z.string().default(''),
});

/** The tester's own report names the test files it touched. Every schema field defaults,
 *  so without this gate any JSON it printed validates as "no tests written". */
const TESTER_KEYS = ['tests_created', 'tests_updated', 'tests_deleted'] as const;

/** Parse the tester agent's JSON; falls back to "no changes" on a parse miss. */
export function parseTesterOutput(raw: unknown): {
  testsCreated: string[];
  testsUpdated: string[];
  testsDeleted: string[];
  notes: string;
} {
  return (
    parseAgentJson(raw, (candidate) => {
      if (!hasAnyKey(candidate, TESTER_KEYS)) return null;
      const parsed = testerOutputSchema.safeParse(candidate);
      if (!parsed.success) return null;
      return {
        testsCreated: parsed.data.tests_created,
        testsUpdated: parsed.data.tests_updated,
        testsDeleted: parsed.data.tests_deleted,
        notes: parsed.data.notes,
      };
    }) ?? { testsCreated: [], testsUpdated: [], testsDeleted: [], notes: '' }
  );
}

const TEST_FILE_RE =
  /(\.(spec|test)\.[cm]?[jt]sx?|Test\.php|\.test\.php|(^|\/)test_[^/]+\.py|_test\.py)$/;

/** Created/updated paths that look like runnable test files. */
export function filterTestFiles(files: string[]): string[] {
  return files.filter((f) => TEST_FILE_RE.test(f));
}

export interface TestCommand {
  kind: 'ddev' | 'host';
  args: string[];
  /** Repo-relative directory the command must run in — the framework's own project root,
   *  `''` for the workspace root. Already baked into `args` as `exec -d` on the ddev path
   *  (which needs an absolute container path); the host path applies it as a cwd. */
  cwd: string;
}

/**
 * `files` (workspace-relative) rewritten relative to the framework's project root, dropping
 * any that lands OUTSIDE it.
 *
 * A `../` path is precisely the "Total: 0 tests in 0 files" failure this whole scoping exists
 * to prevent — a runner rejects a path outside its own testDir and then exits non-zero with
 * nothing run, which is indistinguishable from a failing test. Dropping is the honest answer;
 * the caller reports what it dropped.
 */
export function scopeToRoot(files: string[], root: string): string[] {
  if (!root) return files;
  const scoped: string[] = [];
  for (const file of files) {
    const rel = path.posix.relative(root, file);
    if (rel === '' || rel === '..' || rel.startsWith('../')) continue;
    scoped.push(rel);
  }
  return scoped;
}

/** `exec` plus, when the framework's root is a SUBDIRECTORY, the `--dir` that puts the runner
 *  there. Absolute because a relative `--dir` exits 128 (measured, ddev v1.25.3), and omitted
 *  entirely at the project root so the command is byte-identical to the one that shipped
 *  before roots were resolved at all. */
function ddevExecPrefix(root: string): string[] {
  return root ? ['exec', '-d', `${DDEV_PROJECT_MOUNT}/${root}`] : ['exec'];
}

/** The failing run's own invocation shape with a repair command in place of the test
 *  command, so the line handed to a human is runnable rather than a bare hint. */
export function repairInvocation(d: TestManagementDetect, repair: string): string {
  const root = primaryFrameworkRoot(d) ?? '';
  if (d.ddev) return `ddev ${[...ddevExecPrefix(root), repair].join(' ')}`;
  return root ? `cd ${root} && ${repair}` : repair;
}

/**
 * The selective run command for ONLY the given test files (never the full
 * suite). `kind: 'ddev'` runs via ddevExec in the per-task runner ('ddev' is
 * prepended by the runner); `kind: 'host'` runs via execFile in the worktree.
 *
 * Runs from the framework's OWN project root (`opts.root`), not from the repo root. A repo
 * whose test project is a subdirectory — config and node_modules under `test-playwright/`,
 * nothing at the root — otherwise gets a runner that resolves no config and no framework
 * install: measured, `ddev exec npx playwright test test-playwright/tests/x.spec.ts` lists 0
 * tests and exits 1, while the same run with `-d /var/www/html/test-playwright` and a
 * root-relative path lists 48 and exits 0.
 *
 * Returns null when the framework cannot run a file-scoped subset (plain package/composer test
 * scripts would run the whole suite — forbidden), when no config file was found for it
 * (`root: null`), or when no requested file lives inside its root.
 */
export function buildSelectiveCommand(
  framework: TestFramework | null,
  files: string[],
  opts: { ddev: boolean; ddevPlaywrightAddon: boolean; root?: string | null },
): TestCommand | null {
  if (!framework || files.length === 0) return null;
  // The addon owns its own working directory, so it keeps the workspace-relative paths it has
  // always been handed. Not reproducible here, so deliberately left exactly as it was.
  if (framework === 'playwright' && opts.ddev && opts.ddevPlaywrightAddon)
    return { kind: 'ddev', args: ['playwright', 'test', ...files], cwd: '' };
  if (opts.root === null) return null;
  // undefined = a detect payload from before roots existed; the workspace root is what it meant.
  const root = opts.root ?? '';
  const scoped = scopeToRoot(files, root);
  if (scoped.length === 0) return null;
  const ddevPrefix = ddevExecPrefix(root);
  switch (framework) {
    case 'playwright':
      if (opts.ddev)
        return {
          kind: 'ddev',
          args: [...ddevPrefix, 'npx', 'playwright', 'test', ...scoped],
          cwd: root,
        };
      return { kind: 'host', args: ['npx', 'playwright', 'test', ...scoped], cwd: root };
    case 'cypress': {
      const spec = ['run', '--spec', scoped.join(',')];
      if (opts.ddev)
        return { kind: 'ddev', args: [...ddevPrefix, 'npx', 'cypress', ...spec], cwd: root };
      return { kind: 'host', args: ['npx', 'cypress', ...spec], cwd: root };
    }
    case 'vitest':
      if (opts.ddev)
        return {
          kind: 'ddev',
          args: [...ddevPrefix, 'npx', 'vitest', 'run', ...scoped],
          cwd: root,
        };
      return { kind: 'host', args: ['npx', 'vitest', 'run', ...scoped], cwd: root };
    case 'jest':
      if (opts.ddev)
        return { kind: 'ddev', args: [...ddevPrefix, 'npx', 'jest', ...scoped], cwd: root };
      return { kind: 'host', args: ['npx', 'jest', ...scoped], cwd: root };
    case 'phpunit':
      if (opts.ddev)
        return { kind: 'ddev', args: [...ddevPrefix, 'vendor/bin/phpunit', ...scoped], cwd: root };
      return { kind: 'host', args: ['vendor/bin/phpunit', ...scoped], cwd: root };
    case 'pytest':
      if (opts.ddev) return { kind: 'ddev', args: [...ddevPrefix, 'pytest', ...scoped], cwd: root };
      return { kind: 'host', args: ['pytest', ...scoped], cwd: root };
    case 'pkg-script':
    case 'composer-script':
      return null; // a plain test script runs the whole suite — never that
  }
}

/**
 * The framework's ENUMERATE-ONLY form of the same command, or null when we have no measured
 * one for it. Used to tell "the runner never started" apart from "the tests failed".
 *
 * Playwright only, deliberately. MEASURED against a live runner: `--list` exits 0 whenever at
 * least ONE requested spec enumerates (one real plus one nonexistent spec listed 19 tests and
 * exited 0) and 1 when none does — the broken invocation above, and a spec the tester reported
 * but never wrote. That makes the EXIT CODE the entire classifier, with no output parsing and
 * so nothing to break when the runner rewords itself. Every other framework returns null and
 * keeps the previous behaviour verbatim; adding one means measuring its list mode the same way
 * first, not assuming it behaves like this one.
 *
 * Not offered for the ddev-playwright addon, whose flag pass-through is unmeasured.
 */
export function buildCollectCommand(
  framework: TestFramework | null,
  files: string[],
  opts: { ddev: boolean; ddevPlaywrightAddon: boolean; root?: string | null },
): TestCommand | null {
  if (framework !== 'playwright') return null;
  if (opts.ddev && opts.ddevPlaywrightAddon) return null;
  const run = buildSelectiveCommand(framework, files, opts);
  if (!run) return null;
  const subcommand = run.args.indexOf('test');
  if (subcommand < 0) return null;
  return {
    ...run,
    args: [...run.args.slice(0, subcommand + 1), '--list', ...run.args.slice(subcommand + 1)],
  };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  if (!(await pathExists(file))) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function anyExists(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    if (await pathExists(path.join(dir, n))) return true;
  }
  return false;
}

/** Config files that identify each framework's PROJECT ROOT. The same names the detection
 *  below looks for at the workspace root, reused as the thing a subdirectory search matches —
 *  so "detected" and "rooted at" can never disagree about what a playwright project is. The
 *  two script pseudo-frameworks are the repo's own package/composer manifests and are rooted
 *  at the workspace by construction. */
const FRAMEWORK_CONFIGS: Record<TestFramework, string[]> = {
  playwright: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'],
  cypress: ['cypress.config.ts', 'cypress.config.js'],
  vitest: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'],
  jest: ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.cjs'],
  phpunit: ['phpunit.xml', 'phpunit.xml.dist'],
  pytest: ['pytest.ini'],
  'pkg-script': [],
  'composer-script': [],
};

/** Directories a subdirectory search never descends into: installed dependencies and build
 *  output both carry other projects' configs. */
const ROOT_SEARCH_SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage']);

/**
 * Repo-relative directory holding this framework's config: `''` when it is at the workspace
 * root, the subdirectory name when it is one level down, `null` when there is none.
 *
 * Only ONE level down, and only reached when the root has no config — a config deeper than
 * that belongs to a nested package rather than to the repo's test project, and for every
 * framework detected BY its root config the search short-circuits on the first check, so this
 * changes nothing for them. Entries are sorted so a repo with two candidates resolves the same
 * way on every host.
 */
async function resolveFrameworkRoot(workspace: string, configs: string[]): Promise<string | null> {
  if (configs.length === 0) return '';
  if (await anyExists(workspace, configs)) return '';
  const entries = await readdir(workspace, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !ROOT_SEARCH_SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const dir of dirs) {
    if (await anyExists(path.join(workspace, dir), configs)) return dir;
  }
  return null;
}

export interface InfraScan {
  frameworks: TestFramework[];
  primary: TestFramework | null;
  roots: Record<string, string | null>;
  testDirs: string[];
}

/** Deterministic test-infrastructure scan (the legacy Step-1 table, no LLM). */
export async function scanTestInfra(workspace: string): Promise<InfraScan> {
  const frameworks: TestFramework[] = [];
  const testDirs: string[] = [];

  // Detection is deliberately UNCHANGED: a marker directory still detects playwright/cypress
  // on its own. Requiring a resolvable config here would newly skip the whole step on repos it
  // runs on today; the conservative failure is to still write the tests and decline to claim we
  // ran them (see the null-command branch in apply).
  if (
    (await anyExists(workspace, FRAMEWORK_CONFIGS.playwright)) ||
    (await pathExists(path.join(workspace, 'test-playwright')))
  ) {
    frameworks.push('playwright');
  }
  if (
    (await anyExists(workspace, FRAMEWORK_CONFIGS.cypress)) ||
    (await pathExists(path.join(workspace, 'cypress')))
  ) {
    frameworks.push('cypress');
  }
  if (await anyExists(workspace, FRAMEWORK_CONFIGS.vitest)) {
    frameworks.push('vitest');
  }
  if (await anyExists(workspace, FRAMEWORK_CONFIGS.jest)) {
    frameworks.push('jest');
  }
  if (await anyExists(workspace, FRAMEWORK_CONFIGS.phpunit)) {
    frameworks.push('phpunit');
  }
  if (await anyExists(workspace, FRAMEWORK_CONFIGS.pytest)) {
    frameworks.push('pytest');
  }

  const pkg = await readJson(path.join(workspace, 'package.json'));
  const pkgScripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  if (typeof pkgScripts.test === 'string' && pkgScripts.test.length > 0) {
    frameworks.push('pkg-script');
  }
  const composer = await readJson(path.join(workspace, 'composer.json'));
  const composerScripts = (composer?.scripts ?? {}) as Record<string, unknown>;
  if (composerScripts.test !== undefined) {
    frameworks.push('composer-script');
  }

  for (const dir of ['test-playwright', 'cypress', 'e2e', 'tests', 'test']) {
    if (await pathExists(path.join(workspace, dir))) testDirs.push(dir);
  }

  const roots: Record<string, string | null> = {};
  for (const framework of frameworks) {
    roots[framework] = await resolveFrameworkRoot(workspace, FRAMEWORK_CONFIGS[framework]);
  }

  return { frameworks, primary: frameworks[0] ?? null, roots, testDirs };
}

/** The project root of the framework the selective run will use. `undefined` in the payload
 *  means it predates the field, and the workspace root is what it meant — the command it
 *  replays is then the one it originally built. */
export function primaryFrameworkRoot(detected: {
  primary: TestFramework | null;
  frameworkRoots?: Record<string, string | null>;
}): string | null {
  if (!detected.primary) return null;
  const roots = detected.frameworkRoots;
  if (!roots || !(detected.primary in roots)) return '';
  return roots[detected.primary] ?? null;
}

async function resolveWorkspace(ctx: StepContext): Promise<{ workspace: string; sandbox: string }> {
  const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const out = prev?.output as { worktreePath?: string; sandboxWorktreePath?: string } | null;
  return {
    // workspace = host path (host-side test scanning); sandbox = the agent's container
    // workspace, now the workdir root since the worktree is mounted there alone.
    workspace: out?.worktreePath ?? ctx.workspacePath,
    sandbox: ctx.sandboxWorkdir,
  };
}

function accumulateChanges(previous: StepLoopPassRecord[]): {
  created: Set<string>;
  updated: Set<string>;
  deleted: Set<string>;
  fixPasses: number;
} {
  const created = new Set<string>();
  const updated = new Set<string>();
  const deleted = new Set<string>();
  let fixPasses = 0;
  for (const p of previous) {
    const out = p.applyOutput as TestManagementApply | undefined;
    if (!out) continue;
    out.testsCreated.forEach((f) => created.add(f));
    out.testsUpdated.forEach((f) => updated.add(f));
    out.testsDeleted.forEach((f) => deleted.add(f));
    fixPasses = out.fixPasses;
  }
  return { created, updated, deleted, fixPasses };
}

const SEARCH_LADDER = [
  'When you need existing patterns or context, search in this order:',
  ...retrievalGuidanceLines(),
] as const;

export function actionInstructions(): string[] {
  // One combined test-management action: find affected tests and UPDATE, CREATE and DELETE as
  // needed for this change. Legacy pre-answers (update/create_new/remove) all map here.
  return [
    'ACTION: bring the test suite in line with this change — UPDATE, CREATE and DELETE tests as',
    'needed. Apply only the parts that fit; skip a part honestly when it does not apply.',
    '1. Find related tests: search the test directories for references to the changed files,',
    '   functions, URLs, form fields and selectors (also shared utilities, page objects, fixtures).',
    '2. UPDATE affected tests: where assertions/interactions reference changed functionality,',
    '   update them to the new behavior, keeping existing patterns. Do not touch unrelated tests',
    '   and do not refactor unnecessarily.',
    '3. CREATE tests for genuinely new behavior this change introduces (happy path, validation/',
    '   error cases, permissions if access control is involved, feature-specific edge cases).',
    '   Match the test TYPE already used in the project (E2E vs unit); read 2-3 existing test',
    '   files + shared utilities first and reuse them; add new utilities only when needed.',
    '4. DELETE tests for functionality this change removed: if an ENTIRE file tests only removed',
    '   behavior, delete the file; if a file has SOME such tests, remove just those blocks plus',
    '   any helpers/imports only they used.',
    '5. AUDIT the tests covering the components in the blast-radius block above (when one is',
    '   present): open each and check it still asserts the WHOLE of what its component does now.',
    '   A test that passes while no longer covering the behaviour is a gap — close it by adding',
    '   the missing assertion, not by rewriting a test that is still correct. A component listed',
    '   with no tests has none RECORDED in the plan, which is not the same as having none.',
    '6. If a category does not apply, skip it — do not invent work; report zero changes honestly.',
  ];
}

/** Run one built command through whichever path its `kind` names, so the selective run and the
 *  enumerate-only classifier below cannot diverge in how they reach the runner. The ddev branch
 *  requires a resolved `repoSubpath`; the caller checks that before it gets here. */
async function runTestCommand(
  ctx: StepContext,
  d: TestManagementDetect,
  cmd: TestCommand,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<{ exitCode: number; command: string; output: string }> {
  const joined = cmd.args.join(' ');
  if (cmd.kind === 'ddev') {
    const handle = runnerHandleForTask(ctx.taskId, d.repoSubpath!);
    // `onLine` switches ddevExec to its streaming path, so the caller can surface the
    // runner's latest line. Absent for the enumerate probe, which is bounded and silent.
    const res = await ddevExec(handle, joined, { timeoutMs, ...(onLine ? { onLine } : {}) });
    return { exitCode: res.exitCode, command: `ddev ${joined}`, output: res.output.slice(-4000) };
  }
  const [bin, ...rest] = cmd.args;
  try {
    const { stdout, stderr } = await exec(bin!, rest, {
      cwd: path.join(d.workspacePath, cmd.cwd),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, command: joined, output: `${stdout}${stderr}`.slice(-4000) };
  } catch (err) {
    // execFile reports a spawn failure as a STRING code (ENOENT, ETIMEDOUT) and a non-zero exit
    // as a number, so anything non-numeric becomes a plain 1 rather than leaking into a field
    // every caller compares against 0.
    const e = err as { stdout?: string; stderr?: string; code?: unknown };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      command: joined,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-4000),
    };
  }
}

/** Enumerating is cheap by construction — it loads the config and the spec files and stops —
 *  so it gets a fraction of the run's budget rather than sharing it. */
const COLLECT_TIMEOUT_MS = 120_000;

/**
 * Ask the runner to enumerate the repo's EXISTING specs before a tester agent is dispatched,
 * and report the block when it can load none of them.
 *
 * Gated on a structural hint (an `.env` a template says should exist and does not) so a repo
 * without one pays nothing at all. The hint never decides — the probe's EXIT CODE does, which
 * is the same invariant the post-run enumerate guard reads and the reason neither has to parse
 * the runner's prose.
 *
 * Every "cannot tell" answers null and lets the step run exactly as before: the probe is a way
 * to fail EARLY, never a new way to fail. The runtime is used only if it is ALREADY up —
 * `ensureAppServing` blocks in the runtime admission gate, which detect() must never do.
 */
async function runTestPreflight(
  ctx: StepContext,
  d: TestManagementDetect,
): Promise<TestPreflightBlock | null> {
  if (!(await configService.getBoolean(CONFIG_KEYS.TEST_PREFLIGHT_ENABLED, true))) return null;
  // Playwright only, the same discipline buildCollectCommand states for its list mode: adding
  // a framework means measuring what its enumerate mode prints and exits with, first.
  if (d.primary !== 'playwright') return null;

  const root = primaryFrameworkRoot(d);
  if (root === null) return null;

  const missing = await findMissingEnvFiles(d.workspacePath, [root, '']);
  if (missing.length === 0) return null;

  const specs = await findExistingSpecFiles(d.workspacePath, root);
  // Nothing to enumerate is not evidence of a broken environment — a repo whose suite is
  // empty and one whose suite cannot load both list zero tests, and only the second is a
  // block. The tester writing the first specs is the normal path here.
  if (specs.length === 0) return null;

  const collect = buildCollectCommand(d.primary, specs, {
    ddev: d.ddev,
    ddevPlaywrightAddon: d.ddevPlaywrightAddon,
    root,
  });
  if (!collect) return null;
  if (collect.kind === 'ddev') {
    if (!d.repoSubpath) return null;
    if (!(await ddevRunnerRunning(runnerHandleForTask(ctx.taskId, d.repoSubpath)))) return null;
  }

  const listed = await runTestCommand(ctx, d, collect, COLLECT_TIMEOUT_MS).catch(() => null);
  // A probe that could not be RUN proves nothing; only one that ran and refused to enumerate
  // anything is a block.
  if (!listed || listed.exitCode === 0) return null;

  ctx.logger.info(
    { specs: specs.length, missing: missing.map((m) => m.expected) },
    'test pre-flight: runner enumerated none of the existing specs',
  );
  return { command: listed.command, output: listed.output, missing };
}

/** Budget for the prior-pass block. Mirrors loadPriorFixContext's (400 chars per entry,
 *  4000 for the block) so this loop and the round-level one read the same way. */
const PRIOR_PASS_ENTRY_LIMIT = 400;
const PRIOR_PASS_BLOCK_LIMIT = 4000;

/**
 * What earlier passes of THIS step already concluded, deduped by prose.
 *
 * Each pass is a fresh CLI process handed only the failing run's command and output, so
 * without this every pass re-derives the same diagnosis from the same bytes. MEASURED on
 * task 681f0f99: five consecutive passes independently concluded "the Playwright browser
 * binaries are not installed in the DDEV web container" and each wrote it to `notes`, which
 * nothing read. Deduped with the ledger's own fingerprint rather than a second convention,
 * which collapses a verbatim repeat but NOT two rewordings of one finding — the same limit
 * review_findings measured when it keyed recurrence on prose. The block cap is what bounds
 * that case, and five near-identical paragraphs are still a better prompt than none.
 */
export function priorPassNotes(previous: StepLoopPassRecord[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  previous.forEach((p, i) => {
    const raw = (p.applyOutput as TestManagementApply | undefined)?.notes ?? '';
    const notes = cleanText(raw, PRIOR_PASS_ENTRY_LIMIT);
    if (notes.length === 0) return;
    const fp = contentFingerprint('08b-pass', notes);
    if (seen.has(fp)) return;
    seen.add(fp);
    lines.push(`- pass ${i}: ${notes}`);
  });
  if (lines.length === 0) return '';
  const block = [
    'WHAT EARLIER PASSES OF THIS STEP ALREADY CONCLUDED (background — do not repeat this',
    'diagnosis work, build on it. If a pass already established the failure is not a test or',
    'code defect, say so plainly and change nothing rather than re-deriving it):',
    ...lines,
  ].join('\n');
  return block.length > PRIOR_PASS_BLOCK_LIMIT ? block.slice(0, PRIOR_PASS_BLOCK_LIMIT) : block;
}

/** The fix-loop diagnosis handed to the implementer once the tester's own passes are
 *  spent. Carries the same three-way framing the tester agent was given, so the
 *  implementer does not treat the failing assertion as gospel. */
function buildTestFailureDiagnosis(out: TestManagementApply): string {
  const touched = [...out.testsCreated, ...out.testsUpdated];
  return [
    `The related tests still fail after ${out.fixPasses} fix pass(es) by the test-management step.`,
    'Decide per failure whether the TEST is wrong (fix the test), the CODE is wrong (fix the',
    'code), or the test is FLAKY (replace arbitrary waits with proper assertions).',
    touched.length > 0 ? `\nTests written or updated by that step:\n- ${touched.join('\n- ')}` : '',
    out.notes ? `\nWhat the tester agent concluded on its last pass:\n${out.notes}` : '',
    out.testRun?.command ? `\nCommand: ${out.testRun.command}` : '',
    out.testRun?.output ? `\nFailure output:\n${out.testRun.output}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const testManagementStep: StepDefinition<TestManagementDetect, TestManagementApply> = {
  // Playwright/Cypress run against a SERVING app. The runtime is brought up far
  // earlier (01a/01c, re-ensured by 07c), but the idle reaper can reclaim it during
  // the 07→07c chain, so re-ensure rather than assume. 'if-serving' keeps a
  // code-only repo out of the runtime pool.
  needsRuntime: 'if-serving',
  metadata: {
    id: '08b-test-management',
    workflowType: 'workflow',
    // Between 07c-ddev-reconcile (7.8) and 08-phase-5-verify (8): tests must be
    // reconciled with the change before verify runs the full suite, else a stale
    // assertion costs an implementation round. The `08b-` id is kept despite the
    // move — it is the persisted task_steps.step_id and the pre_answers /
    // step_loop_limits key.
    index: 7.9,
    title: 'Phase 5b: Test management',
    description:
      "Keeps the project's automated tests in sync with the change: a tester agent creates/updates/removes tests per your choice, then the related tests run selectively with a fix loop.",
    requiresCli: false,
    // Test management is genuinely optional, and the pre-flight gate below can park the step
    // on a precondition only a human can clear. Skipping has to be reachable from there, or
    // the gate is a dead end. Keep in sync with SKIPPABLE_STEP_IDS — the api cannot import
    // this registry.
    allowSkip: true,
  },

  // ensureAppServing can throw; without a route a DDEV boot failure would hard-fail
  // the task at a step a plain retry cannot clear. Same predicate as 07c/08/08a, so
  // only agent-authored build failures loop back.
  fixLoopOnError: isDdevAgentFixableFailure,

  // Fix-loop: the tester agent's own passes (`loop`, below) are the first responder
  // and can rewrite the test OR the code. This fires only once that budget is spent
  // and the run is still red. `testsPassed === null` is not a failure and must not
  // loop back — it covers "skip", no runnable test files, a framework with no
  // file-scoped subset, and an unavailable DDEV runner.
  fixLoop: {
    evaluate: (out) =>
      out.testsPassed === false
        ? { blocking: true, diagnosis: buildTestFailureDiagnosis(out) }
        : null,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const { workspace } = await resolveWorkspace(ctx);
    const infra = await scanTestInfra(workspace);
    return infra.frameworks.length > 0;
  },

  async detect(ctx: StepContext): Promise<TestManagementDetect> {
    const { workspace, sandbox } = await resolveWorkspace(ctx);
    const infra = await scanTestInfra(workspace);

    const ddev = await pathExists(path.join(workspace, '.ddev', 'config.yaml'));
    const ddevPlaywrightAddon =
      ddev &&
      ((await pathExists(path.join(workspace, '.ddev', 'addon-metadata', 'ddev-playwright'))) ||
        (await pathExists(path.join(workspace, '.ddev', 'commands', 'web', 'playwright'))));
    const ws = ddev ? await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath) : null;

    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    const detected: TestManagementDetect = {
      workspacePath: workspace,
      sandboxWorktreePath: sandbox,
      frameworks: infra.frameworks,
      primary: infra.primary,
      frameworkRoots: infra.roots,
      testDirs: infra.testDirs,
      ddev,
      ddevPlaywrightAddon,
      repoSubpath: ws?.repoSubpath ?? null,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, workspace),
      // This agent writes tests, not application code, and reads the list to find
      // coverage that has fallen behind rather than components to touch.
      planImpact: planImpactBlock(await loadPlanImpactContext(ctx), { role: 'tester' }),
    };
    // Last, and on the fully-built payload: the probe reuses the same command builders the
    // real run does, so it needs the roots and the ddev fields already resolved.
    return { ...detected, preflight: await runTestPreflight(ctx, detected) };
  },

  form(_ctx, detected): FormSchema {
    // The runner could load none of the repo's existing tests, so a tester pass would write
    // tests nothing can execute. Park instead of spending it — the gate is a retry schema, so
    // it holds even under auto-continue, and Retry re-runs detect once the file exists.
    if (detected.preflight) return preflightGateSchema(detected.preflight);
    // Name where each framework is rooted: a project the runner cannot find is otherwise
    // indistinguishable here from one that works, and this form is where a human would look.
    const infra = detected.frameworks
      .map((f) => {
        const root = detected.frameworkRoots?.[f];
        if (root === null) return `${f} (no config file found)`;
        return root ? `${f} (in ${root}/)` : f;
      })
      .join(', ');
    return {
      title: 'Phase 5b: Test management',
      description: [
        `Detected test infrastructure: ${infra}`,
        detected.testDirs.length > 0 ? `Test directories: ${detected.testDirs.join(', ')}` : '',
        detected.ddev
          ? `DDEV project — selective runs execute in the per-task DDEV environment${detected.ddevPlaywrightAddon ? ' (playwright addon present)' : ''}.`
          : '',
        'Choose what test management should do for this change.',
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          type: 'radio',
          id: 'action',
          label: 'Test action',
          options: [
            {
              value: 'manage',
              label: 'Find, update, write & delete tests as needed for this change',
            },
            { value: 'skip', label: 'No test changes needed' },
          ],
          default: 'manage',
          required: true,
        },
        {
          type: 'checkbox',
          id: 'runTests',
          label: 'Run the related tests after changes (selective — never the full suite)',
          default: true,
        },
        {
          type: 'textarea',
          id: 'hints',
          label: 'Hints for locating related tests (optional)',
          rows: 3,
          placeholder: 'Feature keywords, URLs, selectors, form field names…',
        },
      ],
      submitLabel: 'Run test management',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    skipIf: ({ formValues }) => (formValues as { action?: string }).action === 'skip',
    buildPrompt: (args) => {
      const d = args.detected as TestManagementDetect;
      const values = args.formValues as { action?: string; hints?: string };
      return [
        "You are the test-management phase of an engineering workflow. Keep the project's",
        'automated tests in sync with the change that was just implemented. The full suite runs',
        'after you, so what you leave behind is what it will grade.',
        agentDefinitionGuidance(
          'test-writer',
          [
            'If a `.claude/agents/test-writer.md` agent definition exists in the repo, follow its',
            'conventions for how to write/maintain tests; otherwise follow the protocol below.',
          ].join('\n'),
        ),
        '',
        `Workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        `Test infrastructure: ${d.frameworks.join(', ')}${d.testDirs.length > 0 ? ` (directories: ${d.testDirs.join(', ')})` : ''}`,
        changedFilesBlock(d.implementationFiles, 'Files changed by the implementation', ''),
        ...(d.planImpact ? ['', d.planImpact] : []),
        values.hints ? `User hints for locating related tests: ${values.hints}` : '',
        '',
        ...actionInstructions(),
        '',
        'Do NOT run the tests yourself (the orchestrator runs the related tests after you',
        'finish) and do NOT run git (it is unavailable in this environment).',
        ...SEARCH_LADDER,
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "tests_created": ["path"], "tests_updated": ["path"], "tests_deleted": ["path"], "notes": "<summary or empty>" }',
        'Paths are relative to the workspace root.',
        '',
        '=== Spec (what the change delivers) ===',
        d.spec || '(no spec recorded)',
      ]
        .filter(Boolean)
        .join('\n');
    },
    bypassStub: () => ({
      tests_created: [],
      tests_updated: [],
      tests_deleted: [],
      notes: 'bypass stub',
    }),
  },

  loop: {
    // Initial tester pass + up to 5 fix attempts (legacy cap), driven by the
    // selective test run's result. The runner evaluates this before fixLoop and
    // returns early while it continues, so fixLoop only sees an exhausted budget.
    maxIterations: 6,
    // Pass 0 writes the tests; every later pass is a fix driven by the selective run
    // that failed. Same agent and same provider throughout, so there is no cliRoles
    // entry to name it — see StepLoopSpec.passLabel.
    passLabel: (iteration) => (iteration === 0 ? 'Test writer' : `Test fixer ${iteration}`),
    shouldContinue: ({ applyOutput }) => {
      const out = applyOutput as TestManagementApply;
      return out.testsPassed === false;
    },
    buildIterationPrompt: ({ detected, previousIterations }) => {
      const d = detected as TestManagementDetect;
      const last = previousIterations[previousIterations.length - 1]?.applyOutput as
        TestManagementApply | undefined;
      const run = last?.testRun;
      return [
        'The related tests were run after your test changes and FAILED. Fix them.',
        agentDefinitionGuidance(
          'test-writer',
          [
            'If a `.claude/agents/test-writer.md` agent definition exists in the repo, follow its',
            'conventions; otherwise follow the protocol below.',
          ].join('\n'),
        ),
        '',
        `Workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        run ? `Command: ${run.command}` : '',
        run ? `Failure output:\n${run.output}` : '',
        '',
        priorPassNotes(previousIterations),
        'Determine for each failure whether:',
        '(a) the TEST is wrong (selector/assertion outdated) → fix the test,',
        '(b) the CODE has a bug → fix the application code,',
        '(c) the test is FLAKY (timing/race) → replace arbitrary waits with proper assertions.',
        'DO NOT modify tests unrelated to the failures. Do NOT run the tests yourself and do',
        'NOT run git.',
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "tests_created": [], "tests_updated": ["path"], "tests_deleted": [], "notes": "<what you fixed>" }',
        '',
        '=== Spec (the expected behavior) ===',
        d.spec || '(no spec recorded)',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },

  async apply(ctx, args): Promise<TestManagementApply> {
    const d = args.detected;
    const values = args.formValues as { action?: string; runTests?: boolean };
    const action = values.action ?? 'manage';

    if (action === 'skip') {
      return {
        action,
        testsCreated: [],
        testsUpdated: [],
        testsDeleted: [],
        notes: 'test management skipped by user',
        testRun: null,
        testsPassed: null,
        fixPasses: 0,
      };
    }

    const acc = accumulateChanges(args.previousIterations);
    const pass = parseTesterOutput(args.llmOutput ?? null);
    pass.testsCreated.forEach((f) => acc.created.add(f));
    pass.testsUpdated.forEach((f) => acc.updated.add(f));
    pass.testsDeleted.forEach((f) => acc.deleted.add(f));
    const fixPasses = args.iteration; // pass 0 = initial, each further pass is a fix

    const changed = acc.created.size + acc.updated.size + acc.deleted.size > 0;
    let testRun: TestRunResult | null = null;
    let testsPassed: boolean | null = null;
    let degradedNote: string | undefined;

    if (values.runTests !== false && changed) {
      const targets = filterTestFiles([...acc.created, ...acc.updated]);
      const root = primaryFrameworkRoot(d);
      const buildOpts = { ddev: d.ddev, ddevPlaywrightAddon: d.ddevPlaywrightAddon, root };
      const cmd = buildSelectiveCommand(d.primary, targets, buildOpts);
      // Idempotent no-op when the runtime is already up; guards against the idle
      // reaper having reclaimed it during the 07→07c chain.
      if (cmd !== null) await ensureAppServing(ctx);
      if (cmd === null) {
        // Four reasons, kept distinct: two are routine, and two mean the tests were WRITTEN and
        // could not be run — a caveat a human has to see rather than a quiet skip.
        const scriptOnly = d.primary === 'pkg-script' || d.primary === 'composer-script';
        const output =
          targets.length === 0
            ? 'no runnable test files among the changes — selective run skipped'
            : scriptOnly
              ? 'selective run unsupported for plain test scripts (would run the full suite) — skipped'
              : root === null
                ? `no ${d.primary} configuration file was found in the workspace, so the related tests could not be run — they were written but never executed`
                : `none of the changed test files are inside the ${d.primary} project root (${root}/), so the related tests could not be run — they were written but never executed`;
        testRun = { ran: false, passed: false, command: '', output };
        testsPassed = null;
        if (targets.length > 0 && !scriptOnly) degradedNote = output;
      } else if (cmd.kind === 'ddev' && !d.repoSubpath) {
        // DDEV command but no per-task runner subpath — host-side ddev is the
        // broken DooD path, so skip rather than fail confusingly.
        testRun = {
          ran: false,
          passed: false,
          command: `ddev ${cmd.args.join(' ')}`,
          output: 'DDEV runner unavailable for the selective test run — skipped',
        };
        testsPassed = null;
      } else {
        // The DDEV web image carries neither the browser binaries nor the libraries they
        // link against, and nothing in the sandbox can add them. Idempotent, so it runs
        // before every pass rather than being guessed at once; a failure is left to the
        // classifier below to NAME rather than raised, since a browser we could not install
        // is precisely the gap that classifier reports.
        let provisionNote: string | null = null;
        if (cmd.kind === 'ddev' && d.primary === 'playwright') {
          await ctx.emitProgress('Preparing the browser runtime in the DDEV environment…');
          const provisioned = await ensureDdevPlaywrightBrowsers(
            runnerHandleForTask(ctx.taskId, d.repoSubpath!),
            primaryFrameworkRoot(d) ?? '',
          );
          if (provisioned.attempted && !provisioned.ok) provisionNote = provisioned.note;
          // A run abandoned by a worker restart keeps running inside the container and, under
          // the html reporter, ends by serving its report forever — mutating the app under
          // whatever runs next. The runner is per task and only this step starts tests in it,
          // so anything alive here is a leftover.
          await killStalePlaywrightRuns(runnerHandleForTask(ctx.taskId, d.repoSubpath!));
        }

        // A selective run is still minutes of silence — one spec file can hold ~50 browser
        // tests — and a fixed "Running related tests…" line is indistinguishable from a stuck
        // task. withDdevProgress is the same live status every long DDEV op already uses: the
        // runner's latest line plus an elapsed counter that ticks through silent phases. Its
        // name says ddev but its contract is just `emitProgress`, so the host branch gets the
        // counter too — execFile buffers and has no line to give, and "looks frozen" is the
        // half that matters there.
        const run = await withDdevProgress(
          ctx,
          cmd.kind === 'ddev' ? 'Running related tests in DDEV' : 'Running related tests',
          (onLine) =>
            runTestCommand(ctx, d, cmd, 600_000, cmd.kind === 'ddev' ? onLine : undefined),
          { initialLine: cmd.args.join(' ') },
        );
        testRun = {
          ran: true,
          passed: run.exitCode === 0,
          command: run.command,
          output: run.output,
        };
        testsPassed = testRun.passed;

        // An environment that cannot run a browser is not a test defect, and no fix pass can
        // repair it from inside the sandbox — the CLI is given ddev_status/logs/restart and no
        // `ddev exec`. Read from the RUN's own output, because the enumerate guard below cannot
        // see this class at all: `--list` skips globalSetup, so a container with no browser
        // binaries lists every test and exits 0. Applies from pass 0, unlike that guard — a
        // browser missing from the container is never something the tester's own pass caused.
        const blocked = testRun.passed ? null : classifyTestEnvFailure(d.primary, run.output);
        if (blocked) {
          testRun = { ...testRun, ran: false };
          testsPassed = null;
          degradedNote =
            `The related tests could not be run: ${blocked.reason}. They were written but never ` +
            `executed, and the suite is NOT known to be green. No fix pass can repair this from ` +
            `inside the sandbox.\n\nRun: ${testRun.command}\n\nRepair with:\n` +
            `${repairInvocation(d, blocked.repair)}\n\n${run.output}` +
            (provisionNote
              ? `\n\nProvisioning it automatically also failed:\n${provisionNote}`
              : '');
        }

        // A failed run is only worth a fix agent if the runner actually ran something. Ask it to
        // ENUMERATE the same files: a non-zero exit there means it could enumerate NONE of them
        // — a harness it cannot load, or files the tester reported but never wrote — and no fix
        // pass can act on that. Skipped when the run passed, so the green path costs nothing.
        //
        // From the FIRST fix pass onward, never from the tester's own pass: a spec the tester
        // just wrote with a syntax error also enumerates as nothing, and that IS the fixer's to
        // repair. Giving it one pass keeps that repair while capping the failure this exists for
        // — the observed task spent 5 passes and a whole round back through implementation on a
        // playwright install its command never reached.
        const collect =
          blocked || testRun.passed || args.iteration === 0
            ? null
            : buildCollectCommand(d.primary, targets, buildOpts);
        if (collect) {
          const listed = await runTestCommand(ctx, d, collect, COLLECT_TIMEOUT_MS);
          if (listed.exitCode !== 0) {
            testRun = { ...testRun, ran: false };
            testsPassed = null;
            degradedNote =
              `The ${d.primary} runner could not enumerate any of the tests this step wrote, so ` +
              `none of them were executed and further fix passes were stood down. The suite is ` +
              `NOT known to be green.\n\nRun: ${testRun.command}\nEnumerate: ${listed.command}` +
              `\n\n${listed.output}`;
          }
        }
      }
    }

    ctx.logger.info(
      {
        action,
        created: acc.created.size,
        updated: acc.updated.size,
        deleted: acc.deleted.size,
        testsPassed,
        frameworkRoot: primaryFrameworkRoot(d),
        notRun: degradedNote !== undefined,
        iteration: args.iteration,
      },
      'test management pass complete',
    );
    return {
      action,
      testsCreated: [...acc.created],
      testsUpdated: [...acc.updated],
      testsDeleted: [...acc.deleted],
      notes: pass.notes,
      testRun,
      testsPassed,
      fixPasses,
      ...(degradedNote ? { degradedNote } : {}),
    };
  },
};
