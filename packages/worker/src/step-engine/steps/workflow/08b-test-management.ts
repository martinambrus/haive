import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { agentDefinitionGuidance, retrievalGuidanceLines } from '../_retrieval-guidance.js';
import { hasAnyKey, parseAgentJson } from './_agent-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { runnerHandleForTask, ddevExec } from '../../../sandbox/ddev-runner.js';

// Phase 5b — Test management (legacy phase5b-test-management.md). After browser
// verification, keep the project's automated tests in sync with the change:
// deterministically detect the test infrastructure (no LLM), let the user pick
// the action (the legacy mandatory questions, folded into the one-shot form),
// run ONE tester agent to create/update/delete tests following the project's
// conventions, then optionally run ONLY the related tests (never the full
// suite) — in the per-task DDEV runner when the repo uses DDEV — looping a fix
// agent on failures (legacy cap: 5 attempts, then escalate via gate-2). No
// detectable infrastructure → the step is skipped.

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
  testDirs: string[];
  ddev: boolean;
  ddevPlaywrightAddon: boolean;
  repoSubpath: string | null;
  spec: string;
  implementationFiles: string[];
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

/**
 * The selective run command for ONLY the given test files (never the full
 * suite). `kind: 'ddev'` runs via ddevExec in the per-task runner ('ddev' is
 * prepended by the runner); `kind: 'host'` runs via execFile in the worktree.
 * Returns null when the framework cannot run a file-scoped subset (plain
 * package/composer test scripts would run the whole suite — forbidden).
 */
export function buildSelectiveCommand(
  framework: TestFramework | null,
  files: string[],
  opts: { ddev: boolean; ddevPlaywrightAddon: boolean },
): { kind: 'ddev' | 'host'; args: string[] } | null {
  if (!framework || files.length === 0) return null;
  switch (framework) {
    case 'playwright':
      if (opts.ddev && opts.ddevPlaywrightAddon)
        return { kind: 'ddev', args: ['playwright', 'test', ...files] };
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'npx', 'playwright', 'test', ...files] };
      return { kind: 'host', args: ['npx', 'playwright', 'test', ...files] };
    case 'cypress': {
      const spec = ['run', '--spec', files.join(',')];
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'npx', 'cypress', ...spec] };
      return { kind: 'host', args: ['npx', 'cypress', ...spec] };
    }
    case 'vitest':
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'npx', 'vitest', 'run', ...files] };
      return { kind: 'host', args: ['npx', 'vitest', 'run', ...files] };
    case 'jest':
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'npx', 'jest', ...files] };
      return { kind: 'host', args: ['npx', 'jest', ...files] };
    case 'phpunit':
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'vendor/bin/phpunit', ...files] };
      return { kind: 'host', args: ['vendor/bin/phpunit', ...files] };
    case 'pytest':
      if (opts.ddev) return { kind: 'ddev', args: ['exec', 'pytest', ...files] };
      return { kind: 'host', args: ['pytest', ...files] };
    case 'pkg-script':
    case 'composer-script':
      return null; // a plain test script runs the whole suite — never that
  }
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

interface InfraScan {
  frameworks: TestFramework[];
  primary: TestFramework | null;
  testDirs: string[];
}

/** Deterministic test-infrastructure scan (the legacy Step-1 table, no LLM). */
async function scanTestInfra(workspace: string): Promise<InfraScan> {
  const frameworks: TestFramework[] = [];
  const testDirs: string[] = [];

  if (
    (await anyExists(workspace, [
      'playwright.config.ts',
      'playwright.config.js',
      'playwright.config.mjs',
    ])) ||
    (await pathExists(path.join(workspace, 'test-playwright')))
  ) {
    frameworks.push('playwright');
  }
  if (
    (await anyExists(workspace, ['cypress.config.ts', 'cypress.config.js'])) ||
    (await pathExists(path.join(workspace, 'cypress')))
  ) {
    frameworks.push('cypress');
  }
  if (await anyExists(workspace, ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts'])) {
    frameworks.push('vitest');
  }
  if (
    await anyExists(workspace, [
      'jest.config.js',
      'jest.config.ts',
      'jest.config.mjs',
      'jest.config.cjs',
    ])
  ) {
    frameworks.push('jest');
  }
  if (await anyExists(workspace, ['phpunit.xml', 'phpunit.xml.dist'])) {
    frameworks.push('phpunit');
  }
  if (await pathExists(path.join(workspace, 'pytest.ini'))) {
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

  return { frameworks, primary: frameworks[0] ?? null, testDirs };
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

function actionInstructions(): string[] {
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
    '5. If a category does not apply, skip it — do not invent work; report zero changes honestly.',
  ];
}

export const testManagementStep: StepDefinition<TestManagementDetect, TestManagementApply> = {
  metadata: {
    id: '08b-test-management',
    workflowType: 'workflow',
    index: 8.7,
    title: 'Phase 5b: Test management',
    description:
      "Keeps the project's automated tests in sync with the change: a tester agent creates/updates/removes tests per your choice, then the related tests run selectively with a fix loop.",
    requiresCli: false,
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

    return {
      workspacePath: workspace,
      sandboxWorktreePath: sandbox,
      frameworks: infra.frameworks,
      primary: infra.primary,
      testDirs: infra.testDirs,
      ddev,
      ddevPlaywrightAddon,
      repoSubpath: ws?.repoSubpath ?? null,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, workspace),
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 5b: Test management',
      description: [
        `Detected test infrastructure: ${detected.frameworks.join(', ')}`,
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
        'automated tests in sync with the change that was just implemented and verified.',
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
        d.implementationFiles.length > 0
          ? `Files changed by the implementation:\n- ${d.implementationFiles.join('\n- ')}`
          : '',
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
    // selective test run's result. Exhausted with failures → gate-2 escalates.
    maxIterations: 6,
    shouldContinue: ({ applyOutput }) => {
      const out = applyOutput as TestManagementApply;
      return out.testsPassed === false;
    },
    buildIterationPrompt: ({ detected, previousIterations }) => {
      const d = detected as TestManagementDetect;
      const last = previousIterations[previousIterations.length - 1]?.applyOutput as
        | TestManagementApply
        | undefined;
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

    if (values.runTests !== false && changed) {
      const targets = filterTestFiles([...acc.created, ...acc.updated]);
      const cmd = buildSelectiveCommand(d.primary, targets, {
        ddev: d.ddev,
        ddevPlaywrightAddon: d.ddevPlaywrightAddon,
      });
      if (cmd === null) {
        testRun = {
          ran: false,
          passed: false,
          command: '',
          output:
            targets.length === 0
              ? 'no runnable test files among the changes — selective run skipped'
              : 'selective run unsupported for plain test scripts (would run the full suite) — skipped',
        };
        testsPassed = null;
      } else if (cmd.kind === 'ddev' && d.repoSubpath) {
        await ctx.emitProgress('Running related tests in the DDEV environment…');
        const handle = runnerHandleForTask(ctx.taskId, d.repoSubpath);
        const res = await ddevExec(handle, cmd.args.join(' '), { timeoutMs: 600_000 });
        testRun = {
          ran: true,
          passed: res.exitCode === 0,
          command: `ddev ${cmd.args.join(' ')}`,
          output: res.output.slice(-4000),
        };
        testsPassed = testRun.passed;
      } else if (cmd.kind === 'ddev') {
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
        await ctx.emitProgress('Running related tests…');
        const [bin, ...rest] = cmd.args;
        try {
          const { stdout, stderr } = await exec(bin!, rest, {
            cwd: d.workspacePath,
            timeout: 600_000,
            maxBuffer: 10 * 1024 * 1024,
          });
          testRun = {
            ran: true,
            passed: true,
            command: cmd.args.join(' '),
            output: `${stdout}${stderr}`.slice(-4000),
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string };
          testRun = {
            ran: true,
            passed: false,
            command: cmd.args.join(' '),
            output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(-4000),
          };
        }
        testsPassed = testRun.passed;
      }
    }

    ctx.logger.info(
      {
        action,
        created: acc.created.size,
        updated: acc.updated.size,
        deleted: acc.deleted.size,
        testsPassed,
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
    };
  },
};
