import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { extractFencedJson } from '../_fenced-json.js';
import {
  ensureAppRunnerStarted,
  appRunnerExec,
  type AppRunnerHandle,
} from '../../../sandbox/app-runner.js';

const exec = promisify(execFile);

type ContainerTool = 'ddev' | 'docker-compose' | 'none';
type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'none';

/** Framework entrypoints we can map to a deterministic run command without an
 *  LLM. Keyed off files present in the workspace. */
interface FrameworkFiles {
  artisan: boolean; // Laravel
  managePy: boolean; // Django
  rails: boolean; // Rails (bin/rails or config.ru)
  goMod: boolean; // Go
  phpPublicIndex: boolean; // plain PHP front controller
}

interface AppBootDetect {
  workspacePath: string;
  containerTool: ContainerTool;
  hasDevScript: boolean;
  devScriptName: string | null;
  packageManager: PackageManager;
  suggestedBootCommand: string;
  suggestedInstallCommand: string;
  suggestedPort: number;
  /** Run the app inside its per-task app-runner container (non-DDEV
   *  single-process path): requires a ready env image + a resolvable repo
   *  subpath. Gives port/network isolation per task. */
  containerized: boolean;
  envImageTag: string | null;
  repoSubpath: string | null;
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
  /** Set on the containerized path (non-DDEV app-runner). */
  containerized?: boolean;
  runtimeContainer?: string | null;
  port?: number | null;
}

interface RunRecipe {
  installCommand: string;
  runCommand: string;
  port: number;
}

async function detectPackageManager(workspace: string): Promise<PackageManager> {
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

async function detectFrameworkFiles(workspace: string): Promise<FrameworkFiles> {
  const [artisan, managePy, binRails, configRu, goMod, phpPublicIndex] = await Promise.all([
    pathExists(path.join(workspace, 'artisan')),
    pathExists(path.join(workspace, 'manage.py')),
    pathExists(path.join(workspace, 'bin', 'rails')),
    pathExists(path.join(workspace, 'config.ru')),
    pathExists(path.join(workspace, 'go.mod')),
    pathExists(path.join(workspace, 'public', 'index.php')),
  ]);
  return { artisan, managePy, rails: binRails || configRu, goMod, phpPublicIndex };
}

function buildSuggestedCommand(
  containerTool: ContainerTool,
  pm: PackageManager,
  devScript: string | null,
  fw: FrameworkFiles,
  port: number,
): string {
  switch (containerTool) {
    case 'ddev':
      return 'ddev start';
    case 'docker-compose':
      return 'docker compose up -d';
    case 'none':
      if (devScript && pm !== 'none') return `${pm} run ${devScript}`;
      // Deterministic framework fallbacks (bind 0.0.0.0 so the in-container
      // browser reaches it on localhost regardless of the framework default).
      if (fw.artisan) return `php artisan serve --host=0.0.0.0 --port=${port}`;
      if (fw.managePy) return `python3 manage.py runserver 0.0.0.0:${port}`;
      if (fw.rails) return `bundle exec rails server -b 0.0.0.0 -p ${port}`;
      if (fw.phpPublicIndex) return `php -S 0.0.0.0:${port} -t public`;
      if (fw.goMod) return 'go run .';
      return '';
  }
}

function buildInstallCommand(
  pm: PackageManager,
  fw: FrameworkFiles,
  hasPackageJson: boolean,
): string {
  if (hasPackageJson && pm !== 'none') return `${pm} install`;
  if (fw.artisan || fw.phpPublicIndex) return 'composer install';
  if (fw.managePy) return 'pip install --break-system-packages -r requirements.txt';
  if (fw.rails) return 'bundle install';
  if (fw.goMod) return 'go mod download';
  return '';
}

/** Best-effort port guess: an explicit flag in the dev script wins, else a
 *  framework default. Only a hint — the form lets the user correct it. */
function guessPort(
  containerTool: ContainerTool,
  devScript: string | null,
  scripts: Record<string, string>,
  fw: FrameworkFiles,
): number {
  if (containerTool === 'none' && devScript && scripts[devScript]) {
    const s = scripts[devScript];
    const m = s.match(/(?:--port[=\s]+|(?:^|\s)-p[=\s]+|PORT[=\s]+)(\d{2,5})/);
    if (m?.[1]) return Number(m[1]);
    if (/\bvite\b/.test(s)) return 5173;
    if (/\bnuxt\b/.test(s)) return 3000;
    if (/\bastro\b/.test(s)) return 4321;
  }
  if (fw.managePy || fw.artisan || fw.phpPublicIndex) return 8000;
  if (fw.rails) return 3000;
  if (fw.goMod) return 8080;
  return 3000;
}

async function runHostCommand(
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
    return { exitCode: 0, output: `${stdout}${stderr}`.slice(0, 4000) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { exitCode: e.code ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 4000) };
  }
}

/** Legacy host-side health check (docker-compose / non-containerized none). */
async function hostHealthCheck(
  containerTool: ContainerTool,
  cwd: string,
): Promise<{ passed: boolean; url: string | null }> {
  switch (containerTool) {
    case 'ddev': {
      const result = await runHostCommand(cwd, 'ddev describe -j', 30_000);
      if (result.exitCode !== 0) return { passed: false, url: null };
      try {
        const parsed = JSON.parse(result.output) as Record<string, unknown>;
        const raw = parsed?.raw as Record<string, unknown> | undefined;
        return { passed: true, url: (raw?.primary_url as string) ?? null };
      } catch {
        return { passed: true, url: null };
      }
    }
    case 'docker-compose': {
      const result = await runHostCommand(cwd, 'docker compose ps --format json', 15_000);
      return { passed: result.exitCode === 0, url: 'http://localhost' };
    }
    case 'none':
      return { passed: true, url: 'http://localhost:3000' };
  }
}

/** Poll the app's port from inside the runtime container until it answers. */
async function waitForPortInRunner(
  handle: AppRunnerHandle,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await appRunnerExec(
      handle,
      `curl -fsS -o /dev/null "http://localhost:${port}" && echo HAIVE_UP || true`,
      { timeoutMs: 10_000 },
    );
    if (r.output.includes('HAIVE_UP')) return true;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return false;
}

/** POSIX-safe single-quote: wraps a string for use as one shell word, so a
 *  user/LLM command with env prefixes or spaces survives interpolation intact. */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function parseRunRecipe(raw: unknown): RunRecipe | null {
  if (!raw) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const body = extractFencedJson(raw);
    if (!body) return null;
    try {
      obj = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const runCommand = typeof o.runCommand === 'string' ? o.runCommand.trim() : '';
  if (!runCommand) return null;
  const port = Number(o.port);
  return {
    installCommand: typeof o.installCommand === 'string' ? o.installCommand.trim() : '',
    runCommand,
    port: Number.isFinite(port) && port > 0 ? port : 3000,
  };
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
    // DDEV is owned by the dedicated nested-Docker env step (01c-ddev-env).
    if (containerTool === 'ddev') return false;
    if (containerTool !== 'none') return true;
    // none: run when the app is actually runnable — a dev script, a recognized
    // framework entrypoint, or (for a browser-testing project with a built env
    // image) so the LLM/form can determine how to run it in the app-runner. A
    // project with none of these has nothing to boot, so the step skips.
    const scripts = await readPackageScripts(ctx.workspacePath);
    if (pickDevScript(scripts) !== null) return true;
    const fw = await detectFrameworkFiles(ctx.workspacePath);
    if (fw.artisan || fw.managePy || fw.rails || fw.goMod || fw.phpPublicIndex) return true;
    return !!deps.browserTesting && !!envTemplate.imageTag;
  },

  async detect(ctx: StepContext): Promise<AppBootDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
    const workspace = worktreeOutput?.worktreePath ?? ctx.workspacePath;

    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
    const containerTool = (deps.containerTool as ContainerTool) ?? 'none';
    const envImageTag = envTemplate?.status === 'ready' ? (envTemplate.imageTag ?? null) : null;

    const scripts = await readPackageScripts(workspace);
    const devScript = pickDevScript(scripts);
    const pm = await detectPackageManager(workspace);
    const fw = await detectFrameworkFiles(workspace);
    const hasPackageJson = await pathExists(path.join(workspace, 'package.json'));
    const suggestedPort = guessPort(containerTool, devScript, scripts, fw);
    const suggestedBootCommand = buildSuggestedCommand(
      containerTool,
      pm,
      devScript,
      fw,
      suggestedPort,
    );
    const suggestedInstallCommand = buildInstallCommand(pm, fw, hasPackageJson);

    // Containerized path: a single-process (none) project with a ready env image
    // and a resolvable repo subpath runs inside its per-task app-runner.
    const ws =
      containerTool === 'none'
        ? await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath)
        : null;
    const repoSubpath = ws?.repoSubpath ?? null;
    const containerized = containerTool === 'none' && !!envImageTag && !!repoSubpath;

    const skip = containerized ? false : !suggestedBootCommand;

    return {
      workspacePath: workspace,
      containerTool,
      hasDevScript: devScript !== null,
      devScriptName: devScript,
      packageManager: pm,
      suggestedBootCommand,
      suggestedInstallCommand,
      suggestedPort,
      containerized,
      envImageTag,
      repoSubpath,
      skip,
      skipReason: skip ? 'No container tool or dev script detected' : null,
    };
  },

  // LLM "how to run" detection — only fires for a containerized project where no
  // deterministic run command was found (rare). Runs before the form so the form
  // can pre-fill the detected command/port. Skipped otherwise (the common path
  // stays LLM-free).
  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 5 * 60 * 1000,
    preForm: true,
    skipIf: ({ detected }) => {
      const d = detected as AppBootDetect;
      return !d.containerized || !!d.suggestedBootCommand;
    },
    buildPrompt: ({ detected }) => {
      const d = detected as AppBootDetect;
      return [
        'Determine how to RUN this application as a long-running development/web',
        'server inside a Linux container, so it can be browser-tested. Inspect the',
        'repository: package.json scripts, framework config, Procfile, Makefile, and',
        'language manifests.',
        '',
        `Detected package manager: ${d.packageManager}.`,
        '',
        'Emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "installCommand": "<deps install command, or empty>", "runCommand": "<command that STARTS the dev/web server and keeps running>", "port": <the port it listens on> }',
        '',
        'Rules: runCommand must launch a long-running server (NOT a build-and-exit',
        'command). Prefer binding 0.0.0.0 when the framework supports it. If you',
        'cannot determine a run command, set runCommand to an empty string.',
      ].join('\n');
    },
    bypassStub: ({ detected }) => {
      const d = detected as AppBootDetect;
      return {
        installCommand: d.suggestedInstallCommand,
        runCommand: d.suggestedBootCommand,
        port: d.suggestedPort,
      };
    },
  },

  form(_ctx, detected, llmOutput): FormSchema | null {
    if (detected.skip) return null;
    const recipe = parseRunRecipe(llmOutput);
    const bootDefault = recipe?.runCommand || detected.suggestedBootCommand;
    const installDefault = recipe?.installCommand || detected.suggestedInstallCommand;
    const portDefault = recipe?.port ?? detected.suggestedPort;

    const fields: FormSchema['fields'] = [
      {
        type: 'text',
        id: 'bootCommand',
        label: detected.containerized
          ? 'Run command (starts the app in its container)'
          : 'Boot command',
        default: bootDefault,
      },
    ];
    if (detected.containerized) {
      fields.push(
        {
          type: 'text',
          id: 'installCommand',
          label: 'Install dependencies command (run before the app starts; leave empty to skip)',
          default: installDefault,
        },
        {
          type: 'number',
          id: 'port',
          label: 'App port (inside the container)',
          default: portDefault,
        },
        {
          type: 'checkbox',
          id: 'keepRunning',
          label: 'Keep the app running for browser testing',
          default: true,
        },
      );
    } else {
      fields.push({
        type: 'checkbox',
        id: 'runHealthCheck',
        label: 'Run health check after boot',
        default: true,
      });
    }

    return {
      title: 'App boot',
      description: [
        `Workspace: ${detected.workspacePath}`,
        `Container tool: ${detected.containerTool}`,
        `Package manager: ${detected.packageManager}`,
        detected.hasDevScript ? `Dev script: ${detected.devScriptName}` : null,
        detected.containerized
          ? 'Runs in this task’s isolated app-runner container (built from your env image), so concurrent tasks on the same repo never collide on ports.'
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
      fields,
      submitLabel: detected.containerized ? 'Launch app in container' : 'Boot application',
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
      installCommand?: string;
      port?: number | string;
      keepRunning?: boolean;
      runHealthCheck?: boolean;
    };
    const recipe = parseRunRecipe(args.llmOutput);
    const bootCommand = (
      values.bootCommand ||
      recipe?.runCommand ||
      detected.suggestedBootCommand
    ).trim();
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

    // --- Containerized path: launch inside the per-task app-runner. ----------
    if (detected.containerized && detected.envImageTag && detected.repoSubpath) {
      const port = Number(values.port ?? recipe?.port ?? detected.suggestedPort) || 3000;
      const installCommand = (
        values.installCommand ??
        recipe?.installCommand ??
        detected.suggestedInstallCommand
      ).trim();
      const keepRunning = values.keepRunning !== false;
      const appUrl = `http://localhost:${port}`;

      // Don't start the runner when the user opted out of keeping the app up.
      if (!keepRunning) {
        return {
          booted: false,
          skipped: false,
          bootCommand,
          appUrl,
          healthCheckPassed: false,
          containerized: true,
          runtimeContainer: null,
          port,
          output: 'Run recipe recorded; app not launched (keep-running unchecked).',
        };
      }

      // The app-runner launch is best-effort, like the legacy host boot: a
      // failure records booted:false rather than failing the whole task.
      try {
        ctx.logger.info(
          { bootCommand, port, repoSubpath: detected.repoSubpath },
          'launching app in per-task app-runner',
        );
        await ctx.emitProgress('Starting the app-runner container…');
        const handle = await ensureAppRunnerStarted(
          ctx.taskId,
          detected.repoSubpath,
          detected.envImageTag,
        );

        let installOut = '';
        if (installCommand) {
          await ctx.emitProgress('Installing dependencies…');
          const ins = await appRunnerExec(handle, `cd ${handle.projectDir} && ${installCommand}`, {
            timeoutMs: 10 * 60 * 1000,
          });
          installOut = ins.output.slice(-1500);
          if (ins.exitCode !== 0) {
            ctx.logger.warn(
              { installCommand, exitCode: ins.exitCode },
              'dependency install failed',
            );
          }
        }

        await ctx.emitProgress('Launching the app…');
        // Background the server (nohup + disown) so it outlives this exec, and
        // run it through `bash -lc` so env-prefixed commands like
        // `PORT=3000 npm run dev` parse correctly — bare `nohup PORT=3000 …`
        // would try to exec the assignment token as a program.
        await appRunnerExec(
          handle,
          `cd ${handle.projectDir} && nohup bash -lc ${shSingleQuote(bootCommand)} > /tmp/haive-app.log 2>&1 & disown`,
          { timeoutMs: 30_000 },
        );
        await ctx.emitProgress('Waiting for the app to respond…');
        const healthy = await waitForPortInRunner(handle, port, 60_000);
        const tail = await appRunnerExec(
          handle,
          'tail -c 2000 /tmp/haive-app.log 2>/dev/null || true',
          { timeoutMs: 15_000 },
        );
        ctx.logger.info(
          { healthy, appUrl, container: handle.container },
          'app-runner launch complete',
        );

        return {
          booted: healthy,
          skipped: false,
          bootCommand,
          appUrl,
          healthCheckPassed: healthy,
          containerized: true,
          runtimeContainer: handle.container,
          port,
          output: [installOut && `install:\n${installOut}`, `app log:\n${tail.output.slice(-1500)}`]
            .filter(Boolean)
            .join('\n\n'),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ err: message }, 'app-runner launch failed');
        return {
          booted: false,
          skipped: false,
          bootCommand,
          appUrl,
          healthCheckPassed: false,
          containerized: true,
          runtimeContainer: null,
          port,
          output: `app-runner launch failed: ${message}`.slice(0, 2000),
        };
      }
    }

    // --- Legacy host path (docker-compose, or none without an env image). ----
    ctx.logger.info(
      { bootCommand, workspace: detected.workspacePath },
      'booting application (host)',
    );
    const result = await runHostCommand(detected.workspacePath, bootCommand, 180_000);
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
      const hc = await hostHealthCheck(detected.containerTool, detected.workspacePath);
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
