import type { DetectResult, FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from './_helpers.js';
import type { EnvDetectApply } from './01-env-detect.js';

interface EnvDetectData {
  project: {
    name: string;
    framework: string;
    primaryLanguage: string;
    description: string | null;
  };
  container: {
    type: string;
    databaseType: string | null;
    databaseVersion: string | null;
    webserver: string | null;
    docroot: string | null;
  };
  stack: {
    runtimeVersions: Record<string, string>;
  };
  paths: { testPaths: string[] };
  localUrl: string | null;
  testFrameworks: string[];
  buildTool: string | null;
  source: 'llm' | 'deterministic';
}

interface ConfirmationDetect {
  detectedName: string;
  detectedFramework: string;
  detectedLanguage: string;
  containerType: string;
  databaseType: string | null;
  databaseVersion: string | null;
  webserver: string | null;
  docroot: string | null;
  runtimeVersions: Record<string, string>;
  testPaths: string[];
  testFrameworks: string[];
  localUrl: string | null;
  buildTool: string | null;
  projectDescription: string | null;
  source: 'llm' | 'deterministic';
}

function extractEnvDetectData(prev: { detect: unknown; output: unknown }): EnvDetectData {
  // Prefer enriched data from apply output over raw detect output
  const applyOutput = prev.output as EnvDetectApply | null;
  if (applyOutput?.enrichedData) {
    return applyOutput.enrichedData as unknown as EnvDetectData;
  }
  // Fallback to detect output
  const detectResult = prev.detect as DetectResult | null;
  const data = detectResult?.data as unknown as EnvDetectData | undefined;
  return (
    data ?? {
      project: {
        name: 'unknown',
        framework: 'general',
        primaryLanguage: 'unknown',
        description: null,
      },
      container: {
        type: 'none',
        databaseType: null,
        databaseVersion: null,
        webserver: null,
        docroot: null,
      },
      stack: { runtimeVersions: {} },
      paths: { testPaths: [] },
      localUrl: null,
      testFrameworks: [],
      buildTool: null,
      source: 'deterministic',
    }
  );
}

export const detectionConfirmationStep: StepDefinition<
  ConfirmationDetect,
  { confirmed: true; values: Record<string, unknown> }
> = {
  metadata: {
    id: '02-detection-confirmation',
    workflowType: 'onboarding',
    index: 3,
    title: 'Detection confirmation',
    description:
      'Presents detected project information (including LLM-enriched fields) for the user to confirm or override.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ConfirmationDetect> {
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-env-detect');
    const data = prev
      ? extractEnvDetectData(prev)
      : {
          project: {
            name: 'unknown',
            framework: 'general',
            primaryLanguage: 'unknown',
            description: null,
          },
          container: {
            type: 'none',
            databaseType: null,
            databaseVersion: null,
            webserver: null,
            docroot: null,
          },
          stack: { runtimeVersions: {} },
          paths: { testPaths: [] },
          localUrl: null,
          testFrameworks: [],
          buildTool: null,
          source: 'deterministic' as const,
        };

    return {
      detectedName: data.project.name,
      detectedFramework: data.project.framework,
      detectedLanguage: data.project.primaryLanguage,
      containerType: data.container.type,
      databaseType: data.container.databaseType,
      databaseVersion: data.container.databaseVersion,
      webserver: data.container.webserver,
      docroot: data.container.docroot,
      runtimeVersions: data.stack.runtimeVersions ?? {},
      testPaths: data.paths.testPaths,
      testFrameworks: data.testFrameworks ?? [],
      localUrl: data.localUrl,
      buildTool: data.buildTool,
      projectDescription: data.project.description,
      source: data.source,
    };
  },

  form(_ctx, detected): FormSchema {
    const summaryParts = [
      `Project: ${detected.detectedName}`,
      `Framework: ${detected.detectedFramework}`,
      `Language: ${detected.detectedLanguage}`,
      `Container: ${detected.containerType}`,
    ];
    if (detected.databaseType) {
      summaryParts.push(
        `Database: ${detected.databaseType}${detected.databaseVersion ? ` ${detected.databaseVersion}` : ''}`,
      );
    } else {
      summaryParts.push('Database: not detected');
    }
    if (detected.webserver) summaryParts.push(`Webserver: ${detected.webserver}`);
    if (detected.docroot) summaryParts.push(`Docroot: ${detected.docroot}`);
    const rtVersions = Object.entries(detected.runtimeVersions);
    if (rtVersions.length > 0) {
      summaryParts.push(`Runtimes: ${rtVersions.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    if (detected.testFrameworks.length > 0) {
      summaryParts.push(`Test frameworks: ${detected.testFrameworks.join(', ')}`);
    }
    summaryParts.push(
      `Test paths: ${detected.testPaths.length > 0 ? detected.testPaths.join(', ') : 'none'}`,
    );
    if (detected.buildTool) summaryParts.push(`Build tool: ${detected.buildTool}`);
    summaryParts.push(`Detection source: ${detected.source}`);

    return {
      title: 'Confirm detected project information',
      description: summaryParts.join('\n'),
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
          default: detected.localUrl ?? undefined,
          placeholder: detected.localUrl ? undefined : 'https://my-project.ddev.site',
        },
        {
          type: 'text',
          id: 'databaseType',
          label: 'Database type',
          default: detected.databaseType ?? undefined,
          placeholder: detected.databaseType ? undefined : 'postgres, mysql, mariadb...',
        },
        {
          type: 'text',
          id: 'databaseVersion',
          label: 'Database version',
          default: detected.databaseVersion ?? undefined,
          placeholder: detected.databaseVersion ? undefined : '17, 8.0, 11.4...',
        },
        {
          type: 'text',
          id: 'webserver',
          label: 'Webserver',
          default: detected.webserver ?? undefined,
          placeholder: detected.webserver ? undefined : 'nginx, apache...',
        },
        {
          type: 'text',
          id: 'testFrameworks',
          label: 'Test frameworks (comma-separated)',
          default:
            detected.testFrameworks.length > 0 ? detected.testFrameworks.join(', ') : undefined,
          placeholder: 'phpunit, playwright, jest...',
        },
        {
          type: 'text',
          id: 'buildTool',
          label: 'Build tool',
          default: detected.buildTool ?? undefined,
          placeholder: detected.buildTool ? undefined : 'vite, webpack, turbo...',
        },
        {
          type: 'textarea',
          id: 'projectDescription',
          label: 'Project description (1-2 sentences)',
          default: detected.projectDescription ?? undefined,
          rows: 3,
          required: true,
        },
      ],
      submitLabel: 'Confirm and continue',
    };
  },

  async apply(ctx, args) {
    ctx.logger.info({ values: args.formValues }, 'detection confirmed');
    return { confirmed: true, values: args.formValues };
  },
};
