import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  type AgentSpec,
  BASELINE_AGENT_SPECS,
  buildAgentFileMarkdown,
  FRAMEWORK_AGENT_SPECS,
  stubCustomAgent,
} from './_agent-templates.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';

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
  customAgentSpecs: AgentSpec[];
  lspLanguages: string[];
  mcpSettingsJson: string;
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

function commandFileMarkdown(cmd: CommandSpec): string {
  const frontmatter = ['---', `name: ${cmd.id}`, `description: ${cmd.description}`, '---', ''].join(
    '\n',
  );
  return frontmatter + cmd.body;
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

/* ------------------------------------------------------------------ */
/* drupal-php-lsp Claude Code plugin generation                       */
/* ------------------------------------------------------------------ */

const DRUPAL_LSP_MARKETPLACE = JSON.stringify(
  {
    name: 'drupal-lsp-marketplace',
    description: 'Local marketplace for Drupal PHP LSP plugin',
    owner: { name: 'haive' },
    plugins: [
      {
        name: 'drupal-php-lsp',
        source: './.claude-plugin/drupal-php-lsp',
        description: 'PHP LSP with CMS extensions (Intelephense)',
        version: '1.0.0',
      },
    ],
  },
  null,
  2,
);

const DRUPAL_LSP_PLUGIN = JSON.stringify(
  {
    name: 'drupal-php-lsp',
    version: '1.0.0',
    description: 'PHP LSP with CMS extensions (Intelephense)',
    author: { name: 'haive' },
  },
  null,
  2,
);

const DRUPAL_LSP_CONFIG = JSON.stringify(
  {
    php: {
      command: 'intelephense',
      args: ['--stdio'],
      extensionToLanguage: {
        '.php': 'php',
        '.inc': 'php',
        '.module': 'php',
        '.install': 'php',
        '.theme': 'php',
        '.profile': 'php',
      },
      transport: 'stdio',
      initializationOptions: {},
      settings: {},
      maxRestarts: 3,
    },
  },
  null,
  2,
);

const DRUPAL_LSP_FILES: { rel: string; content: string }[] = [
  {
    rel: '.claude/plugins/drupal-php-lsp/.claude-plugin/marketplace.json',
    content: DRUPAL_LSP_MARKETPLACE,
  },
  {
    rel: '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json',
    content: DRUPAL_LSP_PLUGIN,
  },
  {
    rel: '.claude/plugins/drupal-php-lsp/.claude-plugin/drupal-php-lsp/.lsp.json',
    content: DRUPAL_LSP_CONFIG,
  },
];

/** All known agent specs: baselines + framework extras. */
function allKnownAgents(framework: string | null): Map<string, AgentSpec> {
  const map = new Map<string, AgentSpec>();
  for (const a of BASELINE_AGENT_SPECS) map.set(a.id, a);
  if (framework && FRAMEWORK_AGENT_SPECS[framework]) {
    for (const a of FRAMEWORK_AGENT_SPECS[framework]!) map.set(a.id, a);
  }
  return map;
}

function resolveAgents(
  framework: string | null,
  acceptedIds: string[],
  customBodies: Map<string, AgentSpec>,
): AgentSpec[] {
  const known = allKnownAgents(framework);
  const out: AgentSpec[] = [];
  const seen = new Set<string>();
  for (const id of acceptedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const spec = known.get(id) ?? customBodies.get(id) ?? stubCustomAgent(id);
    out.push(spec);
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
      'Writes the subagent files under .claude/agents/, the slash commands under .claude/commands/, and .claude/workflow-config.json. All content is template-driven; no CLI invocation required.',
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

    const toolingPrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '04-tooling-infrastructure',
    );
    const toolingOutput = toolingPrev?.output as {
      tooling?: { lspLanguages?: unknown; mcpSettingsJson?: string };
    } | null;
    const lspLanguages = Array.isArray(toolingOutput?.tooling?.lspLanguages)
      ? (toolingOutput!.tooling!.lspLanguages as unknown[]).filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    const mcpSettingsJson =
      typeof toolingOutput?.tooling?.mcpSettingsJson === 'string'
        ? toolingOutput.tooling.mcpSettingsJson
        : '';

    const discoveryPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06_5-agent-discovery');
    const discoveryOutput = discoveryPrev?.output as {
      accepted?: { id: string; body?: AgentSpec }[];
    } | null;
    const acceptedList = discoveryOutput?.accepted ?? [];
    const acceptedAgentIds = acceptedList.map((a) => a.id);
    const customAgentSpecs: AgentSpec[] = acceptedList
      .filter((a): a is { id: string; body: AgentSpec } => !!a.body && typeof a.body === 'object')
      .map((a) => a.body);
    const customBodies = new Map(customAgentSpecs.map((s) => [s.id, s]));

    const agents = resolveAgents(framework, acceptedAgentIds, customBodies);
    const plannedAgents = agents.map((a) => a.id);
    const plannedCommands = BASELINE_COMMANDS.map((c) => c.id);

    const candidates = [
      '.claude/workflow-config.json',
      ...agents.map((a) => `.claude/agents/${a.id}.md`),
      ...BASELINE_COMMANDS.map((c) => `.claude/commands/${c.id}.md`),
      ...(lspLanguages.includes('php-extended') ? DRUPAL_LSP_FILES.map((f) => f.rel) : []),
      ...(mcpSettingsJson.trim().length > 0 ? ['.claude/mcp_settings.json'] : []),
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
      customAgentSpecs,
      lspLanguages,
      mcpSettingsJson,
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
      description: `Plans to write ${detected.plannedAgents.length} agent file(s) and ${detected.plannedCommands.length} command file(s) plus .claude/workflow-config.json.${existingSummary}`,
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
    const customBodies = new Map((detected.customAgentSpecs ?? []).map((s) => [s.id, s]));
    const agents = resolveAgents(detected.framework, detected.acceptedAgentIds, customBodies);

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
      '.claude/workflow-config.json',
      workflowConfigJson(detected.prefs, detected.framework),
    );

    for (const agent of agents) {
      await writeIfAllowed(
        `.claude/agents/${agent.id}.md`,
        buildAgentFileMarkdown(agent, customNotes),
      );
    }
    for (const cmd of BASELINE_COMMANDS) {
      await writeIfAllowed(`.claude/commands/${cmd.id}.md`, commandFileMarkdown(cmd));
    }

    if (detected.lspLanguages.includes('php-extended')) {
      for (const f of DRUPAL_LSP_FILES) {
        await writeIfAllowed(f.rel, f.content + '\n');
      }
    }

    const mcpContent = detected.mcpSettingsJson.trim();
    if (mcpContent.length > 0) {
      const suffix = detected.mcpSettingsJson.endsWith('\n') ? '' : '\n';
      await writeIfAllowed('.claude/mcp_settings.json', detected.mcpSettingsJson + suffix);
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
