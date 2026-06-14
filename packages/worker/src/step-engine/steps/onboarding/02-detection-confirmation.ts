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
    indicators?: string[];
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
  indicators: string[];
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

const PHP_FRAMEWORKS = new Set(['drupal', 'drupal7', 'laravel', 'wordpress']);
const NODE_FRAMEWORKS = new Set(['nodejs', 'nextjs']);

/** Whether the PHP runtime field is worth asking about — a composer manifest, a
 *  PHP language/framework, or an already-detected PHP version. Reused to gate the
 *  webserver field, which tracks the PHP/DDEV server stack. */
function isPhpRelevant(d: ConfirmationDetect): boolean {
  return (
    d.indicators.includes('composer.json') ||
    d.detectedLanguage === 'php' ||
    PHP_FRAMEWORKS.has(d.detectedFramework) ||
    Boolean(d.runtimeVersions.php)
  );
}

/** A confirmable runtime-version field. Shown only when its language is relevant
 *  to the detected stack (manifest indicator, language, framework, or an
 *  already-detected version), so each project is asked for only its own runtimes
 *  — a pure-Node repo is never asked for PHP, a Rust repo gets a Rust field. */
interface RuntimeFieldSpec {
  id: string;
  label: string;
  runtimeKey: string;
  placeholder: string;
  relevant: (d: ConfirmationDetect) => boolean;
}

const RUNTIME_FIELDS: RuntimeFieldSpec[] = [
  {
    id: 'phpVersion',
    label: 'PHP version',
    runtimeKey: 'php',
    placeholder: '8.3, 7.4, 5.6...',
    relevant: isPhpRelevant,
  },
  {
    id: 'nodeVersion',
    label: 'Node.js version',
    runtimeKey: 'node',
    placeholder: '24, 22, 20...',
    relevant: (d) =>
      d.indicators.includes('package.json') ||
      d.detectedLanguage === 'javascript' ||
      d.detectedLanguage === 'typescript' ||
      NODE_FRAMEWORKS.has(d.detectedFramework) ||
      Boolean(d.runtimeVersions.node),
  },
  {
    id: 'pythonVersion',
    label: 'Python version',
    runtimeKey: 'python',
    placeholder: '3.12, 3.11...',
    relevant: (d) =>
      d.indicators.includes('requirements.txt') ||
      d.indicators.includes('pyproject.toml') ||
      d.detectedLanguage === 'python' ||
      d.detectedFramework === 'python' ||
      d.detectedFramework === 'django' ||
      Boolean(d.runtimeVersions.python),
  },
  {
    id: 'rubyVersion',
    label: 'Ruby version',
    runtimeKey: 'ruby',
    placeholder: '3.3, 3.2...',
    relevant: (d) =>
      d.indicators.includes('Gemfile') ||
      d.detectedLanguage === 'ruby' ||
      d.detectedFramework === 'rails' ||
      Boolean(d.runtimeVersions.ruby),
  },
  {
    id: 'goVersion',
    label: 'Go version',
    runtimeKey: 'go',
    placeholder: '1.22, 1.21...',
    relevant: (d) =>
      d.indicators.includes('go.mod') ||
      d.detectedLanguage === 'go' ||
      d.detectedFramework === 'go' ||
      Boolean(d.runtimeVersions.go),
  },
  {
    id: 'rustVersion',
    label: 'Rust version',
    runtimeKey: 'rust',
    placeholder: '1.75, 1.74...',
    relevant: (d) =>
      d.indicators.includes('Cargo.toml') ||
      d.detectedLanguage === 'rust' ||
      d.detectedFramework === 'rust' ||
      Boolean(d.runtimeVersions.rust),
  },
];

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
      indicators: data.stack.indicators ?? [],
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

    const fields: FormSchema['fields'] = [
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
    ];

    // Runtime version fields, shown only for languages relevant to the detected
    // stack so each project is asked for only its own runtimes. The webserver
    // field tracks the PHP/DDEV server stack unless one was already detected.
    for (const rf of RUNTIME_FIELDS) {
      if (!rf.relevant(detected)) continue;
      const current = detected.runtimeVersions?.[rf.runtimeKey];
      fields.push({
        type: 'text',
        id: rf.id,
        label: rf.label,
        default: current ?? undefined,
        placeholder: current ? undefined : rf.placeholder,
      });
    }
    if (isPhpRelevant(detected) || detected.webserver) {
      fields.push({
        type: 'text',
        id: 'webserver',
        label: 'Webserver',
        default: detected.webserver ?? undefined,
        placeholder: detected.webserver ? undefined : 'nginx, apache...',
      });
    }

    fields.push(
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
    );

    return {
      title: 'Confirm detected project information',
      description: summaryParts.join('\n'),
      fields,
      submitLabel: 'Confirm and continue',
    };
  },

  async apply(ctx, args) {
    ctx.logger.info({ values: args.formValues }, 'detection confirmed');
    return { confirmed: true, values: args.formValues };
  },
};
