import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import type { EnvDetectApply } from './01-env-detect.js';

interface ToolingDetect {
  primaryLanguage: string;
  framework: string;
  containerType: string;
  databaseType: string | null;
  hasPhpExtendedExtensions: boolean;
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
  { value: 'none', label: 'Skip LSP installation' },
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

function defaultLspForLanguage(lang: string, framework: string, hasPhpExtended: boolean): string {
  switch (lang) {
    case 'php':
      return hasPhpExtended || PHP_EXTENDED_FRAMEWORKS.has(framework) ? 'php-extended' : 'php';
    case 'javascript':
    case 'typescript':
      return 'typescript';
    case 'python':
      return 'python';
    case 'go':
      return 'go';
    case 'rust':
      return 'rust';
    default:
      return 'none';
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

    return {
      primaryLanguage: data.project.primaryLanguage,
      framework: data.project.framework ?? 'unknown',
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      hasPhpExtendedExtensions,
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
          type: 'text',
          id: 'ollamaUrl',
          label: 'Ollama API URL',
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
          type: 'checkbox',
          id: 'mcpEnabled',
          label: 'Enable Chrome DevTools MCP browser testing',
          default: false,
        },
        {
          type: 'select',
          id: 'lspLanguage',
          label: 'LSP language server',
          options: LSP_OPTIONS,
          default: defaultLspForLanguage(
            detected.primaryLanguage,
            detected.framework,
            detected.hasPhpExtendedExtensions,
          ),
        },
        {
          type: 'textarea',
          id: 'installNotes',
          label: 'Notes for the installation step (optional)',
          rows: 3,
        },
      ],
      submitLabel: 'Save tooling preferences',
    };
  },

  async apply(ctx, args) {
    const tooling = args.formValues;
    ctx.logger.info({ tooling }, 'tooling preferences saved');
    return { tooling };
  },
};
