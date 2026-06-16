import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { runnerHandleForTask, ddevExec } from '../../../sandbox/ddev-runner.js';

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
  repoSubpath: string | null;
  test: SlotCommand | null;
  lint: SlotCommand | null;
  typecheck: SlotCommand | null;
}

interface CheckResult {
  ran: boolean;
  passed: boolean;
  command: string | null;
  output: string;
}

interface VerifyApply {
  test: CheckResult;
  lint: CheckResult;
  typecheck: CheckResult;
  passed: boolean;
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
  const p = path.join(workspace, file);
  if (!(await pathExists(p))) return {};
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
    const s = parsed?.scripts;
    return s && typeof s === 'object' ? (s as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function detectPackageManager(workspace: string): Promise<PackageManager> {
  if (await pathExists(path.join(workspace, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(workspace, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(workspace, 'package-lock.json'))) return 'npm';
  if (await pathExists(path.join(workspace, 'package.json'))) return 'npm';
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
    for (const n of names) if (await pathExists(path.join(workspace, n))) return true;
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

async function runSlot(
  cmd: SlotCommand,
  ctx: StepContext,
  workspace: string,
  repoSubpath: string | null,
): Promise<CheckResult> {
  if (cmd.kind === 'ddev') {
    if (!repoSubpath) {
      return {
        ran: false,
        passed: false,
        command: cmd.label,
        output: 'DDEV runner unavailable — skipped',
      };
    }
    const handle = runnerHandleForTask(ctx.taskId, repoSubpath);
    const res = await ddevExec(handle, cmd.argv.join(' '), { timeoutMs: 600_000 });
    return {
      ran: true,
      passed: res.exitCode === 0,
      command: cmd.label,
      output: res.output.slice(-4000),
    };
  }
  try {
    const [bin, ...rest] = cmd.argv;
    const { stdout, stderr } = await exec(bin!, rest, {
      cwd: workspace,
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ran: true,
      passed: true,
      command: cmd.label,
      output: `${stdout}${stderr}`.slice(0, 4000),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return {
      ran: true,
      passed: false,
      command: cmd.label,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 4000),
    };
  }
}

const skippedResult = (): CheckResult => ({
  ran: false,
  passed: false,
  command: null,
  output: 'skipped',
});

export const phase5VerifyStep: StepDefinition<VerifyDetect, VerifyApply> = {
  metadata: {
    id: '08-phase-5-verify',
    workflowType: 'workflow',
    index: 8,
    title: 'Phase 5: Verify',
    description:
      'Runs the project verification suite (tests, lint, typecheck) against the workspace and records the outcome for gate 2.',
    requiresCli: false,
  },

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
          parts.push(
            `### ${name} failed${check.command ? ` (\`${check.command}\`)` : ''}\n${check.output.slice(-2000)}`,
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
    let repoSubpath: string | null = null;
    let ddevMode = false;
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')))) {
      ddevMode = true;
      repoSubpath = ws.repoSubpath;
      workspace = ws.workspace;
    }
    const slots = await resolveSlots(workspace, ddevMode);
    return { workspacePath: workspace, ddevMode, repoSubpath, ...slots };
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
      repoSubpath,
      test: testCmd,
      lint: lintCmd,
      typecheck: typeCmd,
    } = args.detected;

    const test =
      values.runTest && testCmd
        ? await runSlot(testCmd, ctx, workspacePath, repoSubpath)
        : skippedResult();
    const lint =
      values.runLint && lintCmd
        ? await runSlot(lintCmd, ctx, workspacePath, repoSubpath)
        : skippedResult();
    const typecheck =
      values.runTypecheck && typeCmd
        ? await runSlot(typeCmd, ctx, workspacePath, repoSubpath)
        : skippedResult();

    const passed =
      (!test.ran || test.passed) &&
      (!lint.ran || lint.passed) &&
      (!typecheck.ran || typecheck.passed);

    ctx.logger.info(
      {
        test: test.ran ? (test.passed ? 'pass' : 'fail') : 'skip',
        lint: lint.ran ? (lint.passed ? 'pass' : 'fail') : 'skip',
        typecheck: typecheck.ran ? (typecheck.passed ? 'pass' : 'fail') : 'skip',
      },
      'verify phase complete',
    );
    return { test, lint, typecheck, passed };
  },
};
