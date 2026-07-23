import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { ONBOARDING_TOOLING_SCHEMA_VERSION } from '@haive/shared';
import type { DetectResult, FormSchema, OnboardingToolingMirror } from '@haive/shared';
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
  cliSupportsLsp: boolean;
  /** Current value of `repositories.rtk_enabled` for this task's repo. Used
   *  as the form-field default so a re-run of step 04 reflects the most
   *  recently saved choice instead of the hard-coded migration default. */
  rtkEnabled: boolean;
  /** This task's repository id, for the bottom tooling-page link. */
  repositoryId: string | null;
  /** "version (latest)" label shown in the RTK checkbox description. */
  rtkVersionLabel: string;
  /** "version (latest)" label shown in the MCP (.claude/mcp_settings.json) field. */
  chromeVersionLabel: string;
  /** Per-LSP-option version badge (option value → "version (latest)"). Absent for
   *  the unpinnable servers (rust → rust-analyzer, java → jdtls). */
  lspVersionByOption: Record<string, string>;
}

interface EnvDetectData {
  project: { primaryLanguage: string; framework?: string };
  container: { type: string; databaseType: string | null };
}

const LSP_OPTIONS: { value: string; label: string }[] = [
  // Single PHP LSP option — plain `php` dropped (it and `php-extended` now install
  // the same intelephense binary + drupal-php-lsp plugin with CMS-extension
  // handling). Legacy `php` selections still work; they map to the survivor.
  { value: 'php-extended', label: 'Intelephense (PHP)' },
  { value: 'typescript', label: 'vtsls (TypeScript / JavaScript)' },
  { value: 'python', label: 'Pyright (Python)' },
  { value: 'go', label: 'gopls (Go)' },
  { value: 'rust', label: 'rust-analyzer (Rust)' },
  { value: 'java', label: 'jdtls (Java)' },
];

/** Maps each LSP option value (a language) to the tool name whose version cache
 *  it uses, for surfacing the version badge. rust/java map to unpinnable servers
 *  (rust-analyzer, jdtls) that have no cached version → no badge. */
const LSP_OPTION_TO_TOOL: Record<string, string> = {
  'php-extended': 'intelephense',
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  java: 'jdtls',
};

function defaultLspForLanguage(lang: string): string[] {
  switch (lang) {
    case 'php':
      // Single PHP LSP now (drupal-php-lsp plugin + intelephense, CMS extensions
      // handled). Legacy `php` selections still resolve to this survivor.
      return ['php-extended'];
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
      'Captures user preferences for RAG storage, MCP browser testing and provider-supported code-navigation tooling.',
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
        EnvDetectData | undefined) ?? {
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
    let rtkVersionPin: string | null = null;
    let chromeMcpPin: string | null = null;
    const repositoryId = taskRow[0]?.repositoryId ?? null;
    if (repositoryId) {
      const repoRow = await ctx.db
        .select({
          rtkEnabled: schema.repositories.rtkEnabled,
          rtkVersion: schema.repositories.rtkVersion,
          chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
        .limit(1);
      if (repoRow[0]) {
        rtkEnabled = repoRow[0].rtkEnabled;
        rtkVersionPin = repoRow[0].rtkVersion;
        chromeMcpPin = repoRow[0].chromeDevtoolsMcpVersion;
      }
    }

    // Version labels for the checkbox/field descriptions + badges. Newest = head
    // of the sorted-desc cache list (falls back to the dist-tag latest). An
    // unpinned component (or a pin equal to newest) gets a " (latest)" suffix.
    const toolRows = await ctx.db
      .select({
        name: schema.toolPackageVersions.name,
        versions: schema.toolPackageVersions.versions,
        latestVersion: schema.toolPackageVersions.latestVersion,
      })
      .from(schema.toolPackageVersions);
    const newestByTool = new Map<string, string | null>();
    for (const r of toolRows) newestByTool.set(r.name, r.versions?.[0] ?? r.latestVersion ?? null);
    const fmtVersion = (pin: string | null, tool: string): string => {
      const newest = newestByTool.get(tool) ?? null;
      const effective = pin ?? newest;
      if (!effective) return 'latest';
      return `${effective}${!pin || pin === newest ? ' (latest)' : ''}`;
    };
    const lspVersionByOption: Record<string, string> = {};
    for (const [optValue, tool] of Object.entries(LSP_OPTION_TO_TOOL)) {
      const v = newestByTool.get(tool);
      if (v) lspVersionByOption[optValue] = `${v} (latest)`;
    }

    return {
      primaryLanguage: data.project.primaryLanguage,
      framework: data.project.framework ?? 'unknown',
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      hasPhpExtendedExtensions,
      cliDisplayName: cliMeta?.displayName ?? null,
      cliSupportsMcp: cliMeta?.supportsMcp ?? false,
      cliSupportsLsp: cliMeta?.supportsLsp ?? false,
      rtkEnabled,
      repositoryId,
      rtkVersionLabel: fmtVersion(rtkVersionPin, 'rtk'),
      chromeVersionLabel: fmtVersion(chromeMcpPin, 'chrome-devtools-mcp'),
      lspVersionByOption,
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

    // Show each LSP server's version as a badge on its checkbox (absent for the
    // unpinnable servers). Selecting installs that version at latest; pinning a
    // specific version is done on the tooling page.
    const lspVersionByOption = detected.lspVersionByOption ?? {};
    const lspOptions = LSP_OPTIONS.map((o) =>
      lspVersionByOption[o.value]
        ? { ...o, badge: lspVersionByOption[o.value], badgeColor: 'green' as const }
        : o,
    );

    return {
      title: 'Tooling and infrastructure',
      description:
        'Configure RAG storage, Ollama embeddings, and MCP browser testing for this project.',
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
            'Written verbatim to .claude/mcp_settings.json and passed to Claude Code via --mcp-config. Pre-filled with the Chrome DevTools MCP server used by browser-testing workflow steps. Add additional servers inside the mcpServers object (e.g. filesystem, git, postgres). Leave empty to disable all MCP servers — a stub config (`{"mcpServers": {}}`) is written so CLI providers that pass --mcp-config still load successfully.' +
            ` Chrome DevTools MCP currently ${detected.chromeVersionLabel ?? 'latest'}.`,
          default: DEFAULT_MCP_SETTINGS_JSON,
          rows: 14,
        },
        ...(detected.cliSupportsLsp
          ? [
              {
                type: 'multi-select' as const,
                id: 'lspLanguages',
                label: 'LSP language servers',
                description:
                  'Pick one or more language servers to install. Leave empty to skip LSP installation.',
                options: lspOptions,
                defaults: defaultLspForLanguage(detected.primaryLanguage),
              },
            ]
          : []),
        {
          type: 'checkbox',
          id: 'rtkEnabled',
          label: 'Enable RTK token-saving proxy',
          description: `Routes common dev commands (git, npm, docker, tests, etc.) through rtk, compressing their output 60–90% before it reaches the LLM. Baked into every sandbox; currently rtk ${detected.rtkVersionLabel ?? 'latest'}.`,
          default: detected.rtkEnabled,
        },
        ...(detected.repositoryId
          ? [
              {
                type: 'note' as const,
                id: 'toolingLink',
                label: 'Tooling page',
                body: `Enable/disable components and manage versions for this repository on the [tooling page](/repos/${detected.repositoryId}/tooling) (opens in a new tab).`,
              },
            ]
          : []),
      ],
      submitLabel: 'Save tooling preferences',
    };
  },

  async apply(ctx, args) {
    const tooling: Record<string, unknown> = { ...args.formValues };
    const currentCliMeta = await loadCliProviderMetadata(ctx.db, ctx.cliProviderId);
    const cliSupportsLsp = currentCliMeta?.supportsLsp ?? args.detected.cliSupportsLsp ?? false;
    // A hidden field must not retain a stale selection from a prior CLI. The
    // selected CLI has no LSP bridge, so baking servers into this environment
    // would only invite the model to use tools it cannot access.
    if (!cliSupportsLsp) tooling.lspLanguages = [];
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

    // Persist RTK enable/disable only. RTK/LSP/chrome-devtools-mcp *version*
    // pinning is centralized on the per-repo tooling page, so this step no longer
    // writes rtk_version — an unpinned repo tracks the latest rtk at build.
    const taskRow = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = taskRow[0]?.repositoryId ?? null;
    if (repositoryId) {
      // Mirror tooling prefs onto the repo row (see the onboarding_tooling
      // column) so resolveRagSyncPrefs can read the repo directly instead of
      // hunting the onboarding task's 04 output — which is gone after a clone.
      // The machine-specific infra keys (ollamaUrl, ragConnectionString) stay
      // here for LOCAL use; the committed .haive-data/tooling.json mirror strips
      // them.
      const toolingMirror: OnboardingToolingMirror = {
        schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION,
        tooling,
      };
      await ctx.db
        .update(schema.repositories)
        .set({
          rtkEnabled,
          onboardingTooling: toolingMirror as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
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
