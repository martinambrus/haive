import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';

interface ToolingDetect {
  primaryLanguage: string;
  containerType: string;
  databaseType: string | null;
}

interface EnvDetectData {
  project: { primaryLanguage: string };
  container: { type: string; databaseType: string | null };
}

const LSP_OPTIONS: { value: string; label: string }[] = [
  { value: 'php', label: 'Intelephense (PHP)' },
  { value: 'typescript', label: 'vtsls (TypeScript / JavaScript)' },
  { value: 'python', label: 'Pyright (Python)' },
  { value: 'go', label: 'gopls (Go)' },
  { value: 'rust', label: 'rust-analyzer (Rust)' },
  { value: 'none', label: 'Skip LSP installation' },
];

function defaultLspForLanguage(lang: string): string {
  switch (lang) {
    case 'php':
      return 'php';
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
      'Captures user preferences for RAG storage, MCP browser testing and LSP language server installation. Actual installation happens later via the dedicated environment replication workflow.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ToolingDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const data = ((prev?.detect as DetectResult | null)?.data as unknown as
      | EnvDetectData
      | undefined) ?? {
      project: { primaryLanguage: 'unknown' },
      container: { type: 'none', databaseType: null },
    };
    return {
      primaryLanguage: data.project.primaryLanguage,
      containerType: data.container.type,
      databaseType: data.container.databaseType,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Tooling and infrastructure',
      description:
        'Configure RAG storage, MCP browser testing and LSP language server preferences for this project.',
      fields: [
        {
          type: 'select',
          id: 'ragMode',
          label: 'RAG embedding storage',
          default: detected.containerType === 'ddev' ? 'ddev' : 'external',
          options: [
            { value: 'ddev', label: 'Use the project DDEV PostgreSQL database' },
            { value: 'external', label: 'Use a separate PostgreSQL database' },
            { value: 'none', label: 'Skip RAG infrastructure' },
          ],
        },
        {
          type: 'text',
          id: 'ragConnectionString',
          label: 'PostgreSQL connection string (only required when "external" is selected)',
          placeholder: 'postgres://user:password@host:5432/database',
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
          default: defaultLspForLanguage(detected.primaryLanguage),
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
