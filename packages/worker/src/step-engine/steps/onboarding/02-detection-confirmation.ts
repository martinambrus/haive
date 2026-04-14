import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';

interface ConfirmationDetect {
  detectedName: string;
  detectedFramework: string;
  detectedLanguage: string;
  containerType: string;
  databaseType: string | null;
  databaseVersion: string | null;
  testPaths: string[];
}

interface EnvDetectData {
  project: { name: string; framework: string; primaryLanguage: string };
  container: { type: string; databaseType: string | null; databaseVersion: string | null };
  paths: { testPaths: string[] };
}

export const detectionConfirmationStep: StepDefinition<ConfirmationDetect, { confirmed: true }> = {
  metadata: {
    id: '02-detection-confirmation',
    workflowType: 'onboarding',
    index: 3,
    title: 'Detection confirmation',
    description:
      'Presents detected project information for the user to confirm or override, and captures a project description.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ConfirmationDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const data = ((prev?.detect as DetectResult | null)?.data as unknown as
      | EnvDetectData
      | undefined) ?? {
      project: { name: 'unknown', framework: 'general', primaryLanguage: 'unknown' },
      container: { type: 'none', databaseType: null, databaseVersion: null },
      paths: { testPaths: [] },
    };
    return {
      detectedName: data.project.name,
      detectedFramework: data.project.framework,
      detectedLanguage: data.project.primaryLanguage,
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      databaseVersion: data.container.databaseVersion,
      testPaths: data.paths.testPaths,
    };
  },

  form(_ctx, detected): FormSchema {
    const summary = [
      `Project: ${detected.detectedName}`,
      `Framework: ${detected.detectedFramework}`,
      `Language: ${detected.detectedLanguage}`,
      `Container: ${detected.containerType}`,
      detected.databaseType
        ? `Database: ${detected.databaseType}${detected.databaseVersion ? ` ${detected.databaseVersion}` : ''}`
        : 'Database: not detected',
      `Test paths: ${detected.testPaths.length > 0 ? detected.testPaths.join(', ') : 'none'}`,
    ].join('\n');

    return {
      title: 'Confirm detected project information',
      description: summary,
      fields: [
        {
          type: 'text',
          id: 'projectName',
          label: 'Project name',
          default: detected.detectedName,
          required: true,
        },
        {
          type: 'text',
          id: 'framework',
          label: 'Framework',
          default: detected.detectedFramework,
          required: true,
        },
        {
          type: 'text',
          id: 'primaryLanguage',
          label: 'Primary language',
          default: detected.detectedLanguage,
          required: true,
        },
        {
          type: 'text',
          id: 'localUrl',
          label: 'Local development URL',
          placeholder: 'https://my-project.ddev.site',
        },
        {
          type: 'textarea',
          id: 'projectDescription',
          label: 'Project description (1-2 sentences)',
          rows: 3,
          required: true,
        },
      ],
      submitLabel: 'Confirm and continue',
    };
  },

  async apply(ctx, args) {
    ctx.logger.info({ values: args.formValues }, 'detection confirmed');
    return { confirmed: true };
  },
};
