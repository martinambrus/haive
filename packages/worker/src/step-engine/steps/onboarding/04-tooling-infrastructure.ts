import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { buildDefaultMcpServers, buildMcpConfigForCli } from '../../../sandbox/mcp-config.js';
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

    return {
      primaryLanguage: data.project.primaryLanguage,
      framework: data.project.framework ?? 'unknown',
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      hasPhpExtendedExtensions,
      cliDisplayName: cliMeta?.displayName ?? null,
      cliSupportsMcp: cliMeta?.supportsMcp ?? false,
      cliSupportsPlugins: cliMeta?.supportsPlugins ?? false,
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

    return {
      title: 'Tooling and infrastructure',
      description:
        'Configure RAG storage, Ollama embeddings, MCP browser testing and LSP language server preferences for this project.',
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
            'Written verbatim to .claude/mcp_settings.json and passed to Claude Code via --mcp-config. Pre-filled with the Chrome DevTools MCP server used by browser-testing workflow steps. Add additional servers inside the mcpServers object (e.g. filesystem, git, postgres). Leave empty to skip writing the file.',
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
      ],
      submitLabel: 'Save tooling preferences',
    };
  },

  async apply(ctx, args) {
    const tooling: Record<string, unknown> = { ...args.formValues };
    if (tooling.ollamaMode === 'internal') {
      tooling.ollamaUrl = 'http://ollama:11434';
    }
    ctx.logger.info({ tooling }, 'tooling preferences saved');
    return { tooling };
  },
};
