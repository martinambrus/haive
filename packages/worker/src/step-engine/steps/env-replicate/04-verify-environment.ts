import {
  loadComposedLspIdentity,
  retainComposedImage,
  type ComposedLspEvidence,
  type ComposedLspReport,
} from '../../../lsp/composed-evidence.js';
import { probeComposedServer } from '../../../lsp/composed-probe.js';
import { withEnsuredComposedImage } from '../../../sandbox/composed-image-cache.js';
import {
  assertEnvironmentLspInstallContract,
  type LspInstallContract,
} from '../../../sandbox/lsp-install-contract.js';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import { defaultDockerRunner, type DockerRunner } from '../../../sandbox/docker-runner.js';
import { getTaskEnvTemplate } from './_shared.js';

export interface SmokeCheck {
  id: string;
  label: string;
  cmd: string[];
}

export interface VerifyEnvironmentDetect {
  envTemplateId: string;
  imageRef: string;
  checks: SmokeCheck[];
  installContract?: 2;
  providerId?: string;
}

export interface VerifyEnvironmentReport {
  id: string;
  label: string;
  cmd: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
  error?: string;
}

export interface VerifyEnvironmentApply {
  envTemplateId: string;
  passed: number;
  failed: number;
  reports: VerifyEnvironmentReport[];
  environmentReports?: VerifyEnvironmentReport[];
  composedLsp?: ComposedLspEvidence;
}

interface DeclaredDepsShape extends LspInstallContract {
  runtimes?: string[];
  lspServers?: string[];
  database?: { kind?: string };
  containerTool?: string;
}

export function buildSmokeChecks(deps: DeclaredDepsShape): SmokeCheck[] {
  if (deps.lspInstallContractVersion !== 2) assertEnvironmentLspInstallContract(deps);
  const checks: SmokeCheck[] = [];
  const runtimes = deps.runtimes ?? [];
  if (runtimes.includes('node')) {
    checks.push({ id: 'node', label: 'Node.js', cmd: ['node', '--version'] });
  }
  // For DDEV projects php (and the DB below) live in DDEV, not the CLI sandbox —
  // they were deliberately excluded from the image, so don't smoke-check them
  // here (they'd fail). 04 only verifies what's actually in the sandbox.
  if (runtimes.includes('php') && deps.containerTool !== 'ddev') {
    checks.push({ id: 'php', label: 'PHP', cmd: ['php', '--version'] });
  }
  if (runtimes.includes('python')) {
    checks.push({
      id: 'python',
      label: 'Python',
      cmd: ['python3', '--version'],
    });
  }
  if (runtimes.includes('go')) {
    checks.push({ id: 'go', label: 'Go', cmd: ['go', 'version'] });
  }
  if (runtimes.includes('rust')) {
    checks.push({ id: 'rust', label: 'Rust', cmd: ['rustc', '--version'] });
  }
  if (runtimes.includes('ruby')) {
    checks.push({ id: 'ruby', label: 'Ruby', cmd: ['ruby', '--version'] });
  }
  if (runtimes.includes('java')) {
    checks.push({ id: 'java', label: 'Java', cmd: ['java', '--version'] });
  }

  const lsp = new Set(deps.lspInstallContractVersion === 2 ? [] : (deps.lspServers ?? []));
  const lspChecks: Array<{
    keys: string[];
    id: string;
    label: string;
    executable: string;
  }> = [
    {
      keys: ['intelephense', 'intelephense-extended'],
      id: 'lsp-intelephense',
      label: 'intelephense',
      executable: 'intelephense',
    },
    { keys: ['vtsls'], id: 'lsp-vtsls', label: 'vtsls', executable: 'vtsls' },
    {
      keys: ['pyright'],
      id: 'lsp-pyright',
      label: 'pyright language server',
      executable: 'pyright-langserver',
    },
    { keys: ['gopls'], id: 'lsp-gopls', label: 'gopls', executable: 'gopls' },
    {
      keys: ['rust-analyzer'],
      id: 'lsp-rust-analyzer',
      label: 'rust-analyzer',
      executable: 'rust-analyzer',
    },
    {
      keys: ['solargraph'],
      id: 'lsp-solargraph',
      label: 'solargraph',
      executable: 'solargraph',
    },
    { keys: ['jdtls'], id: 'lsp-jdtls', label: 'jdtls', executable: 'jdtls' },
  ];
  for (const check of lspChecks) {
    if (!check.keys.some((key) => lsp.has(key))) continue;
    // LSP executables speak JSON-RPC on stdio; treating `--version` as a
    // universal flag can start the server or dump its bundled source (notably
    // Intelephense). Verify the actual launcher exists without invoking it.
    checks.push({
      id: check.id,
      label: check.label,
      cmd: ['sh', '-c', `command -v ${check.executable}`],
    });
  }

  const dbKind = deps.containerTool === 'ddev' ? undefined : deps.database?.kind;
  if (dbKind === 'postgres') {
    checks.push({
      id: 'db-postgres',
      label: 'psql client',
      cmd: ['psql', '--version'],
    });
  }
  if (dbKind === 'mariadb' || dbKind === 'mysql') {
    checks.push({
      id: 'db-mysql',
      label: 'mysql client',
      cmd: ['mysql', '--version'],
    });
  }

  checks.push({
    id: 'bash',
    label: 'Shell',
    cmd: ['bash', '-c', 'echo ok'],
  });

  return checks;
}

export function createVerifyEnvironmentStep(
  runner: DockerRunner,
): StepDefinition<VerifyEnvironmentDetect, VerifyEnvironmentApply> {
  return {
    metadata: {
      id: '04-verify-environment',
      workflowType: 'env_replicate',
      index: 4,
      title: 'Verify environment',
      description:
        'Runs smoke checks against the built image to confirm runtimes, language servers and clients are installed.',
      requiresCli: false,
      // Under Auto-continue, run the smoke checks unattended with every relevant
      // check ticked (the form defaults to all of them). Verifying the sandbox is
      // almost never something a user wants to do by hand or skip.
      autoSubmitDefaults: true,
    },

    async detect(ctx) {
      const row = await getTaskEnvTemplate(ctx.db, ctx.taskId);
      if (!row) {
        throw new Error(`env template for task ${ctx.taskId} not found`);
      }
      if (row.status !== 'ready' || !row.imageTag) {
        throw new Error('image not built yet; run step 03 first');
      }
      const deps = (row.declaredDeps ?? {}) as DeclaredDepsShape;
      return {
        envTemplateId: row.id,
        imageRef: row.imageTag,
        checks: buildSmokeChecks(deps),
        ...(deps.lspInstallContractVersion === 2
          ? { installContract: 2 as const, providerId: ctx.cliProviderId ?? undefined }
          : {}),
      };
    },

    form(_ctx, detected): FormSchema {
      return {
        title: 'Smoke checks',
        description: `Select the checks to run against ${detected.imageRef}.`,
        fields: [
          {
            type: 'multi-select',
            id: 'selectedChecks',
            label: 'Checks',
            required: true,
            options: detected.checks.map((c) => ({
              value: c.id,
              label: `${c.label} (${c.cmd.join(' ')})`,
            })),
            defaults: detected.checks.map((c) => c.id),
          },
        ],
        submitLabel: 'Run smoke checks',
      };
    },

    async apply(ctx, args) {
      const raw = args.formValues.selectedChecks;
      const composed = args.detected.installContract === 2;
      const step = composed
        ? await ctx.db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, ctx.taskStepId) })
        : null;
      const task = composed
        ? await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) })
        : null;
      const environmentImage = composed ? await runner.inspect(args.detected.imageRef) : null;
      if (composed && (!environmentImage?.exists || !environmentImage.imageId))
        throw new Error('Environment image disappeared; Retry 03');
      const selected = Array.isArray(raw) ? (raw as string[]) : [];
      const selectedSet = new Set(selected);
      const reports: VerifyEnvironmentReport[] = [];

      for (const check of args.detected.checks) {
        if (!selectedSet.has(check.id)) {
          if (composed)
            reports.push({
              ...check,
              exitCode: null,
              stdout: '',
              stderr: '',
              durationMs: 0,
              passed: false,
              error: 'Check was not selected',
            });
          continue;
        }
        const result = await runner.run({
          image: composed ? environmentImage!.imageId! : args.detected.imageRef,
          cmd: check.cmd,
          signal: ctx.signal,
        });
        const passed = result.exitCode === 0;
        reports.push({
          id: check.id,
          label: check.label,
          cmd: check.cmd,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
          durationMs: result.durationMs,
          passed,
          error: result.error,
        });
        ctx.logger.info(
          { checkId: check.id, passed, exitCode: result.exitCode },
          'smoke check complete',
        );
      }

      if (composed) {
        if (!args.detected.providerId || !step || !task)
          throw new Error('Composed verification needs the current provider and owned step');
        const provider = await ctx.db.query.cliProviders.findFirst({
          where: eq(schema.cliProviders.id, args.detected.providerId),
        });
        if (!provider || provider.id !== ctx.cliProviderId)
          throw new Error('Composed verification provider changed; Retry 04');
        const fence = {
          stepId: ctx.taskStepId,
          generation: ctx.rerunGeneration ?? step.rerunGeneration,
          epoch: ctx.epoch ?? task.orchestrationEpoch,
        };
        const evidence = await withEnsuredComposedImage(
          ctx.db,
          ctx.taskId,
          provider,
          async (composition) => {
            const identity = await loadComposedLspIdentity(
              ctx.db,
              ctx.taskId,
              provider.id,
              runner,
              composition.inputs,
            );
            if (
              !identity ||
              identity.envTemplateId !== args.detected.envTemplateId ||
              identity.environmentImageId !== environmentImage?.imageId ||
              identity.tag !== composition.tag
            )
              throw new Error('Composed verification inputs changed; Retry 04');
            await retainComposedImage(ctx.db, ctx.taskId, identity, false, fence, runner);
            const lspReports: ComposedLspReport[] = [];
            for (const selected of identity.selection)
              lspReports.push(
                await probeComposedServer(runner, identity.imageId, selected.server, ctx.signal),
              );
            const verified =
              reports.length === args.detected.checks.length &&
              reports.every((r) => r.passed) &&
              lspReports.length === identity.selection.length &&
              lspReports.every((r) => r.passed && !r.skipped);
            // Build/probe failures never replace effective/prior references. A pending
            // verification reference also survives a crash or a reset of this output.
            if (verified)
              await retainComposedImage(ctx.db, ctx.taskId, identity, true, fence, runner);
            return {
              schemaVersion: 1 as const,
              entries: [
                {
                  identity,
                  outcome: verified ? ('verified' as const) : ('failed' as const),
                  reports: lspReports,
                },
              ],
            };
          },
          runner,
        );
        if (!evidence) throw new Error('No composed environment decision for verification');
        const all = [...reports, ...evidence.entries.flatMap((e) => e.reports)];
        return {
          envTemplateId: args.detected.envTemplateId,
          passed: all.filter((r) => r.passed).length,
          failed: all.filter((r) => !r.passed).length,
          reports: [],
          environmentReports: reports,
          composedLsp: evidence,
        };
      }
      const passed = reports.filter((r) => r.passed).length;
      const failed = reports.length - passed;
      if (failed === 0 && reports.length > 0) {
        await ctx.db
          .update(schema.envTemplates)
          .set({ status: 'ready', updatedAt: new Date() })
          .where(eq(schema.envTemplates.id, args.detected.envTemplateId));
      }
      return {
        envTemplateId: args.detected.envTemplateId,
        passed,
        failed,
        reports,
      };
    },
  };
}

export const verifyEnvironmentStep = createVerifyEnvironmentStep(defaultDockerRunner);
