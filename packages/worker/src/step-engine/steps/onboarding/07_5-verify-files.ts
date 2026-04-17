import path from 'node:path';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { listFilesMatching, pathExists } from './_helpers.js';

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
  },

  async detect(ctx: StepContext): Promise<VerifyDetect> {
    const repo = ctx.repoPath;
    const checks: FileCheck[] = [];

    const agentsCount = await countMatching(repo, '.claude/agents/', '.md');
    checks.push({
      id: 'agents_dir',
      label: '.claude/agents has at least 10 markdown files',
      passed: agentsCount >= 10,
      detail: `found ${agentsCount}`,
    });

    const skillsCount = await countMatching(repo, '.claude/skills/', 'SKILL.md');
    checks.push({
      id: 'skills_dir',
      label: '.claude/skills has at least 1 SKILL.md',
      passed: skillsCount >= 1,
      detail: `found ${skillsCount}`,
    });

    const commandsCount = await countMatching(repo, '.claude/commands/', '.md');
    checks.push({
      id: 'commands_dir',
      label: '.claude/commands has at least 3 markdown files',
      passed: commandsCount >= 3,
      detail: `found ${commandsCount}`,
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
