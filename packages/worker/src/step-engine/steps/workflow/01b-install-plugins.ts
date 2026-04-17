import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { cliAdapterRegistry } from '../../../cli-adapters/registry.js';
import type { LspLanguage, PluginInstallCommand } from '../../../cli-adapters/types.js';
import { runInSandbox } from '../../../sandbox/sandbox-runner.js';
import type { DockerVolumeMount } from '../../../sandbox/docker-runner.js';
import {
  resolveAuthMounts,
  resolveSandboxImageTag,
  resolveTaskRepoMount,
  resolveTaskSandboxWorkdir,
} from '../../../queues/cli-exec-queue.js';

/** Per-CLI project-scope plugin directory for drupal-php-lsp. Must match the
 *  DRUPAL_LSP_TARGET_BASES in onboarding step 07. */
const DRUPAL_LSP_BASE_BY_PROVIDER: Record<string, string> = {
  'claude-code': '.claude/plugins/drupal-php-lsp',
  zai: '.claude/plugins/drupal-php-lsp',
  qwen: '.qwen/extensions/drupal-php-lsp',
};

interface InstallPluginsDetect {
  providerName: string | null;
  providerSupportsPlugins: boolean;
  lspLanguages: LspLanguage[];
  drupalLspPath: string | null;
  commands: PluginInstallCommand[];
  skip: boolean;
  skipReason: string | null;
}

interface InstallPluginsApply {
  skipped: boolean;
  skipReason: string | null;
  executed: { description: string; exitCode: number; stdoutTail: string; stderrTail: string }[];
}

function toLspLanguage(value: unknown): LspLanguage | null {
  const allowed: LspLanguage[] = ['typescript', 'python', 'go', 'rust', 'php', 'php-extended'];
  return allowed.includes(value as LspLanguage) ? (value as LspLanguage) : null;
}

export const installPluginsStep: StepDefinition<InstallPluginsDetect, InstallPluginsApply> = {
  metadata: {
    id: '01b-install-plugins',
    workflowType: 'workflow',
    index: 1.2,
    title: 'Install CLI plugins',
    description:
      'Installs CLI plugins (LSP marketplace + drupal-php-lsp) into the task sandbox. Runs once per task because CLI selection can change between tasks.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    if (!ctx.cliProviderId) return false;
    const provider = await ctx.db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, ctx.cliProviderId),
      columns: { name: true },
    });
    if (!provider) return false;
    if (!cliAdapterRegistry.has(provider.name)) return false;
    const adapter = cliAdapterRegistry.get(provider.name);
    return adapter.supportsPlugins && typeof adapter.buildPluginInstallCommands === 'function';
  },

  async detect(ctx: StepContext): Promise<InstallPluginsDetect> {
    if (!ctx.cliProviderId) {
      return {
        providerName: null,
        providerSupportsPlugins: false,
        lspLanguages: [],
        drupalLspPath: null,
        commands: [],
        skip: true,
        skipReason: 'No CLI provider selected for this task',
      };
    }
    const provider = await ctx.db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, ctx.cliProviderId),
    });
    if (!provider) {
      return {
        providerName: null,
        providerSupportsPlugins: false,
        lspLanguages: [],
        drupalLspPath: null,
        commands: [],
        skip: true,
        skipReason: `CLI provider ${ctx.cliProviderId} not found`,
      };
    }
    if (!cliAdapterRegistry.has(provider.name)) {
      return {
        providerName: provider.name,
        providerSupportsPlugins: false,
        lspLanguages: [],
        drupalLspPath: null,
        commands: [],
        skip: true,
        skipReason: `No adapter registered for ${provider.name}`,
      };
    }
    const adapter = cliAdapterRegistry.get(provider.name);
    if (!adapter.supportsPlugins || !adapter.buildPluginInstallCommands) {
      return {
        providerName: provider.name,
        providerSupportsPlugins: false,
        lspLanguages: [],
        drupalLspPath: null,
        commands: [],
        skip: true,
        skipReason: `${provider.name} does not support plugin install`,
      };
    }

    const toolingPrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '04-tooling-infrastructure',
    );
    const toolingOutput = toolingPrev?.output as {
      tooling?: { lspLanguages?: unknown };
    } | null;
    const rawLsp = Array.isArray(toolingOutput?.tooling?.lspLanguages)
      ? (toolingOutput!.tooling!.lspLanguages as unknown[])
      : [];
    const lspLanguages = rawLsp.map(toLspLanguage).filter((v): v is LspLanguage => v !== null);

    const sandboxWorkdir = await resolveTaskSandboxWorkdir(ctx.db, ctx.taskId);
    const drupalRelBase = DRUPAL_LSP_BASE_BY_PROVIDER[provider.name] ?? null;
    const drupalLspPath =
      lspLanguages.includes('php-extended') && drupalRelBase
        ? `${sandboxWorkdir}/${drupalRelBase}`
        : null;

    const pluginOpts: Parameters<NonNullable<typeof adapter.buildPluginInstallCommands>>[1] = {
      repoRoot: sandboxWorkdir,
      lspLanguages,
    };
    if (drupalLspPath) pluginOpts.drupalLspPath = drupalLspPath;

    const commands = adapter.buildPluginInstallCommands(provider, pluginOpts);

    const skip = commands.length === 0;
    return {
      providerName: provider.name,
      providerSupportsPlugins: true,
      lspLanguages,
      drupalLspPath,
      commands,
      skip,
      skipReason: skip ? 'No plugins to install' : null,
    };
  },

  form(_ctx, detected): FormSchema | null {
    if (detected.skip) return null;
    const summary = detected.commands.map((c) => `  - ${c.description}`).join('\n');
    return {
      title: 'Install CLI plugins',
      description: [
        `CLI: ${detected.providerName}`,
        detected.lspLanguages.length > 0
          ? `LSP languages: ${detected.lspLanguages.join(', ')}`
          : 'No LSP languages selected',
        detected.drupalLspPath ? `Drupal-LSP local marketplace: ${detected.drupalLspPath}` : null,
        '',
        `Will run ${detected.commands.length} command(s):`,
        summary,
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [],
      submitLabel: 'Install plugins',
    };
  },

  async apply(ctx, args): Promise<InstallPluginsApply> {
    const detected = args.detected;
    if (detected.skip) {
      return { skipped: true, skipReason: detected.skipReason, executed: [] };
    }
    if (!ctx.cliProviderId) {
      return {
        skipped: true,
        skipReason: 'No CLI provider selected',
        executed: [],
      };
    }

    const provider = await ctx.db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, ctx.cliProviderId),
    });
    if (!provider) {
      throw new Error(`CLI provider ${ctx.cliProviderId} not found`);
    }
    const adapter = cliAdapterRegistry.get(provider.name);

    const sandboxImage = await resolveSandboxImageTag(ctx.db, ctx.taskId, provider);
    const sandboxWorkdir = await resolveTaskSandboxWorkdir(ctx.db, ctx.taskId);
    const repoMount = await resolveTaskRepoMount(ctx.db, ctx.taskId);
    const authMounts = resolveAuthMounts(adapter, provider);
    const mounts: DockerVolumeMount[] = [...authMounts];
    if (repoMount) mounts.push(repoMount);

    const executed: InstallPluginsApply['executed'] = [];
    for (const cmd of detected.commands) {
      await ctx.emitProgress(cmd.description);
      ctx.logger.info(
        { command: cmd.command, args: cmd.args, description: cmd.description },
        'running plugin install command in sandbox',
      );
      const runnerOptions: Parameters<typeof runInSandbox>[1] = { workdir: sandboxWorkdir };
      if (sandboxImage) runnerOptions.image = sandboxImage;
      if (mounts.length > 0) runnerOptions.extraMounts = mounts;
      if (provider.networkPolicy) runnerOptions.networkPolicy = provider.networkPolicy;
      const wrapperContent = provider.wrapperContent ?? undefined;
      const runSpec: Parameters<typeof runInSandbox>[0] = {
        command: cmd.command,
        args: cmd.args,
        env: provider.envVars ?? {},
        timeoutMs: 180_000,
      };
      if (wrapperContent) runSpec.wrapperContent = wrapperContent;
      const result = await runInSandbox(runSpec, runnerOptions);

      const stdoutTail = result.stdout.slice(-1000);
      const stderrTail = result.stderr.slice(-1000);
      executed.push({
        description: cmd.description,
        exitCode: result.exitCode ?? -1,
        stdoutTail,
        stderrTail,
      });
      if (result.exitCode !== 0) {
        ctx.logger.warn(
          { command: cmd.command, exitCode: result.exitCode, stderrTail },
          'plugin install command failed',
        );
        throw new Error(
          `Plugin install failed (${cmd.description}): exit ${result.exitCode ?? 'unknown'}. ${stderrTail || stdoutTail || 'no output'}`,
        );
      }
    }

    return { skipped: false, skipReason: null, executed };
  },
};
