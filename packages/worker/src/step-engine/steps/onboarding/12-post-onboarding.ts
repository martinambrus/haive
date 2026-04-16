import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from './_helpers.js';

const exec = promisify(execFile);

const DEFAULT_COMMIT_MESSAGE = [
  'add: agentic workflow setup',
  '',
  'Generated workflow infrastructure including CLAUDE.md, AGENTS.md,',
  '.claude/ (agents, skills, knowledge base, commands, workflow steps,',
  'RAG scripts) and the updated .gitignore.',
].join('\n');

const STAGE_PATHS = [
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
  '.claude/commands/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/knowledge_base/',
  '.claude/workflow/',
  '.claude/rag/',
  '.claude/mcp_settings.json',
  '.claude/workflow-checkpoint.json',
  '.claude/project-config.yaml',
];

interface PostOnboardingDetect {
  hasOrchestrationFolder: boolean;
}

interface PostOnboardingOutput {
  cleanupPerformed: boolean;
  commitPerformed: boolean;
  commitSha: string | null;
  warnings: string[];
}

export const postOnboardingStep: StepDefinition<PostOnboardingDetect, PostOnboardingOutput> = {
  metadata: {
    id: '12-post-onboarding',
    workflowType: 'onboarding',
    index: 16,
    title: 'Post-onboarding cleanup and commit',
    description:
      'Optionally removes leftover orchestration scaffolding and commits the generated workflow files.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<PostOnboardingDetect> {
    const orch = path.join(ctx.repoPath, 'orchestration');
    return { hasOrchestrationFolder: await pathExists(orch) };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Post-onboarding actions',
      description: detected.hasOrchestrationFolder
        ? 'The legacy orchestration/ folder is still present. You can delete it now and optionally commit the generated workflow files in one step.'
        : 'You can commit the generated workflow files now or skip and commit later.',
      fields: [
        {
          type: 'checkbox',
          id: 'cleanup',
          label: 'Delete orchestration/ folder if present',
          default: detected.hasOrchestrationFolder,
        },
        {
          type: 'checkbox',
          id: 'commit',
          label: 'Stage and commit generated workflow files',
          default: false,
        },
        {
          type: 'textarea',
          id: 'commitMessage',
          label: 'Commit message',
          default: DEFAULT_COMMIT_MESSAGE,
          rows: 6,
        },
      ],
      submitLabel: 'Finish onboarding',
    };
  },

  async apply(ctx, args): Promise<PostOnboardingOutput> {
    const values = args.formValues;
    const warnings: string[] = [];
    let cleanupPerformed = false;
    let commitPerformed = false;
    let commitSha: string | null = null;

    if (values.cleanup === true && args.detected.hasOrchestrationFolder) {
      await rm(path.join(ctx.repoPath, 'orchestration'), { recursive: true, force: true });
      cleanupPerformed = true;
    }

    if (values.commit === true) {
      try {
        await exec('git', ['add', '--', ...STAGE_PATHS], { cwd: ctx.repoPath });
        const message =
          typeof values.commitMessage === 'string' && values.commitMessage.trim().length > 0
            ? values.commitMessage
            : DEFAULT_COMMIT_MESSAGE;
        await exec('git', ['commit', '-m', message], { cwd: ctx.repoPath });
        const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: ctx.repoPath });
        commitSha = stdout.trim();
        commitPerformed = true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`commit failed: ${message}`);
        ctx.logger.warn({ err }, 'post-onboarding commit failed');
      }
    }

    ctx.logger.info(
      { cleanupPerformed, commitPerformed, commitSha, warnings },
      'post-onboarding apply complete',
    );
    return { cleanupPerformed, commitPerformed, commitSha, warnings };
  },
};
