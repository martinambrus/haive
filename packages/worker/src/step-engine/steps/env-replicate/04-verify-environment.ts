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
}

interface DeclaredDepsShape {
  runtimes?: string[];
  lspServers?: string[];
  database?: { kind?: string };
}

export function buildSmokeChecks(deps: DeclaredDepsShape): SmokeCheck[] {
  const checks: SmokeCheck[] = [];
  const runtimes = deps.runtimes ?? [];
  if (runtimes.includes('node')) {
    checks.push({ id: 'node', label: 'Node.js', cmd: ['node', '--version'] });
  }
  if (runtimes.includes('php')) {
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

  const lsp = deps.lspServers ?? [];
  if (lsp.includes('intelephense') || lsp.includes('intelephense-extended')) {
    checks.push({
      id: 'lsp-intelephense',
      label: 'intelephense',
      cmd: ['intelephense', '--version'],
    });
  }
  if (lsp.includes('pyright')) {
    checks.push({
      id: 'lsp-pyright',
      label: 'pyright',
      cmd: ['pyright', '--version'],
    });
  }
  if (lsp.includes('gopls')) {
    checks.push({ id: 'lsp-gopls', label: 'gopls', cmd: ['gopls', 'version'] });
  }
  if (lsp.includes('rust-analyzer')) {
    checks.push({
      id: 'lsp-rust-analyzer',
      label: 'rust-analyzer',
      cmd: ['rust-analyzer', '--version'],
    });
  }

  const dbKind = deps.database?.kind;
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
      const selected = Array.isArray(raw) ? (raw as string[]) : [];
      const selectedSet = new Set(selected);
      const reports: VerifyEnvironmentReport[] = [];

      for (const check of args.detected.checks) {
        if (!selectedSet.has(check.id)) continue;
        const result = await runner.run({
          image: args.detected.imageRef,
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
