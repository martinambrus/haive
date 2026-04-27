import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, FormSchema } from '@haive/shared';
import { getCliProviderMetadata } from '@haive/shared';
import { cliAdapterRegistry } from '../../../cli-adapters/registry.js';
import type { CliProviderName } from '../../../cli-adapters/types.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  type AgentSpec,
  BASELINE_AGENT_SPECS,
  buildAgentFileMarkdown,
  buildAgentFileToml,
  FRAMEWORK_AGENT_SPECS,
  stubCustomAgent,
} from './_agent-templates.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';

export interface CommandSpec {
  id: string;
  title: string;
  description: string;
  body: string;
}

export interface ProjectInfo {
  name: string | null;
  framework: string | null;
  primaryLanguage: string | null;
  description: string | null;
  localUrl: string | null;
  databaseType: string | null;
  databaseVersion: string | null;
  webserver: string | null;
  docroot: string | null;
  runtimeVersions: Record<string, string>;
  testFrameworks: string[];
  testPaths: string[];
  buildTool: string | null;
  containerType: string | null;
}

export interface GenerateFilesDetect {
  framework: string | null;
  language: string | null;
  projectName: string | null;
  projectInfo: ProjectInfo;
  acceptedAgentIds: string[];
  customAgentSpecs: AgentSpec[];
  lspLanguages: string[];
  mcpSettingsJson: string;
  prefs: {
    verificationLevel?: string;
    autoCommit?: boolean;
    maxIterations?: number;
  };
  cliProviders: { name: CliProviderName; rulesContent: string }[];
  /** Per-enabled-CLI target for agent file writes. One entry per unique
   *  `projectAgentsDir` — claude-code and zai share `.claude/agents` so
   *  collapse to a single entry. Amp has no file-based agents so it is
   *  omitted. Empty when no enabled provider has a file-based agent
   *  directory (only Amp enabled) — apply() falls back to a single
   *  markdown write under `.claude/agents` so the user still gets files,
   *  and logs a warning. */
  agentTargets: { dir: string; format: 'markdown' | 'toml' }[];
  plannedAgents: string[];
  plannedCommands: string[];
  existingFiles: string[];
}

type EnvDetectShape = {
  project?: {
    name?: string;
    framework?: string;
    primaryLanguage?: string;
    description?: string | null;
  };
  container?: {
    type?: string;
    databaseType?: string | null;
    databaseVersion?: string | null;
    webserver?: string | null;
    docroot?: string | null;
    runtimeVersions?: Record<string, string>;
  };
  stack?: {
    database?: { type?: string | null; version?: string | null };
    runtimeVersions?: Record<string, string>;
  };
  paths?: { testPaths?: string[] };
  localUrl?: string | null;
  testFrameworks?: string[];
  buildTool?: string | null;
};

function pickString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractProjectInfo(
  envData: EnvDetectShape | null,
  confirmed: Record<string, unknown> | null,
): ProjectInfo {
  const c = confirmed ?? {};
  const base = envData ?? {};

  const testFwConfirmed = pickString(c.testFrameworks);
  const testFrameworks: string[] = testFwConfirmed
    ? testFwConfirmed
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : Array.isArray(base.testFrameworks)
      ? base.testFrameworks
      : [];

  return {
    name: pickString(c.projectName) ?? base.project?.name ?? null,
    framework: pickString(c.framework) ?? base.project?.framework ?? null,
    primaryLanguage: pickString(c.primaryLanguage) ?? base.project?.primaryLanguage ?? null,
    description: pickString(c.projectDescription) ?? base.project?.description ?? null,
    localUrl: pickString(c.localUrl) ?? base.localUrl ?? null,
    databaseType:
      pickString(c.databaseType) ??
      base.container?.databaseType ??
      base.stack?.database?.type ??
      null,
    databaseVersion:
      pickString(c.databaseVersion) ??
      base.container?.databaseVersion ??
      base.stack?.database?.version ??
      null,
    webserver: pickString(c.webserver) ?? base.container?.webserver ?? null,
    docroot: base.container?.docroot ?? null,
    runtimeVersions: base.stack?.runtimeVersions ?? base.container?.runtimeVersions ?? {},
    testFrameworks,
    testPaths: Array.isArray(base.paths?.testPaths) ? base.paths!.testPaths! : [],
    buildTool: pickString(c.buildTool) ?? base.buildTool ?? null,
    containerType: base.container?.type ?? null,
  };
}

export const PROJECT_INFO_START = '<!-- haive:project-info -->';
export const PROJECT_INFO_END = '<!-- /haive:project-info -->';
export const CLI_RULES_START = '<!-- haive:cli-rules -->';
export const CLI_RULES_END = '<!-- /haive:cli-rules -->';

export function projectInfoMarkdown(info: ProjectInfo): string {
  const lines: string[] = [
    PROJECT_INFO_START,
    '# Project',
    '',
    'Auto-generated by Haive onboarding. Content between the haive:project-info markers is rewritten on re-run when overwrite is enabled.',
    '',
  ];
  if (info.name) lines.push(`- **Name**: ${info.name}`);
  if (info.description) lines.push(`- **Description**: ${info.description}`);
  if (info.framework) lines.push(`- **Framework**: ${info.framework}`);
  if (info.primaryLanguage) lines.push(`- **Primary language**: ${info.primaryLanguage}`);
  if (info.containerType && info.containerType !== 'none') {
    lines.push(`- **Container**: ${info.containerType}`);
  }
  if (info.localUrl) lines.push(`- **Local URL**: ${info.localUrl}`);
  if (info.databaseType) {
    const dbVer = info.databaseVersion ? ` ${info.databaseVersion}` : '';
    lines.push(`- **Database**: ${info.databaseType}${dbVer}`);
  }
  if (info.webserver) lines.push(`- **Webserver**: ${info.webserver}`);
  if (info.docroot) lines.push(`- **Docroot**: ${info.docroot}`);
  const runtimes = Object.entries(info.runtimeVersions);
  if (runtimes.length > 0) {
    lines.push(`- **Runtimes**: ${runtimes.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  if (info.buildTool) lines.push(`- **Build tool**: ${info.buildTool}`);
  if (info.testFrameworks.length > 0) {
    lines.push(`- **Test frameworks**: ${info.testFrameworks.join(', ')}`);
  }
  if (info.testPaths.length > 0) {
    lines.push(`- **Test paths**: ${info.testPaths.join(', ')}`);
  }
  lines.push('');
  lines.push(PROJECT_INFO_END);
  lines.push('');
  return lines.join('\n');
}

export interface GenerateFilesApply {
  wroteFiles: string[];
  skippedFiles: string[];
  agentCount: number;
  commandCount: number;
}

export const BASELINE_COMMANDS: CommandSpec[] = [
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
  {
    id: 'sync-agents-md',
    title: 'Sync agents index',
    description:
      'Regenerate .claude/agents/README.md from the agent frontmatter in that directory.',
    body: [
      '# /sync-agents-md',
      '',
      'Rebuild `.claude/agents/README.md` so every `<agent>.md` file in that folder is listed in the index table with its name and description pulled from the YAML frontmatter.',
      '',
      '## Procedure',
      '',
      '1. List every `.md` file under `.claude/agents/` except `README.md`.',
      '2. Parse the YAML frontmatter from each file — read `name` and `description`.',
      '3. Write `.claude/agents/README.md` with a table `| Agent | Description |` sorted alphabetically by agent name.',
      '4. Keep the "Auto-generated" notice at the top so humans know not to hand-edit.',
      '',
      'This command is safe to re-run any time an agent file is added, removed, or its frontmatter changes.',
      '',
    ].join('\n'),
  },
];

export function commandFileMarkdown(cmd: CommandSpec): string {
  const frontmatter = ['---', `name: ${cmd.id}`, `description: ${cmd.description}`, '---', ''].join(
    '\n',
  );
  return frontmatter + cmd.body;
}

/** Table-style index listing every agent by `name` and `description`. Mirrors the
 *  original orchestration output so the `/sync-agents-md` command regenerates
 *  the same shape. `ext` is the agent file extension in this directory — `md`
 *  for claude/gemini/zai, `toml` for codex. Index itself is always markdown. */
export function agentsIndexMarkdown(agents: AgentSpec[], ext: 'md' | 'toml' = 'md'): string {
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
  const source = ext === 'toml' ? 'TOML top-level keys' : 'the YAML frontmatter';
  const lines: string[] = [
    '# Agents Index',
    '',
    'Auto-generated by Haive onboarding. Run the `/sync-agents-md` command to refresh this file after editing agent definitions.',
    '',
    `Each agent has its own file in this directory. Name and description are extracted from ${source}.`,
    '',
    '| Agent | Description |',
    '|-------|-------------|',
  ];
  for (const a of sorted) {
    const desc = a.description.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
    lines.push(`| [${a.id}](${a.id}.${ext}) | ${desc} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function workflowConfigJson(
  prefs: GenerateFilesDetect['prefs'],
  framework: string | null,
): string {
  const config = {
    verificationLevel: prefs.verificationLevel ?? 'standard',
    autoCommit: prefs.autoCommit ?? false,
    maxIterations:
      typeof prefs.maxIterations === 'number' && prefs.maxIterations > 0 ? prefs.maxIterations : 5,
    framework: framework ?? null,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Merge an ordered list of rule blocks into one deduplicated block. Keys on
 *  `line.trim()` so "- foo" and "  - foo  " collapse; first-seen capitalization
 *  and leading whitespace win. Runs of 3+ blank lines collapse to 2. */
export function dedupLines(blocks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const key = line.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return (
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
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

/** Plugin base directories per CLI plugin protocol. claude-code/zai use
 *  `.claude/plugins`; codex/gemini/amp have different plugin formats not yet
 *  packaged here. */
const DRUPAL_LSP_TARGET_BASES = ['.claude/plugins/drupal-php-lsp'];

export const DRUPAL_LSP_FILES: { rel: string; content: string }[] = DRUPAL_LSP_TARGET_BASES.flatMap(
  (base) => [
    { rel: `${base}/.claude-plugin/marketplace.json`, content: DRUPAL_LSP_MARKETPLACE },
    {
      rel: `${base}/.claude-plugin/drupal-php-lsp/.claude-plugin/plugin.json`,
      content: DRUPAL_LSP_PLUGIN,
    },
    { rel: `${base}/.claude-plugin/drupal-php-lsp/.lsp.json`, content: DRUPAL_LSP_CONFIG },
  ],
);

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
    const envApplyData = (envPrev?.output as { enrichedData?: EnvDetectShape } | null)
      ?.enrichedData;
    const envDetectData = (envPrev?.detect as DetectResult | null)?.data as
      | EnvDetectShape
      | undefined;
    const envData: EnvDetectShape | null = envApplyData ?? envDetectData ?? null;

    const confirmPrev = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '02-detection-confirmation',
    );
    const confirmedValues =
      (confirmPrev?.output as { values?: Record<string, unknown> } | null)?.values ?? null;

    const projectInfo = extractProjectInfo(envData, confirmedValues);
    const framework = projectInfo.framework;
    const language = projectInfo.primaryLanguage;
    const projectName = projectInfo.name;

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

    const providerRows = await ctx.db
      .select({
        name: schema.cliProviders.name,
        rulesContent: schema.cliProviders.rulesContent,
        enabled: schema.cliProviders.enabled,
      })
      .from(schema.cliProviders)
      .where(eq(schema.cliProviders.userId, ctx.userId));
    const cliProviders = providerRows
      .filter((p) => p.enabled && p.rulesContent.trim().length > 0)
      .map((p) => ({ name: p.name, rulesContent: p.rulesContent }));

    const rulesFiles = new Set<string>();
    for (const p of cliProviders) {
      const adapter = cliAdapterRegistry.get(p.name);
      rulesFiles.add(adapter.rulesFile);
      if (adapter.rulesFileMode === 'import') {
        rulesFiles.add(adapter.rulesFile);
      }
    }

    // Per-CLI agent file targets. Claude-code and Zai share `.claude/agents`
    // (markdown + YAML frontmatter); Gemini uses its own `.gemini/agents`
    // (markdown); Codex uses `.codex/agents` (TOML — Codex's own schema);
    // Amp has no file-based custom agents so is omitted entirely.
    const enabledProviders = providerRows.filter((p) => p.enabled);
    const agentTargetsByDir = new Map<string, { dir: string; format: 'markdown' | 'toml' }>();
    for (const p of enabledProviders) {
      const meta = getCliProviderMetadata(p.name);
      if (!meta.projectAgentsDir || !meta.agentFileFormat) continue;
      if (!agentTargetsByDir.has(meta.projectAgentsDir)) {
        agentTargetsByDir.set(meta.projectAgentsDir, {
          dir: meta.projectAgentsDir,
          format: meta.agentFileFormat,
        });
      }
    }
    const agentTargets = Array.from(agentTargetsByDir.values());
    const agentExt = (format: 'markdown' | 'toml'): string => (format === 'toml' ? 'toml' : 'md');

    const candidates = [
      '.claude/workflow-config.json',
      ...agentTargets.flatMap((t) => [
        `${t.dir}/README.md`,
        ...agents.map((a) => `${t.dir}/${a.id}.${agentExt(t.format)}`),
      ]),
      ...BASELINE_COMMANDS.map((c) => `.claude/commands/${c.id}.md`),
      ...(lspLanguages.includes('php-extended') ? DRUPAL_LSP_FILES.map((f) => f.rel) : []),
      ...(mcpSettingsJson.trim().length > 0 ? ['.claude/mcp_settings.json'] : []),
      'AGENTS.md',
      ...Array.from(rulesFiles),
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
      projectInfo,
      acceptedAgentIds,
      customAgentSpecs,
      lspLanguages,
      mcpSettingsJson,
      prefs,
      cliProviders,
      agentTargets,
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
    const customBodies = new Map((detected.customAgentSpecs ?? []).map((s) => [s.id, s]));
    const agents = resolveAgents(detected.framework, detected.acceptedAgentIds, customBodies);

    const wroteFiles: string[] = [];
    const skippedFiles: string[] = [];
    const appendedFiles: string[] = [];

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

    /** Append text to file if not already present, or create if missing.
     *  With paired markers ("<!-- haive:X -->" ... "<!-- /haive:X -->") and the
     *  step's `overwrite` flag, the content between the markers is replaced in
     *  place so re-runs refresh the block. Without the end marker, behaviour is
     *  the legacy "never overwrite" append. */
    const appendOrCreate = async (
      rel: string,
      block: string,
      marker: string,
      endMarker?: string,
    ): Promise<void> => {
      const full = path.join(ctx.repoPath, rel);
      const exists = await pathExists(full);
      if (exists) {
        const current = await readFile(full, 'utf8');
        if (current.includes(marker)) {
          if (overwrite && endMarker && current.includes(endMarker)) {
            const start = current.indexOf(marker);
            const endIdx = current.indexOf(endMarker, start);
            const end = endIdx + endMarker.length;
            const replaced = current.slice(0, start) + block.trimEnd() + current.slice(end);
            await writeFile(full, replaced, 'utf8');
            wroteFiles.push(rel);
            return;
          }
          skippedFiles.push(rel);
          return;
        }
        const sep = current.length === 0 || current.endsWith('\n') ? '' : '\n';
        await writeFile(full, current + sep + block, 'utf8');
        appendedFiles.push(rel);
        return;
      }
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, block, 'utf8');
      wroteFiles.push(rel);
    };

    await writeIfAllowed(
      '.claude/workflow-config.json',
      workflowConfigJson(detected.prefs, detected.framework),
    );

    // Write agents + index to every enabled CLI's native dir, using the
    // format each CLI expects (markdown for claude/gemini/zai, TOML for
    // codex). Fallback to a single `.claude/agents` markdown write when
    // no enabled provider has a file-based agent directory (only Amp
    // enabled) so the user still gets files — warn so they know why.
    const targets =
      detected.agentTargets && detected.agentTargets.length > 0
        ? detected.agentTargets
        : [{ dir: '.claude/agents', format: 'markdown' as const }];
    if (detected.agentTargets && detected.agentTargets.length === 0) {
      ctx.logger.warn(
        'no enabled CLI provider has a file-based agents directory; writing to .claude/agents as fallback',
      );
    }
    for (const target of targets) {
      for (const agent of agents) {
        const ext = target.format === 'toml' ? 'toml' : 'md';
        const content =
          target.format === 'toml' ? buildAgentFileToml(agent) : buildAgentFileMarkdown(agent);
        await writeIfAllowed(`${target.dir}/${agent.id}.${ext}`, content);
      }
      if (agents.length > 0) {
        const indexExt = target.format === 'toml' ? 'toml' : 'md';
        await writeIfAllowed(`${target.dir}/README.md`, agentsIndexMarkdown(agents, indexExt));
      }
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

    // Project info block written to AGENTS.md under the haive:project-info
    // markers. AGENTS.md is the canonical home for project metadata and is
    // imported by claude-code/zai (CLAUDE.md) and gemini (GEMINI.md) via the
    // `@AGENTS.md` line; codex/amp consume AGENTS.md natively. Written
    // unconditionally so import-mode CLIs always have a target to import.
    await appendOrCreate(
      'AGENTS.md',
      projectInfoMarkdown(detected.projectInfo),
      PROJECT_INFO_START,
      PROJECT_INFO_END,
    );

    // Per-CLI rules written to each adapter's native rules file. Providers that
    // share a target file (codex + amp + gemini -> AGENTS.md, claude-code + zai ->
    // CLAUDE.md) are merged line-by-line with trim-equal dedup so shared rules
    // appear once. Three modes:
    //   native: file is AGENTS.md, content written under haive:cli-rules marker.
    //   import: file gets `@AGENTS.md` line + the same rules block (so the CLI
    //           follows AGENTS.md via import AND has its own copy available).
    //   copy:   file gets only the rules block (no import syntax supported).
    const groups = new Map<string, { mode: 'native' | 'import' | 'copy'; blocks: string[] }>();
    for (const p of detected.cliProviders) {
      const adapter = cliAdapterRegistry.get(p.name);
      const existing = groups.get(adapter.rulesFile);
      if (existing) {
        existing.blocks.push(p.rulesContent);
      } else {
        groups.set(adapter.rulesFile, {
          mode: adapter.rulesFileMode,
          blocks: [p.rulesContent],
        });
      }
    }
    const rulesStart = '<!-- haive:cli-rules -->';
    const rulesEnd = '<!-- /haive:cli-rules -->';
    for (const [rulesFile, group] of groups) {
      const combined = dedupLines(group.blocks);
      const rulesBlock = `${rulesStart}\n${combined}${rulesEnd}\n`;
      if (group.mode === 'import') {
        await appendOrCreate(rulesFile, '@AGENTS.md\n', '@AGENTS.md');
      }
      await appendOrCreate(rulesFile, rulesBlock, rulesStart, rulesEnd);
    }

    ctx.logger.info(
      {
        wrote: wroteFiles.length,
        appended: appendedFiles.length,
        skipped: skippedFiles.length,
        agents: agents.length,
        commands: BASELINE_COMMANDS.length,
      },
      'generate-files apply complete',
    );
    return {
      wroteFiles: [...wroteFiles, ...appendedFiles],
      skippedFiles,
      agentCount: agents.length,
      commandCount: BASELINE_COMMANDS.length,
    };
  },
};
