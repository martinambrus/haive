import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

export const workflowPrefsStep: StepDefinition<null, { prefs: Record<string, unknown> }> = {
  metadata: {
    id: '06-workflow-prefs',
    workflowType: 'onboarding',
    index: 5,
    title: 'Workflow preferences',
    description:
      'Captures verification level, auto-commit policy, maximum iteration count and any custom notes that all generated agents should know about.',
    requiresCli: false,
  },

  async detect(_ctx: StepContext): Promise<null> {
    return null;
  },

  form(): FormSchema {
    return {
      title: 'Workflow preferences',
      description:
        'Verification level only affects post-generation file verification. It does not control whether LSP, MCP, RAG or skill generation run.',
      fields: [
        {
          type: 'radio',
          id: 'verificationLevel',
          label: 'Verification level',
          default: 'standard',
          options: [
            { value: 'quick', label: 'Quick - file existence checks only' },
            { value: 'standard', label: 'Standard - existence plus content validation' },
            { value: 'comprehensive', label: 'Comprehensive - full cross-reference checks' },
          ],
        },
        {
          type: 'checkbox',
          id: 'autoCommit',
          label: 'Auto-commit generated files when verification passes',
          default: false,
        },
        {
          type: 'number',
          id: 'maxIterations',
          label: 'Maximum self-correction iterations',
          default: 5,
          min: 1,
          max: 50,
          step: 1,
        },
        {
          type: 'textarea',
          id: 'customNotes',
          label: 'General CLI guidelines (written to AGENTS.md)',
          description:
            "Project-wide rules and conventions the CLI must always follow (e.g. coding style, libraries to prefer, do/don't lists). These are appended to AGENTS.md, and CLAUDE.md is set up to import AGENTS.md via a single-line `@AGENTS.md` directive. Existing AGENTS.md / CLAUDE.md content is preserved — your notes are appended.",
          rows: 6,
        },
      ],
      submitLabel: 'Save workflow preferences',
    };
  },

  async apply(ctx, args) {
    ctx.logger.info({ prefs: args.formValues }, 'workflow preferences saved');
    return { prefs: args.formValues };
  },
};
