import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, FormSchema } from '@haive/shared';
import {
  buildCliRulesBlock,
  CLI_RULES_START,
  CLI_RULES_END,
  getCliProviderMetadata,
} from '@haive/shared';
import { cliAdapterRegistry } from '../../../cli-adapters/registry.js';
import type { CliProviderName } from '../../../cli-adapters/types.js';
import { mcpSettingsFileContent } from '../../../sandbox/mcp-config.js';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  type AgentSpec,
  BASELINE_AGENT_SPECS,
  buildAgentFileForTarget,
  FRAMEWORK_AGENT_SPECS,
  shouldEmitAgentsReadme,
  stubCustomAgent,
} from './_agent-templates.js';
import { loadPreviousStepOutput, pathExists } from './_helpers.js';
import {
  buildClaudeSettingsJson,
  buildGeminiSettingsJson,
  buildRtkAwarenessBlock,
  RTK_REF_MARKER_END,
  RTK_REF_MARKER_START,
} from './_rtk-templates.js';

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
  existingFiles: string[];
  /** Per-repo RTK opt-in. Read from `repositories.rtk_enabled` in detect();
   *  drives the rtk-config template items in the manifest expansion. */
  rtkEnabled: boolean;
  /** Enabled CLI providers with the metadata rtk-config items need to gate
   *  their fan-out. Only the names are read by current items, but rules-file
   *  metadata is carried for future per-CLI templates. */
  enabledCliProviders: Array<{
    name: CliProviderName;
    rulesFile: string;
    rulesFileMode: 'native' | 'import' | 'copy';
  }>;
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
// CLI rules markers now live in @haive/shared so the API can recompute the same
// block; re-exported here for back-compat with existing importers.
export { CLI_RULES_START, CLI_RULES_END };

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
}

/** Table-style index listing every agent by `name` and `description`. Mirrors the
 *  original orchestration output. `ext` is the agent file extension in this
 *  directory — `md` for claude/gemini/zai, `toml` for codex. Index itself is
 *  always markdown. */
export function agentsIndexMarkdown(agents: AgentSpec[], ext: 'md' | 'toml' = 'md'): string {
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
  const source = ext === 'toml' ? 'TOML top-level keys' : 'the YAML frontmatter';
  const lines: string[] = [
    '# Agents Index',
    '',
    'Auto-generated by Haive onboarding. Re-run onboarding to refresh this file after editing agent definitions.',
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

/** The deterministic `.claude/workflow-config.json`. Reduced to the framework
 *  stamp: the legacy verification_level / auto_commit / max_iterations fields
 *  were collected by the (now-removed) workflow-prefs step but never consumed —
 *  in the legacy orchestration or here. */
export function workflowConfigJson(framework: string | null): string {
  const config = {
    framework: framework ?? null,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export interface RulesPlan {
  /** Merged `haive:cli-rules` block for AGENTS.md, or null when no enabled
   *  provider has rules content. */
  agentsRulesBlock: string | null;
  /** Files (CLAUDE.md, GEMINI.md) that receive only an `@AGENTS.md` import. */
  importFiles: string[];
  /** Files that receive a full duplicate of AGENTS.md (project-info + rules) —
   *  for CLIs supporting neither native AGENTS.md nor `@` imports. Unused by
   *  the current adapter set. */
  copyFiles: string[];
}

/** Decide what each CLI's rules file gets, given the enabled providers joined
 *  with their adapter rules-file metadata. AGENTS.md is the single source of
 *  truth (every provider's rules merged + trim-equal deduped); import-mode
 *  files (CLAUDE.md, GEMINI.md) just point at it via `@AGENTS.md`; native-mode
 *  files (rulesFile === 'AGENTS.md') need nothing extra. */
export function planRulesFiles(
  providers: ReadonlyArray<{
    rulesContent: string;
    rulesFile: string;
    rulesFileMode: 'native' | 'import' | 'copy';
  }>,
): RulesPlan {
  const agentsRulesBlock = buildCliRulesBlock(providers.map((p) => p.rulesContent));
  const importFiles = new Set<string>();
  const copyFiles = new Set<string>();
  for (const p of providers) {
    if (p.rulesFile === 'AGENTS.md') continue;
    if (p.rulesFileMode === 'import') importFiles.add(p.rulesFile);
    else if (p.rulesFileMode === 'copy') copyFiles.add(p.rulesFile);
  }
  return { agentsRulesBlock, importFiles: [...importFiles], copyFiles: [...copyFiles] };
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
      'Writes the subagent files under .claude/agents/ and .claude/workflow-config.json. All content is template-driven; no CLI invocation required.',
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
      .map((p) => ({ name: p.name, rulesContent: p.rulesContent }))
      // Sort by provider name so the merged cli-rules block (and its hash) is
      // deterministic regardless of cli_providers row order — required so the
      // API's drift recompute matches the stored block byte-for-byte.
      .sort((a, b) => a.name.localeCompare(b.name));

    const rulesFiles = new Set<string>();
    for (const p of cliProviders) {
      const adapter = cliAdapterRegistry.get(p.name);
      rulesFiles.add(adapter.rulesFile);
      if (adapter.rulesFileMode === 'import') {
        rulesFiles.add(adapter.rulesFile);
      }
    }

    // RTK opt-in is per-repo; pull from `repositories.rtk_enabled`. Snapshotting
    // the value into detect output also lets the lazy-backfill path in
    // 01-upgrade-plan replay against repos that have since had the row deleted.
    const rtkTaskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    let rtkEnabled = false;
    const rtkRepoId = rtkTaskRow[0]?.repositoryId ?? null;
    if (rtkRepoId) {
      const repoRow = await ctx.db
        .select({ rtkEnabled: schema.repositories.rtkEnabled })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, rtkRepoId))
        .limit(1);
      if (repoRow[0]) rtkEnabled = repoRow[0].rtkEnabled;
    }

    // Carry per-CLI rules-file metadata into detect so the rtk-config items
    // can fan out per CLI without re-querying the adapter registry inside
    // the manifest expansion. Only enabled providers are included; rules
    // content presence is ignored here (rtk works whether the user has
    // populated cli_providers.rules_content or not).
    const enabledCliProviders = providerRows
      .filter((p) => p.enabled)
      .map((p) => {
        const adapter = cliAdapterRegistry.get(p.name);
        return {
          name: p.name,
          rulesFile: adapter.rulesFile,
          rulesFileMode: adapter.rulesFileMode,
        };
      });

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
      ...(lspLanguages.includes('php-extended') ? DRUPAL_LSP_FILES.map((f) => f.rel) : []),
      '.claude/mcp_settings.json',
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
      cliProviders,
      agentTargets,
      plannedAgents,
      existingFiles,
      rtkEnabled,
      enabledCliProviders,
    };
  },

  form(_ctx, detected): FormSchema {
    const existingSummary =
      detected.existingFiles.length > 0
        ? ` ${detected.existingFiles.length} existing file(s) may be overwritten if you enable overwrite.`
        : '';
    return {
      title: 'Generate workflow files',
      description: `Plans to write ${detected.plannedAgents.length} agent file(s) plus .claude/workflow-config.json.${existingSummary}`,
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

    await writeIfAllowed('.claude/workflow-config.json', workflowConfigJson(detected.framework));

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
        const content = buildAgentFileForTarget(agent, target);
        await writeIfAllowed(`${target.dir}/${agent.id}.${ext}`, content);
      }
      if (agents.length > 0 && shouldEmitAgentsReadme(target)) {
        const indexExt = target.format === 'toml' ? 'toml' : 'md';
        await writeIfAllowed(`${target.dir}/README.md`, agentsIndexMarkdown(agents, indexExt));
      }
    }
    if (detected.lspLanguages.includes('php-extended')) {
      for (const f of DRUPAL_LSP_FILES) {
        await writeIfAllowed(f.rel, f.content + '\n');
      }
    }

    await writeIfAllowed(
      '.claude/mcp_settings.json',
      mcpSettingsFileContent(detected.mcpSettingsJson),
    );

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

    // Agent rules are consolidated into AGENTS.md — the single source of truth
    // every supported CLI reaches: codex/amp/antigravity read AGENTS.md
    // natively, and claude-code/zai/gemini import it via `@AGENTS.md`. All
    // enabled providers' rules are merged (trim-equal dedup) into one
    // haive:cli-rules block appended after the project-info block above; each
    // import-mode rules file (CLAUDE.md, GEMINI.md) becomes a lone `@AGENTS.md`.
    const rulesPlan = planRulesFiles(
      detected.cliProviders.map((p) => {
        const adapter = cliAdapterRegistry.get(p.name);
        return {
          rulesContent: p.rulesContent,
          rulesFile: adapter.rulesFile,
          rulesFileMode: adapter.rulesFileMode,
        };
      }),
    );
    if (rulesPlan.agentsRulesBlock) {
      await appendOrCreate('AGENTS.md', rulesPlan.agentsRulesBlock, CLI_RULES_START, CLI_RULES_END);
    }
    for (const rf of rulesPlan.importFiles) {
      await appendOrCreate(rf, '@AGENTS.md\n', '@AGENTS.md');
    }
    for (const rf of rulesPlan.copyFiles) {
      await appendOrCreate(
        rf,
        projectInfoMarkdown(detected.projectInfo),
        PROJECT_INFO_START,
        PROJECT_INFO_END,
      );
      if (rulesPlan.agentsRulesBlock) {
        await appendOrCreate(rf, rulesPlan.agentsRulesBlock, CLI_RULES_START, CLI_RULES_END);
      }
    }

    // RTK opt-in. The per-CLI hook settings files (.claude/settings.json,
    // .gemini/settings.json) are the only manifest-tracked RTK artifacts —
    // dedicated single-purpose files, so the upgrade path's whole-file
    // overwrite/delete is safe. They mirror the surviving rtk-config
    // TemplateItems in `_rtk-templates.ts` 1:1 so step 12 records them and
    // toggling rtk off removes them on upgrade. The RTK awareness markdown is
    // inlined into AGENTS.md (non-manifest, like project-info and cli-rules) so
    // every CLI reads it — native AGENTS.md readers do not expand `@` refs, and
    // CLAUDE.md/GEMINI.md stay a lone `@AGENTS.md` import.
    if (detected.rtkEnabled) {
      const enabled = detected.enabledCliProviders ?? [];
      const hasClaudeFamily = enabled.some((p) => p.name === 'claude-code' || p.name === 'zai');
      const hasGemini = enabled.some((p) => p.name === 'gemini');

      if (hasClaudeFamily) {
        await writeIfAllowed('.claude/settings.json', buildClaudeSettingsJson());
      }
      if (hasGemini) {
        await writeIfAllowed('.gemini/settings.json', buildGeminiSettingsJson());
      }
      if (enabled.length > 0) {
        await appendOrCreate(
          'AGENTS.md',
          buildRtkAwarenessBlock(),
          RTK_REF_MARKER_START,
          RTK_REF_MARKER_END,
        );
      }
    }

    ctx.logger.info(
      {
        wrote: wroteFiles.length,
        appended: appendedFiles.length,
        skipped: skippedFiles.length,
        agents: agents.length,
      },
      'generate-files apply complete',
    );
    return {
      wroteFiles: [...wroteFiles, ...appendedFiles],
      skippedFiles,
      agentCount: agents.length,
    };
  },
};
