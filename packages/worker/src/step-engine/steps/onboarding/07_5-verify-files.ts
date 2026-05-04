import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { CliProviderName } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, pathExists } from './_helpers.js';

interface ActiveAgentsTarget {
  dir: string;
  ext: '.md' | '.toml';
}

async function resolveActiveAgentsTarget(ctx: StepContext): Promise<ActiveAgentsTarget | null> {
  const defaultTarget: ActiveAgentsTarget = { dir: '.claude/agents', ext: '.md' };
  if (!ctx.cliProviderId) return defaultTarget;
  const row = await ctx.db.query.cliProviders.findFirst({
    where: eq(schema.cliProviders.id, ctx.cliProviderId),
    columns: { name: true },
  });
  if (!row) return defaultTarget;
  const meta = getCliProviderMetadata(row.name as CliProviderName);
  if (!meta.projectAgentsDir || !meta.agentFileFormat) return null;
  return {
    dir: meta.projectAgentsDir,
    ext: meta.agentFileFormat === 'toml' ? '.toml' : '.md',
  };
}

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
      'Checks that the generated agents, skills, commands, knowledge base files and workflow config exist with the minimum required counts.',
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

    const skillsCount = await countMatching(repo, '.claude/skills/', 'SKILL.md');
    checks.push({
      id: 'skills_dir',
      label: '.claude/skills has at least 1 SKILL.md',
      passed: skillsCount >= 1,
      detail: `found ${skillsCount}`,
    });

    const kbCount = await countMatching(repo, '.claude/knowledge_base/', '.md');
    checks.push({
      id: 'knowledge_base_dir',
      label: '.claude/knowledge_base has at least 3 markdown files',
      passed: kbCount >= 3,
      detail: `found ${kbCount}`,
    });

    const workflowConfigPath = path.join(repo, '.claude', 'workflow-config.json');
    const workflowConfigOk = await pathExists(workflowConfigPath);
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
