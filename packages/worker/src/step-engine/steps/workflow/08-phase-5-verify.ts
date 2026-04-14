import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';

const exec = promisify(execFile);

interface VerifyDetect {
  workspacePath: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'none';
  hasTest: boolean;
  hasLint: boolean;
  hasTypecheck: boolean;
  scripts: Record<string, string>;
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

async function readPackageJson(
  workspace: string,
): Promise<{ scripts: Record<string, string> } | null> {
  const pkgPath = path.join(workspace, 'package.json');
  if (!(await pathExists(pkgPath))) return null;
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const scripts =
      parsed && typeof parsed === 'object' && parsed.scripts && typeof parsed.scripts === 'object'
        ? (parsed.scripts as Record<string, string>)
        : {};
    return { scripts };
  } catch {
    return null;
  }
}

async function detectPackageManager(workspace: string): Promise<VerifyDetect['packageManager']> {
  if (await pathExists(path.join(workspace, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(workspace, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(workspace, 'package-lock.json'))) return 'npm';
  return 'none';
}

function pickScript(scripts: Record<string, string>, candidates: string[]): string | null {
  for (const name of candidates) {
    if (typeof scripts[name] === 'string' && scripts[name].length > 0) return name;
  }
  return null;
}

async function runScript(
  cwd: string,
  pm: VerifyDetect['packageManager'],
  script: string,
): Promise<CheckResult> {
  if (pm === 'none') {
    return { ran: false, passed: false, command: null, output: 'no package manager detected' };
  }
  const command = `${pm} run ${script}`;
  try {
    const { stdout, stderr } = await exec(pm, ['run', script], {
      cwd,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${stdout.toString()}${stderr.toString()}`.slice(0, 4000);
    return { ran: true, passed: true, command, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const output = `${(e.stdout ?? '').toString()}${(e.stderr ?? '').toString()}`.slice(0, 4000);
    return { ran: true, passed: false, command, output };
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

  async detect(ctx: StepContext): Promise<VerifyDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    const workspace = worktreeOutput?.worktreePath ?? ctx.workspacePath;
    const pkg = await readPackageJson(workspace);
    const scripts = pkg?.scripts ?? {};
    const pm = await detectPackageManager(workspace);
    return {
      workspacePath: workspace,
      packageManager: pm,
      hasTest: pickScript(scripts, ['test', 'test:unit', 'test:ci']) !== null,
      hasLint: pickScript(scripts, ['lint', 'lint:check', 'eslint']) !== null,
      hasTypecheck: pickScript(scripts, ['typecheck', 'type-check', 'tsc']) !== null,
      scripts,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 5: Verify',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Package manager: ${detected.packageManager}`,
        `Detected scripts — test: ${detected.hasTest}, lint: ${detected.hasLint}, typecheck: ${detected.hasTypecheck}`,
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'runTest',
          label: 'Run tests',
          default: detected.hasTest,
        },
        {
          type: 'checkbox',
          id: 'runLint',
          label: 'Run lint',
          default: detected.hasLint,
        },
        {
          type: 'checkbox',
          id: 'runTypecheck',
          label: 'Run typecheck',
          default: detected.hasTypecheck,
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
    const { workspacePath, packageManager, scripts } = args.detected;
    const testScript = pickScript(scripts, ['test', 'test:unit', 'test:ci']);
    const lintScript = pickScript(scripts, ['lint', 'lint:check', 'eslint']);
    const typecheckScript = pickScript(scripts, ['typecheck', 'type-check', 'tsc']);

    const test =
      values.runTest && testScript
        ? await runScript(workspacePath, packageManager, testScript)
        : skippedResult();
    const lint =
      values.runLint && lintScript
        ? await runScript(workspacePath, packageManager, lintScript)
        : skippedResult();
    const typecheck =
      values.runTypecheck && typecheckScript
        ? await runScript(workspacePath, packageManager, typecheckScript)
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
