import { hasWorkspaceEntry } from '../../workspace-probe.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching } from './_helpers.js';
import { resolveActiveAgentsTarget } from './_active-agents-target.js';

interface FileCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

interface VerifyDetect {
  checks: FileCheck[];
  passedCount: number;
  failedCount: number;
}

async function countMatching(
  root: string,
  prefix: string,
  suffix: string,
  exclude?: string,
): Promise<number> {
  const files = await listFilesMatching(
    root,
    (rel, isDir) => {
      if (isDir) return false;
      if (exclude && rel.includes(exclude)) return false;
      return rel.startsWith(prefix) && rel.endsWith(suffix);
    },
    5,
  );
  return files.length;
}

export const verifyFilesStep: StepDefinition<
  VerifyDetect,
  { passed: boolean; checks: FileCheck[] }
> = {
  metadata: {
    id: '07_5-verify-files',
    workflowType: 'onboarding',
    index: 8,
    title: 'Verify generated files',
    description:
      'Checks that generated agents meet the minimum count and workflow config exists. Skills and knowledge base files are verified after their later generation steps.',
    requiresCli: false,
    providerSensitive: true,
  },

  async detect(ctx: StepContext): Promise<VerifyDetect> {
    const repo = ctx.repoPath;
    const checks: FileCheck[] = [];

    const agentsTarget = await resolveActiveAgentsTarget(ctx);
    if (agentsTarget === null) {
      checks.push({
        id: 'agents_dir',
        label: 'active CLI has no custom-agent directory',
        passed: true,
        detail: 'not applicable (amp has no file-based agents)',
      });
    } else {
      const agentsPrefix = agentsTarget.dir.endsWith('/')
        ? agentsTarget.dir
        : `${agentsTarget.dir}/`;
      const agentsCount = await countMatching(repo, agentsPrefix, agentsTarget.ext);
      const formatLabel = agentsTarget.ext === '.toml' ? 'TOML' : 'markdown';
      checks.push({
        id: 'agents_dir',
        label: `${agentsTarget.dir} has at least 10 ${formatLabel} files`,
        passed: agentsCount >= 10,
        detail: `found ${agentsCount}`,
      });
    }

    const workflowConfigOk = await hasWorkspaceEntry(repo, '.claude/workflow-config.json');
    checks.push({
      id: 'workflow_config',
      label: '.claude/workflow-config.json exists',
      passed: workflowConfigOk,
      detail: workflowConfigOk ? 'ok' : 'missing',
    });

    const passedCount = checks.filter((c) => c.passed).length;
    return { checks, passedCount, failedCount: checks.length - passedCount };
  },

  async apply(ctx, args) {
    const passed = args.detected.failedCount === 0;
    ctx.logger.info(
      { passed, passedCount: args.detected.passedCount, failedCount: args.detected.failedCount },
      'verify-files complete',
    );
    return { passed, checks: args.detected.checks };
  },
};
