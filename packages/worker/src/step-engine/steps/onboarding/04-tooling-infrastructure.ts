import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import {
  buildDefaultMcpServers,
  buildMcpConfigForCli,
  mcpSettingsFileContent,
} from '../../../sandbox/mcp-config.js';
import { loadCliProviderMetadata, loadPreviousStepOutput } from './_helpers.js';
import type { EnvDetectApply } from './01-env-detect.js';

const DEFAULT_MCP_SETTINGS_JSON: string = (() => {
  const servers = buildDefaultMcpServers({
    repoPath: '.',
    includeFilesystem: false,
    includeGit: false,
    includeChromeDevtools: true,
  });
  const config = buildMcpConfigForCli('claude-code', servers);
  return config ? config.content : '{\n  "mcpServers": {}\n}';
})();

interface ToolingDetect {
  primaryLanguage: string;
  framework: string;
  containerType: string;
  databaseType: string | null;
  hasPhpExtendedExtensions: boolean;
  cliDisplayName: string | null;
  cliSupportsMcp: boolean;
  cliSupportsPlugins: boolean;
  /** Current value of `repositories.rtk_enabled` for this task's repo. Used
   *  as the form-field default so a re-run of step 04 reflects the most
   *  recently saved choice instead of the hard-coded migration default. */
  rtkEnabled: boolean;
  /** Threaded into the "Settings → Global KB" link so opening it pre-fills the
   *  "Add a house rule" repo + CLI with this task's. */
  repositoryId: string | null;
  cliProviderId: string | null;
}

interface EnvDetectData {
  project: { primaryLanguage: string; framework?: string };
  container: { type: string; databaseType: string | null };
}

const LSP_OPTIONS: { value: string; label: string }[] = [
  { value: 'php', label: 'Intelephense (PHP)' },
  {
    value: 'php-extended',
    label: 'Intelephense + CMS extensions (.inc, .module, .install, .theme, .profile)',
  },
  { value: 'typescript', label: 'vtsls (TypeScript / JavaScript)' },
  { value: 'python', label: 'Pyright (Python)' },
  { value: 'go', label: 'gopls (Go)' },
  { value: 'rust', label: 'rust-analyzer (Rust)' },
  { value: 'java', label: 'jdtls (Java)' },
];

/** Frameworks that use non-standard PHP file extensions (.inc, .module, etc.) */
const PHP_EXTENDED_FRAMEWORKS = new Set([
  'drupal',
  'drupal7',
  'drupal8',
  'drupal9',
  'drupal10',
  'laravel',
]);

function defaultLspForLanguage(lang: string, framework: string, hasPhpExtended: boolean): string[] {
  switch (lang) {
    case 'php':
      return [hasPhpExtended || PHP_EXTENDED_FRAMEWORKS.has(framework) ? 'php-extended' : 'php'];
    case 'javascript':
    case 'typescript':
      return ['typescript'];
    case 'python':
      return ['python'];
    case 'go':
      return ['go'];
    case 'rust':
      return ['rust'];
    case 'java':
      return ['java'];
    default:
      return [];
  }
}

export const toolingInfrastructureStep: StepDefinition<
  ToolingDetect,
  { tooling: Record<string, unknown> }
> = {
  metadata: {
    id: '04-tooling-infrastructure',
    workflowType: 'onboarding',
    index: 4,
    title: 'Tooling and infrastructure preferences',
    description:
      'Captures user preferences for RAG storage (Ollama + PostgreSQL), MCP browser testing and LSP language server installation.',
    requiresCli: false,
    providerSensitive: true,
  },

  async detect(ctx: StepContext): Promise<ToolingDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    // Prefer enriched data from apply output
    const applyOutput = prev?.output as EnvDetectApply | null;
    let data: EnvDetectData;
    if (applyOutput?.enrichedData) {
      const enriched = applyOutput.enrichedData as unknown as EnvDetectData;
      data = enriched;
    } else {
      data = ((prev?.detect as DetectResult | null)?.data as unknown as
        | EnvDetectData
        | undefined) ?? {
        project: { primaryLanguage: 'unknown' },
        container: { type: 'none', databaseType: null },
      };
    }

    // Check step 01.5 ripgrep output for PHP-candidate extensions (.inc, .module, etc.)
    const rgPrev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01_5-ripgrep-config');
    const rgDetect = rgPrev?.detect as { extensions?: { ext: string; isPhp: boolean }[] } | null;
    const hasPhpExtendedExtensions = (rgDetect?.extensions ?? []).some((e) => e.isPhp);

    const cliMeta = await loadCliProviderMetadata(ctx.db, ctx.cliProviderId);

    // Resolve current rtk_enabled by walking task → repository. New repos
    // default to true via the migration; this read lets a step-04 re-run
    // reflect the user's last-saved choice rather than the hardcoded default.
    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    let rtkEnabled = true;
    const repositoryId = taskRow[0]?.repositoryId ?? null;
    if (repositoryId) {
      const repoRow = await ctx.db
        .select({ rtkEnabled: schema.repositories.rtkEnabled })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
        .limit(1);
      if (repoRow[0]) rtkEnabled = repoRow[0].rtkEnabled;
    }

    return {
      primaryLanguage: data.project.primaryLanguage,
      framework: data.project.framework ?? 'unknown',
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      hasPhpExtendedExtensions,
      cliDisplayName: cliMeta?.displayName ?? null,
      cliSupportsMcp: cliMeta?.supportsMcp ?? false,
      cliSupportsPlugins: cliMeta?.supportsPlugins ?? false,
      rtkEnabled,
      repositoryId,
      cliProviderId: ctx.cliProviderId,
    };
  },

  form(_ctx, detected): FormSchema {
    const ragOptions: { value: string; label: string }[] = [];
    if (detected.containerType === 'ddev') {
      ragOptions.push({ value: 'ddev', label: 'Use the project DDEV PostgreSQL database' });
    }
    ragOptions.push(
      { value: 'internal', label: 'Use haive internal PostgreSQL (per-project database)' },
      { value: 'external', label: 'Use a separate PostgreSQL database' },
      { value: 'none', label: 'Skip RAG infrastructure' },
    );
    const ragDefault = detected.containerType === 'ddev' ? 'ddev' : 'internal';

    // Carry this task's repo + CLI into the Global KB link so "Add a house rule"
    // arrives pre-filled (the link opens in a new tab, so this task is not lost).
    const gkbParams = new URLSearchParams();
    if (detected.repositoryId) gkbParams.set('repo', detected.repositoryId);
    if (detected.cliProviderId) gkbParams.set('cli', detected.cliProviderId);
    const gkbHref = gkbParams.toString()
      ? `/settings/global-kb?${gkbParams.toString()}`
      : '/settings/global-kb';

    return {
      title: 'Tooling and infrastructure',
      description:
        'Configure RAG storage, Ollama embeddings, MCP browser testing and LSP language server preferences for this project.',
      infoSections: [
        {
          title: 'Shared global knowledge base (set up once)',
          body: `### Global KB\n\nThe RAG storage below is the **per-repository** vector DB for THIS project. Separately, Haive keeps one instance-wide **global knowledge base** of house standards that every project retrieves from (version-scoped to its stack). Configure its database connection + embedding model once at **[Settings → Global KB](${gkbHref})** — open it to choose internal vs an external/central DB and to set the embedding model (otherwise it falls back to weak hash embeddings).`,
          defaultOpen: true,
        },
      ],
      fields: [
        {
          type: 'select',
          id: 'ragMode',
          label: 'RAG embedding storage',
          default: ragDefault,
          options: ragOptions,
        },
        {
          type: 'text',
          id: 'ragConnectionString',
          label: 'PostgreSQL connection string (for external or DDEV mode)',
          placeholder: 'postgres://user:password@host:5432/database',
        },
        {
          type: 'select',
          id: 'ollamaMode',
          label: 'Ollama server',
          description:
            'Pick the internal Ollama service bundled with haive, or point at an external Ollama instance. Internal mode uses http://ollama:11434 automatically.',
          default: 'internal',
          options: [
            { value: 'internal', label: 'Use haive internal Ollama service' },
            { value: 'external', label: 'Use an external Ollama server' },
          ],
        },
        {
          type: 'text',
          id: 'ollamaUrl',
          label: 'External Ollama API URL (only used when external mode is selected)',
          default: 'http://host.docker.internal:11434',
          placeholder: 'http://host.docker.internal:11434',
        },
        {
          type: 'text',
          id: 'embeddingModel',
          label: 'Ollama embedding model',
          default: 'qwen3-embedding:4b',
          placeholder: 'qwen3-embedding:4b',
        },
        {
          type: 'number',
          id: 'embeddingDimensions',
          label: 'Embedding vector dimensions (must match model output)',
          default: 2560,
          min: 128,
          max: 8192,
        },
        {
          type: 'textarea',
          id: 'mcpSettingsJson',
          label: 'MCP server definitions (.claude/mcp_settings.json)',
          description:
            (detected.cliSupportsMcp
              ? ''
              : `WARNING: ${detected.cliDisplayName ?? 'the current CLI'} does not support MCP in haive. Settings will be saved but ignored until you switch to a CLI that does (e.g. Claude Code, Codex, Gemini, Z.AI). `) +
            'Written verbatim to .claude/mcp_settings.json and passed to Claude Code via --mcp-config. Pre-filled with the Chrome DevTools MCP server used by browser-testing workflow steps. Add additional servers inside the mcpServers object (e.g. filesystem, git, postgres). Leave empty to disable all MCP servers — a stub config (`{"mcpServers": {}}`) is written so CLI providers that pass --mcp-config still load successfully.',
          default: DEFAULT_MCP_SETTINGS_JSON,
          rows: 14,
        },
        {
          type: 'multi-select',
          id: 'lspLanguages',
          label: 'LSP language servers',
          description:
            (detected.cliSupportsPlugins
              ? ''
              : `WARNING: ${detected.cliDisplayName ?? 'the current CLI'} does not support plugin install in haive. LSP servers will still be baked into the project image, but LSP plugins will not be installed into the CLI until you switch to a CLI that supports them (e.g. Claude Code, Z.AI, Qwen). `) +
            'Pick one or more language servers to install. Leave empty to skip LSP installation.',
          options: LSP_OPTIONS,
          defaults: defaultLspForLanguage(
            detected.primaryLanguage,
            detected.framework,
            detected.hasPhpExtendedExtensions,
          ),
        },
        {
          type: 'checkbox',
          id: 'rtkEnabled',
          label: 'Enable RTK token-saving proxy',
          description:
            'Routes common dev commands (git, npm, docker, tests, etc.) through rtk so their output is compressed 60–90% before reaching the LLM. The binary is baked into every sandbox; per-CLI hook configs are written into the repo and into the per-task auth volume. Toggle off to remove the configs on the next upgrade-apply.',
          default: detected.rtkEnabled,
        },
      ],
      submitLabel: 'Save tooling preferences',
    };
  },

  async apply(ctx, args) {
    const tooling: Record<string, unknown> = { ...args.formValues };
    if (tooling.ollamaMode === 'internal') {
      tooling.ollamaUrl = 'http://ollama:11434';
    }

    // Materialise `.claude/mcp_settings.json` here, before any later
    // CLI-using step (06_5 agent discovery is the first) runs. CLI providers
    // wired with `--mcp-config .claude/mcp_settings.json` need the file to
    // exist with valid JSON; an empty textarea writes the
    // `{"mcpServers": {}}` stub. Step 07 still rewrites the file under its
    // overwrite gate for re-runs.
    const mcpInput = typeof tooling.mcpSettingsJson === 'string' ? tooling.mcpSettingsJson : '';
    const mcpPath = path.join(ctx.repoPath, '.claude/mcp_settings.json');
    await mkdir(path.dirname(mcpPath), { recursive: true });
    await writeFile(mcpPath, mcpSettingsFileContent(mcpInput), 'utf8');

    // Persist `rtk_enabled` on the repo row so the choice survives CLI swaps,
    // upgrade re-runs, and tasks that don't go through step 04. The `tooling`
    // jsonb keeps a copy too for step-output replay during onboarding-upgrade
    // backfill (when no live repo row exists yet).
    const rtkEnabled = Boolean(tooling.rtkEnabled);
    tooling.rtkEnabled = rtkEnabled;

    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = taskRow[0]?.repositoryId ?? null;
    if (repositoryId) {
      await ctx.db
        .update(schema.repositories)
        .set({ rtkEnabled, updatedAt: new Date() })
        .where(eq(schema.repositories.id, repositoryId));
    } else {
      ctx.logger.warn(
        'tooling-infrastructure: task has no repository_id; rtk_enabled persisted only in step output',
      );
    }

    ctx.logger.info({ tooling, rtkEnabled }, 'tooling preferences saved');
    return { tooling };
  },
};
