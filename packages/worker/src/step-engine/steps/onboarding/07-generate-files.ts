import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';

interface AgentSpec {
  id: string;
  description: string;
  tools: string;
  body: string;
}

interface CommandSpec {
  id: string;
  title: string;
  description: string;
  body: string;
}

export interface GenerateFilesDetect {
  framework: string | null;
  language: string | null;
  projectName: string | null;
  acceptedAgentIds: string[];
  prefs: {
    verificationLevel?: string;
    autoCommit?: boolean;
    maxIterations?: number;
    customNotes?: string;
  };
  plannedAgents: string[];
  plannedCommands: string[];
  existingFiles: string[];
}

export interface GenerateFilesApply {
  wroteFiles: string[];
  skippedFiles: string[];
  agentCount: number;
  commandCount: number;
}

const BASELINE_AGENTS: AgentSpec[] = [
  {
    id: 'code-reviewer',
    description:
      'Reviews code changes for correctness, style, and maintainability before they land.',
    tools: 'Read, Grep, Glob, Bash',
    body: 'Review the diff provided. Check for correctness, unhandled errors, security issues, and adherence to project conventions documented in CLAUDE.md and AGENTS.md. Report findings grouped by severity (blocker, major, minor, nit). Do not write code; only review.',
  },
  {
    id: 'test-writer',
    description: 'Writes and maintains automated unit and integration tests for the project.',
    tools: 'Read, Edit, Write, Glob, Grep, Bash',
    body: 'Write new tests or update existing ones for the code under review. Follow the test framework and naming convention already used in the repository. Prefer integration tests that exercise real dependencies over mocks. Run the test command after writing to confirm they pass.',
  },
  {
    id: 'docs-writer',
    description: 'Curates project documentation under docs/ and inline code comments.',
    tools: 'Read, Edit, Write, Glob, Grep',
    body: 'Update project documentation to match the code. Keep documentation factual and grounded in the current repository state. Do not speculate about planned features. Use the existing docs tree layout and formatting conventions.',
  },
  {
    id: 'refactorer',
    description: 'Performs safe refactoring without changing behavior.',
    tools: 'Read, Edit, Grep, Glob, Bash',
    body: 'Refactor the code identified for cleanup while keeping observable behavior unchanged. Run tests before and after every change. Stop immediately if tests fail and report the last known-good state.',
  },
  {
    id: 'migration-author',
    description: 'Owns database migrations and schema evolution.',
    tools: 'Read, Edit, Write, Grep, Glob, Bash',
    body: 'Author new migrations or update existing ones. Preserve backwards compatibility during rollout. For destructive changes, add an explicit checklist and confirm with the caller before running.',
  },
  {
    id: 'api-route-dev',
    description: 'Owns HTTP handlers, route definitions, and API contracts.',
    tools: 'Read, Edit, Write, Grep, Glob, Bash',
    body: 'Implement or modify API routes. Keep request and response shapes documented. Validate inputs at the boundary. Emit structured errors matching the project error contract.',
  },
  {
    id: 'config-manager',
    description: 'Owns YAML and TOML configuration files and environment variable wiring.',
    tools: 'Read, Edit, Write, Grep, Glob',
    body: 'Maintain configuration files under config/ and .env examples. Never commit real secrets. Document every new key in the project README or the relevant docs file.',
  },
  {
    id: 'security-auditor',
    description: 'Scans for common security issues and advises on mitigations.',
    tools: 'Read, Grep, Glob, Bash',
    body: 'Audit the code for injection risks, unsafe deserialization, authentication flaws, secrets in source, and overly permissive defaults. Report findings with reproduction steps and recommended fixes.',
  },
  {
    id: 'knowledge-miner',
    description: 'Mines the codebase for patterns worth recording in the knowledge base.',
    tools: 'Read, Grep, Glob, Bash',
    body: 'Scan the repository for recurring patterns, domain vocabulary, and implicit conventions. Propose new knowledge-base entries under .claude/knowledge_base/ when the same concept appears in multiple unrelated files.',
  },
  {
    id: 'learning-recorder',
    description: 'Records lessons learned from completed workflow runs into the knowledge base.',
    tools: 'Read, Edit, Write, Grep, Glob',
    body: 'After a /workflow run completes, summarise what worked, what failed, and which assumptions proved wrong. Append the summary to .claude/knowledge_base/learnings.md without overwriting previous entries.',
  },
];

const FRAMEWORK_EXTRA_AGENTS: Record<string, AgentSpec[]> = {
  drupal7: [
    {
      id: 'drupal7-module-dev',
      description: 'Owns Drupal 7 .module and .install files and hook implementations.',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: 'Implement or modify Drupal 7 modules. Use hook_ implementations, the schema API, and the Form API correctly. Run drush cache-clear after schema changes.',
    },
  ],
  drupal: [
    {
      id: 'drupal-module-dev',
      description: 'Owns Drupal module developer concerns including hooks and services.',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: 'Implement or modify Drupal modules. Follow the services and plugins pattern. Run drush cr after container changes.',
    },
  ],
  nextjs: [
    {
      id: 'react-component-dev',
      description: 'Owns React components under src/components and app/.',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: 'Build or modify React components. Use server components by default. Opt into client components only when interactivity is required.',
    },
  ],
  nodejs: [
    {
      id: 'node-package-dev',
      description: 'Owns Node.js package code under src/.',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: 'Maintain Node.js source files. Keep imports ESM, match the existing module layout, run the project test command after every edit.',
    },
  ],
  django: [
    {
      id: 'django-model-dev',
      description: 'Owns Django model files and their migrations.',
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: 'Maintain Django models, managers, and migrations. After any model change, run makemigrations and commit the resulting migration file alongside the model change.',
    },
  ],
};

const BASELINE_COMMANDS: CommandSpec[] = [
  {
    id: 'workflow',
    title: 'Workflow start',
    description: 'Start an autonomous implementation workflow for a task description.',
    body: [
      '# /workflow',
      '',
      'Start an autonomous implementation workflow for a task description provided after the command.',
      '',
      '## Phases',
      '',
      '1. Knowledge mining — review .claude/knowledge_base/ and prior workflow learnings for anything relevant.',
      '2. Spec — produce a written specification the user can review before any code changes.',
      '3. Gate 1 — wait for spec approval.',
      '4. Implement — make the code changes.',
      '5. Verify — run tests and static checks.',
      '6. Gate 2 — wait for verify approval.',
      '7. Gate 3 — commit.',
      '8. Learning — append lessons to .claude/knowledge_base/learnings.md.',
      '',
      'Each gate blocks further work until the user explicitly approves.',
      '',
    ].join('\n'),
  },
  {
    id: 'review',
    title: 'Review',
    description: 'Run the code-reviewer agent over the current working tree.',
    body: [
      '# /review',
      '',
      'Invoke the code-reviewer subagent with the current git diff. Report findings grouped by severity.',
      '',
      'Use this before opening a pull request.',
      '',
    ].join('\n'),
  },
  {
    id: 'learn',
    title: 'Learn',
    description: 'Record a lesson learned into the knowledge base.',
    body: [
      '# /learn',
      '',
      'Record a lesson learned from the current session into .claude/knowledge_base/learnings.md.',
      '',
      'Use the learning-recorder subagent to avoid overwriting prior entries. Pass a one-line summary plus optional detail.',
      '',
    ].join('\n'),
  },
];

function agentFileMarkdown(spec: AgentSpec, customNotes: string): string {
  const frontmatter = [
    '---',
    `name: ${spec.id}`,
    `description: ${spec.description}`,
    `tools: ${spec.tools}`,
    '---',
    '',
  ].join('\n');
  const body = [spec.body];
  if (customNotes.trim().length > 0) {
    body.push('');
    body.push('## Project notes');
    body.push('');
    body.push(customNotes.trim());
  }
  body.push('');
  return frontmatter + body.join('\n');
}

function commandFileMarkdown(cmd: CommandSpec): string {
  const frontmatter = ['---', `name: ${cmd.id}`, `description: ${cmd.description}`, '---', ''].join(
    '\n',
  );
  return frontmatter + cmd.body;
}

function claudeMdTemplate(
  projectName: string | null,
  framework: string | null,
  language: string | null,
  customNotes: string,
): string {
  const name = projectName ?? 'this project';
  const lines = [
    `# ${name}`,
    '',
    `Framework: ${framework ?? 'unknown'}`,
    `Primary language: ${language ?? 'unknown'}`,
    '',
    'This file configures Claude Code for this repository. See @AGENTS.md for the list of available subagents and their responsibilities.',
    '',
    '## How to work in this repo',
    '',
    '- Read .claude/knowledge_base/ before making non-trivial changes.',
    '- Use the workflow-config.json settings for verification level and auto-commit behaviour.',
    '- Delegate to the appropriate subagent listed in @AGENTS.md when a task falls clearly in their domain.',
    '',
  ];
  if (customNotes.trim().length > 0) {
    lines.push('## Project notes');
    lines.push('');
    lines.push(customNotes.trim());
    lines.push('');
  }
  return lines.join('\n');
}

function agentsMdTemplate(agents: AgentSpec[]): string {
  const lines = [
    '# Agents',
    '',
    'Subagents available in this repository. Delegate work to the agent whose description matches the task.',
    '',
  ];
  for (const a of agents) {
    lines.push(`## ${a.id}`);
    lines.push('');
    lines.push(a.description);
    lines.push('');
    lines.push(`Tools: ${a.tools}`);
    lines.push('');
  }
  return lines.join('\n');
}

function workflowConfigJson(prefs: GenerateFilesDetect['prefs'], framework: string | null): string {
  const config = {
    verificationLevel: prefs.verificationLevel ?? 'standard',
    autoCommit: prefs.autoCommit ?? false,
    maxIterations:
      typeof prefs.maxIterations === 'number' && prefs.maxIterations > 0 ? prefs.maxIterations : 5,
    framework: framework ?? null,
    customNotes: prefs.customNotes ?? '',
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function resolveAgents(framework: string | null, acceptedIds: string[]): AgentSpec[] {
  const out: AgentSpec[] = [...BASELINE_AGENTS];
  const seen = new Set(out.map((a) => a.id));
  if (framework && FRAMEWORK_EXTRA_AGENTS[framework]) {
    for (const extra of FRAMEWORK_EXTRA_AGENTS[framework]) {
      if (!seen.has(extra.id)) {
        out.push(extra);
        seen.add(extra.id);
      }
    }
  }
  for (const id of acceptedIds) {
    if (seen.has(id)) continue;
    out.push({
      id,
      description: `${id} agent accepted via agent discovery step.`,
      tools: 'Read, Edit, Write, Grep, Glob, Bash',
      body: `${id} agent. Fill in responsibilities and constraints for this role. This is a stub generated because the discovery pattern matched ${id} in the repository.`,
    });
    seen.add(id);
  }
  return out;
}

export const generateFilesStep: StepDefinition<GenerateFilesDetect, GenerateFilesApply> = {
  metadata: {
    id: '07-generate-files',
    workflowType: 'onboarding',
    index: 7,
    title: 'Generate workflow files',
    description:
      'Writes CLAUDE.md, AGENTS.md, the subagent files under .claude/agents/, the slash commands under .claude/commands/, and .claude/workflow-config.json. All content is template-driven; no CLI invocation required.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<GenerateFilesDetect> {
    const envPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const envData = (envPrev?.detect as DetectResult | null)?.data as
      | {
          project?: {
            framework?: string;
            primaryLanguage?: string;
            name?: string;
          };
        }
      | undefined;
    const framework = envData?.project?.framework ?? null;
    const language = envData?.project?.primaryLanguage ?? null;
    const projectName = envData?.project?.name ?? null;

    const prefsPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06-workflow-prefs');
    const prefs = ((prefsPrev?.output as { prefs?: Record<string, unknown> } | null)?.prefs ??
      {}) as GenerateFilesDetect['prefs'];

    const discoveryPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06_5-agent-discovery');
    const discoveryOutput = discoveryPrev?.output as { accepted?: { id: string }[] } | null;
    const acceptedAgentIds = (discoveryOutput?.accepted ?? []).map((a) => a.id);

    const agents = resolveAgents(framework, acceptedAgentIds);
    const plannedAgents = agents.map((a) => a.id);
    const plannedCommands = BASELINE_COMMANDS.map((c) => c.id);

    const candidates = [
      'CLAUDE.md',
      'AGENTS.md',
      '.claude/workflow-config.json',
      ...agents.map((a) => `.claude/agents/${a.id}.md`),
      ...BASELINE_COMMANDS.map((c) => `.claude/commands/${c.id}.md`),
    ];
    const existingFiles: string[] = [];
    for (const rel of candidates) {
      if (await pathExists(path.join(ctx.repoPath, rel))) existingFiles.push(rel);
    }

    ctx.logger.info(
      {
        framework,
        language,
        plannedAgents: plannedAgents.length,
        plannedCommands: plannedCommands.length,
        existingFiles: existingFiles.length,
      },
      'generate-files detect complete',
    );
    return {
      framework,
      language,
      projectName,
      acceptedAgentIds,
      prefs,
      plannedAgents,
      plannedCommands,
      existingFiles,
    };
  },

  form(_ctx, detected): FormSchema {
    const existingSummary =
      detected.existingFiles.length > 0
        ? ` ${detected.existingFiles.length} existing file(s) may be overwritten if you enable overwrite.`
        : '';
    return {
      title: 'Generate workflow files',
      description: `Plans to write ${detected.plannedAgents.length} agent file(s) and ${detected.plannedCommands.length} command file(s) plus CLAUDE.md, AGENTS.md, and .claude/workflow-config.json.${existingSummary}`,
      fields: [
        {
          type: 'checkbox',
          id: 'overwrite',
          label: 'Overwrite existing files',
          default: false,
        },
      ],
      submitLabel: 'Generate files',
    };
  },

  async apply(ctx, args): Promise<GenerateFilesApply> {
    const detected = args.detected as GenerateFilesDetect;
    const values = args.formValues as { overwrite?: boolean };
    const overwrite = values.overwrite === true;
    const customNotes =
      typeof detected.prefs.customNotes === 'string' ? detected.prefs.customNotes : '';
    const agents = resolveAgents(detected.framework, detected.acceptedAgentIds);

    const wroteFiles: string[] = [];
    const skippedFiles: string[] = [];

    const writeIfAllowed = async (rel: string, contents: string): Promise<void> => {
      const full = path.join(ctx.repoPath, rel);
      const exists = await pathExists(full);
      if (exists && !overwrite) {
        skippedFiles.push(rel);
        return;
      }
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents, 'utf8');
      wroteFiles.push(rel);
    };

    await writeIfAllowed(
      'CLAUDE.md',
      claudeMdTemplate(detected.projectName, detected.framework, detected.language, customNotes),
    );
    await writeIfAllowed('AGENTS.md', agentsMdTemplate(agents));
    await writeIfAllowed(
      '.claude/workflow-config.json',
      workflowConfigJson(detected.prefs, detected.framework),
    );

    for (const agent of agents) {
      await writeIfAllowed(`.claude/agents/${agent.id}.md`, agentFileMarkdown(agent, customNotes));
    }
    for (const cmd of BASELINE_COMMANDS) {
      await writeIfAllowed(`.claude/commands/${cmd.id}.md`, commandFileMarkdown(cmd));
    }

    ctx.logger.info(
      {
        wrote: wroteFiles.length,
        skipped: skippedFiles.length,
        agents: agents.length,
        commands: BASELINE_COMMANDS.length,
      },
      'generate-files apply complete',
    );
    return {
      wroteFiles,
      skippedFiles,
      agentCount: agents.length,
      commandCount: BASELINE_COMMANDS.length,
    };
  },
};
