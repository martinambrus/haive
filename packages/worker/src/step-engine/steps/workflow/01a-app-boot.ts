import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';

const exec = promisify(execFile);

type ContainerTool = 'ddev' | 'docker-compose' | 'none';

interface AppBootDetect {
  workspacePath: string;
  containerTool: ContainerTool;
  hasDevScript: boolean;
  devScriptName: string | null;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none';
  suggestedBootCommand: string;
  skip: boolean;
  skipReason: string | null;
}

interface AppBootApply {
  booted: boolean;
  skipped: boolean;
  bootCommand: string | null;
  appUrl: string | null;
  healthCheckPassed: boolean;
  output: string;
}

async function detectPackageManager(workspace: string): Promise<AppBootDetect['packageManager']> {
  if (await pathExists(path.join(workspace, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(workspace, 'bun.lockb'))) return 'bun';
  if (await pathExists(path.join(workspace, 'yarn.lock'))) return 'yarn';
  if (await pathExists(path.join(workspace, 'package-lock.json'))) return 'npm';
  return 'none';
}

async function readPackageScripts(workspace: string): Promise<Record<string, string>> {
  const pkgPath = path.join(workspace, 'package.json');
  if (!(await pathExists(pkgPath))) return {};
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.scripts && typeof parsed.scripts === 'object') {
      return parsed.scripts as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

function pickDevScript(scripts: Record<string, string>): string | null {
  const candidates = ['dev', 'start:dev', 'serve', 'start'];
  for (const name of candidates) {
    if (typeof scripts[name] === 'string' && scripts[name].length > 0) return name;
  }
  return null;
}

function buildSuggestedCommand(
  containerTool: ContainerTool,
  pm: AppBootDetect['packageManager'],
  devScript: string | null,
): string {
  switch (containerTool) {
    case 'ddev':
      return 'ddev start';
    case 'docker-compose':
      return 'docker compose up -d';
    case 'none':
      if (devScript && pm !== 'none') return `${pm} run ${devScript}`;
      return '';
  }
}

async function runCommand(
  cwd: string,
  command: string,
  timeoutMs = 120_000,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await exec('bash', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = `${stdout}${stderr}`.slice(0, 4000);
    return { exitCode: 0, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 4000);
    return { exitCode: e.code ?? 1, output };
  }
}

async function healthCheck(
  containerTool: ContainerTool,
  cwd: string,
): Promise<{ passed: boolean; url: string | null }> {
  switch (containerTool) {
    case 'ddev': {
      const result = await runCommand(cwd, 'ddev describe -j', 30_000);
      if (result.exitCode !== 0) return { passed: false, url: null };
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        const raw = parsed?.raw as Record<string, unknown> | undefined;
        const url = (raw?.primary_url as string) ?? null;
        return { passed: true, url };
      } catch {
        return { passed: true, url: null };
      }
    }
    case 'docker-compose': {
      const result = await runCommand(cwd, 'docker compose ps --format json', 15_000);
      return { passed: result.exitCode === 0, url: 'http://localhost' };
    }
    case 'none':
      return { passed: true, url: 'http://localhost:3000' };
  }
}

export const appBootStep: StepDefinition<AppBootDetect, AppBootApply> = {
  metadata: {
    id: '01a-app-boot',
    workflowType: 'workflow',
    index: 1.5,
    title: 'App boot',
    description: 'Starts the application services in the sandbox.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    if (!envTemplate || envTemplate.status !== 'ready') return false;
    const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
    if (!deps) return false;
    const containerTool = (deps.containerTool as string) ?? 'none';
    if (containerTool !== 'none') return true;
    const scripts = await readPackageScripts(ctx.workspacePath);
    return pickDevScript(scripts) !== null;
  },

  async detect(ctx: StepContext): Promise<AppBootDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    const workspace = worktreeOutput?.worktreePath ?? ctx.workspacePath;

    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
    const containerTool = (deps.containerTool as ContainerTool) ?? 'none';

    const scripts = await readPackageScripts(workspace);
    const devScript = pickDevScript(scripts);
    const pm = await detectPackageManager(workspace);
    const suggestedBootCommand = buildSuggestedCommand(containerTool, pm, devScript);

    const skip = !suggestedBootCommand;

    return {
      workspacePath: workspace,
      containerTool,
      hasDevScript: devScript !== null,
      devScriptName: devScript,
      packageManager: pm,
      suggestedBootCommand,
      skip,
      skipReason: skip ? 'No container tool or dev script detected' : null,
    };
  },

  form(_ctx, detected): FormSchema | null {
    if (detected.skip) return null;

    return {
      title: 'App boot',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Container tool: ${detected.containerTool}`,
        `Package manager: ${detected.packageManager}`,
        detected.hasDevScript ? `Dev script: ${detected.devScriptName}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          type: 'text',
          id: 'bootCommand',
          label: 'Boot command',
          default: detected.suggestedBootCommand,
        },
        {
          type: 'checkbox',
          id: 'runHealthCheck',
          label: 'Run health check after boot',
          default: true,
        },
      ],
      submitLabel: 'Boot application',
    };
  },

  async apply(ctx, args): Promise<AppBootApply> {
    const detected = args.detected;
    if (detected.skip) {
      return {
        booted: false,
        skipped: true,
        bootCommand: null,
        appUrl: null,
        healthCheckPassed: false,
        output: detected.skipReason ?? 'skipped',
      };
    }

    const values = args.formValues as {
      bootCommand?: string;
      runHealthCheck?: boolean;
    };
    const bootCommand = (values.bootCommand ?? detected.suggestedBootCommand).trim();
    if (!bootCommand) {
      return {
        booted: false,
        skipped: true,
        bootCommand: null,
        appUrl: null,
        healthCheckPassed: false,
        output: 'No boot command specified',
      };
    }

    ctx.logger.info({ bootCommand, workspace: detected.workspacePath }, 'booting application');

    const result = await runCommand(detected.workspacePath, bootCommand, 180_000);

    if (result.exitCode !== 0) {
      ctx.logger.warn({ bootCommand, exitCode: result.exitCode }, 'app boot command failed');
      return {
        booted: false,
        skipped: false,
        bootCommand,
        appUrl: null,
        healthCheckPassed: false,
        output: result.output,
      };
    }

    let appUrl: string | null = null;
    let healthCheckPassed = false;

    if (values.runHealthCheck !== false) {
      const hc = await healthCheck(detected.containerTool, detected.workspacePath);
      healthCheckPassed = hc.passed;
      appUrl = hc.url;
      ctx.logger.info({ healthCheckPassed, appUrl }, 'health check complete');
    }

    return {
      booted: true,
      skipped: false,
      bootCommand,
      appUrl,
      healthCheckPassed,
      output: result.output,
    };
  },
};
