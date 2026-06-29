import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema, ExecutionPath } from '@haive/shared';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { parseConfigRecommendation, markRecommended } from './_gate1-recommendation.js';
import { buildBrowserModeOptions } from './_browser-modes.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { keepForPath } from '../../../orchestrator/execution-paths.js';

// Run configuration — split out of 06-gate-1-spec-approval so the spec approve/reject
// decision stays uncluttered (a reject revises back to 04 and never reaches this step).
// Runs only after the spec is approved, before 06a-db-migrate (the first consumer of the
// pre-answers it writes). Always gated — the user decides the run config every time; it
// never auto-submits. Records the front-loaded answers for the hands-free stretch to
// Gate 2 into tasks.pre_answers + the task run-config columns.

interface RunConfigDetect {
  /** Approved spec body (markdown), used only to ground the recommendation LLM. */
  specBody: string;
  /** Whether the workspace has a .ddev config — gates the mcp/interactive
   *  browser-verification options (same probe 08a uses at its own detect). */
  ddevMode: boolean;
  /** Non-DDEV containerized runtime (env-replicate app-runner with browser testing) —
   *  also offers mcp/interactive. Best-effort here; 08a re-checks authoritatively. */
  appRunnerMode: boolean;
  /** Current task-level adversarial-QA column, used as the form default so an API-set
   *  value survives into the picker. */
  taskAdversarialQaLevel: string | null;
  /** Current task-level max-fix-rounds (the fix-loop cap), used as the form default. */
  taskMaxFixRounds: number;
  /** Whether 08a-browser-verify runs under this task's execution path. When false
   *  (e.g. plan_tasklist) the browser-verification options are dead UI and omitted —
   *  gate-2's live browser is independent (gated on the env browserTesting flag). */
  runsBrowserVerify: boolean;
  /** Whether 08d-adversarial-qa runs under this path. When false the QA-level control
   *  still shows (08c-code-review reads the level for its extra review lenses) but is
   *  relabelled to "Code review depth" — only the lenses apply, not the Phase 7 agents. */
  runsAdversarialQa: boolean;
  /** Whether the global direct-browser-access feature is on, so the browser-mode
   *  picker can offer `direct` (manual testing in the user's own browser). */
  directAvailable: boolean;
  /** Whether the global direct-database-access feature is on AND this task has a DDEV
   *  runtime, so the form can offer the per-task db-port opt-in (DDEV-only feature). */
  dbExposeAvailable: boolean;
  /** Current task-level expose_db_port column, the checkbox default so an API-set or
   *  prior value survives into the form. */
  taskExposeDbPort: boolean;
}

/** Front-loaded run answers for the hands-free stretch to Gate 2 (browser/MCP mode,
 *  test action, verify slots, sprint mode). Recorded in the step output and written to
 *  tasks.pre_answers. */
interface RunConfig {
  adversarialQaLevel: string;
  simplifyCode: boolean;
  sprintDecision: string;
  sprintAutoResolveConflicts: boolean;
  sprintReviewEnabled: boolean;
  verifyRunTest: boolean;
  verifyRunLint: boolean;
  verifyRunTypecheck: boolean;
  browserMode: string;
  browserCheckConsoleErrors: boolean;
  browserCheckNetworkErrors: boolean;
  testAction: string;
  testRunTests: boolean;
  exposeDbPort: boolean;
  /** Fix-loop cap: automatic fix rounds before the loop escalates to the user. */
  maxFixRounds: number;
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

interface SpecQualityOutput {
  spec?: string;
}

export const runConfigStep: StepDefinition<RunConfigDetect, RunConfig> = {
  metadata: {
    id: '06-run-config',
    workflowType: 'workflow',
    index: 6.05,
    title: 'Run configuration',
    description:
      'Configure the implementation and verification run (adversarial QA, code simplification, sprint mode, verify/browser/test options) applied hands-free from here until Gate 2. Shown only after the spec is approved.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RunConfigDetect> {
    // Same spec precedence as gate-1: post-checkpoint (05a) → 05 amended → 04 draft.
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as SpecQualityOutput | null) ?? {};
    const resolvedOutput = (resolved?.output as { spec?: string } | null) ?? {};
    const specBody =
      resolvedOutput.spec ?? qualityOutput.spec ?? planOutput.spec ?? planOutput.summary ?? '';

    // ddev probe mirrors 08a's detect. Determines whether the mcp/interactive browser
    // options are offered.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevMode =
      ws !== null && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')));
    // Best-effort app-runner detection: a ready env image with browser testing means 08a
    // will run mcp/interactive INSIDE the app-runner. 08a is authoritative.
    let appRunnerMode = false;
    if (!ddevMode) {
      const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
      const deps = (envTemplate?.declaredDeps as Record<string, unknown> | null) ?? null;
      appRunnerMode = Boolean(
        envTemplate?.status === 'ready' && deps?.browserTesting && envTemplate.imageTag,
      );
    }
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: {
        adversarialQaLevel: true,
        maxFixRounds: true,
        executionPath: true,
        exposeDbPort: true,
      },
    });
    // A null execution_path means triage didn't filter the run (full_workflow): every step runs.
    const execPath = (taskRow?.executionPath ?? 'full_workflow') as ExecutionPath;
    const directAvailable = await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true);
    const dbAvailable = await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true);

    return {
      specBody,
      ddevMode,
      appRunnerMode,
      taskAdversarialQaLevel: taskRow?.adversarialQaLevel ?? null,
      taskMaxFixRounds: taskRow?.maxFixRounds ?? 5,
      runsBrowserVerify: keepForPath('08a-browser-verify', execPath),
      runsAdversarialQa: keepForPath('08d-adversarial-qa', execPath),
      directAvailable,
      dbExposeAvailable: dbAvailable && ddevMode,
      taskExposeDbPort: taskRow?.exposeDbPort ?? false,
    };
  },

  // Best-effort recommendation: read the approved spec and suggest the QA level +
  // browser mode. optional:true so a failed/absent provider never blocks the step
  // (form() degrades to static defaults). Runs before the form so form() can mark
  // the recommended option.
  llm: {
    requiredCapabilities: ['tool_use'],
    optional: true,
    preForm: true,
    timeoutMs: 5 * 60 * 1000,
    skipIf: (args) => (args.detected as RunConfigDetect).specBody.trim().length === 0,
    buildPrompt: (args) => {
      const d = args.detected as RunConfigDetect;
      const browserChoices =
        (d.ddevMode || d.appRunnerMode) && d.runsBrowserVerify
          ? 'mcp | interactive | skip'
          : 'skip';
      return [
        'Recommend the most appropriate post-implementation verification settings for the coding',
        'task described by the specification below. You are ONLY recommending — do not implement.',
        '',
        'Choose:',
        '1. adversarialQaLevel — how much adversarial QA (independent agents attacking the change):',
        '   - "none": trivial / very low risk (docs, copy, a config tweak).',
        '   - "poc": small, localized change.',
        '   - "standard": a typical feature touching app logic, data, or user-facing flows.',
        '   - "enterprise": security/auth/permissions, money or data integrity, or broad blast radius.',
        `2. browserMode — how to verify in a browser (available: ${browserChoices}):`,
        '   - "mcp": UI/frontend change worth automated agent testing in a real browser.',
        '   - "interactive": a UI change you want to verify by hand in the live browser at Gate 2.',
        '   - "skip": no runnable UI (library/CLI/backend), or no browser testing wanted.',
        '   NEVER pick a value outside the available list above.',
        '',
        '=== Specification ===',
        d.specBody.slice(0, 12000) || '(none)',
        '',
        'Emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "adversarialQaLevel": "none|poc|standard|enterprise", "browserMode": "<one available>", "rationale": "<one short line>" }',
      ].join('\n');
    },
    bypassStub: () => ({
      adversarialQaLevel: 'standard',
      browserMode: 'skip',
      rationale: 'bypass stub',
    }),
  },

  form(_ctx, detected, llmOutput): FormSchema {
    // Best-effort LLM recommendation (null when the recommend phase was skipped,
    // failed, or returned garbage). Mark the recommended option + use it as the
    // default; otherwise keep the static defaults.
    const rec = parseConfigRecommendation(llmOutput);
    // When 08d-adversarial-qa is filtered out of this path (e.g. plan_tasklist) the level
    // still drives 08c-code-review's extra lenses, so keep the control but describe it by
    // that effect rather than the Phase-7 agent counts that won't run.
    const qa = markRecommended(
      detected.runsAdversarialQa
        ? [
            { value: 'none', label: 'Skip adversarial QA' },
            { value: 'poc', label: 'POC — 2 agents (quick)' },
            { value: 'standard', label: 'Standard — 4 agents' },
            { value: 'enterprise', label: 'Enterprise — 6 agents' },
          ]
        : [
            { value: 'none', label: 'Basic — no extra review lens' },
            { value: 'poc', label: 'POC — no extra review lens' },
            { value: 'standard', label: 'Standard — adds an operational review lens' },
            { value: 'enterprise', label: 'Enterprise — adds operational + performance lenses' },
          ],
      rec.adversarialQaLevel,
      detected.taskAdversarialQaLevel ?? 'none',
    );
    // Browser verification (08a) filtered out of this path → omit its fields entirely.
    const browser = detected.runsBrowserVerify
      ? markRecommended(
          buildBrowserModeOptions({
            ddevMode: detected.ddevMode,
            appRunnerMode: detected.appRunnerMode,
            directAvailable: detected.directAvailable,
          }),
          rec.browserMode,
          detected.ddevMode || detected.appRunnerMode ? 'mcp' : 'skip',
        )
      : null;
    return {
      title: 'Run configuration',
      description:
        'The spec is approved. Set how the implementation and verification steps run — these answers let them run hands-free until Gate 2 (developer verification). Sensible defaults are pre-filled (with an AI recommendation where available); adjust as needed.',
      fields: [
        {
          type: 'select',
          id: 'adversarialQaLevel',
          label: detected.runsAdversarialQa ? 'Adversarial QA (Phase 7)' : 'Code review depth',
          description: detected.runsAdversarialQa
            ? '2/4/6 adversarial agents attack the implementation before Gate 2. Also sets code-review depth: Standard adds an operational review lens, Enterprise adds a performance lens.'
            : 'Sets the code-review depth for this run (the Phase 7 adversarial agents are skipped on this path): Standard adds an operational review lens, Enterprise adds a performance lens.',
          options: qa.options,
          default: qa.default,
        },
        {
          type: 'checkbox',
          id: 'simplifyCode',
          label: 'AI code simplification pass after implementation (Phase 3.5)',
          default: true,
        },
        {
          type: 'radio',
          id: 'sprintDecision',
          label: 'Implementation mode',
          options: [
            {
              value: 'proceed',
              label: 'Follow the sprint plan (parallel DAG when planned)',
            },
            {
              value: 'use_single_agent',
              label: 'Always use a single implementation agent',
            },
          ],
          default: 'proceed',
        },
        {
          type: 'checkbox',
          id: 'sprintAutoResolveConflicts',
          label: 'Auto-resolve merge conflicts with AI (DAG mode)',
          default: true,
        },
        {
          type: 'checkbox',
          id: 'sprintReviewEnabled',
          label: 'AI-review each issue before merge (DAG mode)',
          default: true,
        },
        {
          type: 'checkbox',
          id: 'verifyRunTest',
          label: 'Verify: run tests',
          default: true,
        },
        {
          type: 'checkbox',
          id: 'verifyRunLint',
          label: 'Verify: run lint',
          default: true,
        },
        {
          type: 'checkbox',
          id: 'verifyRunTypecheck',
          label: 'Verify: run typecheck',
          default: true,
        },
        ...(browser
          ? [
              {
                type: 'radio' as const,
                id: 'browserMode',
                label: 'Browser verification',
                options: browser.options,
                default: browser.default,
              },
              {
                type: 'checkbox' as const,
                id: 'browserCheckConsoleErrors',
                label: 'Browser: check for console errors',
                default: true,
                visibleWhen: { field: 'browserMode', notEquals: 'skip' },
              },
              {
                type: 'checkbox' as const,
                id: 'browserCheckNetworkErrors',
                label: 'Browser: check for failed network requests',
                default: true,
                visibleWhen: { field: 'browserMode', notEquals: 'skip' },
              },
            ]
          : []),
        // Direct database access — an INDEPENDENT opt-in (not tied to the browser mode):
        // exposes this task's DDEV database on a loopback host port so a local DB client
        // can connect while developing. DDEV-only + global-flag-gated via dbExposeAvailable.
        ...(detected.dbExposeAvailable
          ? [
              {
                type: 'checkbox' as const,
                id: 'exposeDbPort',
                label: 'Expose the database port to my machine',
                description:
                  'Publishes this project’s DDEV database on a loopback port (127.0.0.1) so you can connect a local DB client (mysql/psql/DataGrip) while developing. Off by default; independent of the browser option.',
                default: detected.taskExposeDbPort,
              },
            ]
          : []),
        {
          type: 'radio',
          id: 'testAction',
          label: 'Test management',
          options: [
            {
              value: 'manage',
              label: 'Find, update, write & delete tests as needed for this change',
            },
            { value: 'skip', label: 'No test changes needed' },
          ],
          default: 'manage',
        },
        {
          type: 'checkbox',
          id: 'testRunTests',
          label: 'Run the related tests after test changes',
          default: true,
        },
        {
          type: 'select',
          id: 'maxFixRounds',
          label: 'Max automatic fix rounds',
          description:
            'When a downstream step (validate, verify, browser, review, QA, DDEV) finds a blocking defect, the implementation re-runs in fix mode. After this many rounds without resolving, the task pauses for you to decide.',
          options: [
            { value: '3', label: '3 rounds' },
            { value: '5', label: '5 rounds' },
            { value: '10', label: '10 rounds' },
          ],
          default: String(detected.taskMaxFixRounds),
        },
      ],
      submitLabel: 'Save run configuration',
    };
  },

  async apply(ctx, args): Promise<RunConfig> {
    const values = args.formValues as Record<string, unknown>;
    const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
    const bool = (v: unknown, fallback: boolean): boolean =>
      typeof v === 'boolean' ? v : fallback;
    const num = (v: unknown, fallback: number): number => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.floor(n) : fallback;
    };
    const runConfig: RunConfig = {
      adversarialQaLevel: str(values.adversarialQaLevel, 'none'),
      simplifyCode: bool(values.simplifyCode, true),
      sprintDecision: str(values.sprintDecision, 'proceed'),
      sprintAutoResolveConflicts: bool(values.sprintAutoResolveConflicts, true),
      sprintReviewEnabled: bool(values.sprintReviewEnabled, true),
      verifyRunTest: bool(values.verifyRunTest, true),
      verifyRunLint: bool(values.verifyRunLint, true),
      verifyRunTypecheck: bool(values.verifyRunTypecheck, true),
      browserMode: str(values.browserMode, 'skip'),
      browserCheckConsoleErrors: bool(values.browserCheckConsoleErrors, true),
      browserCheckNetworkErrors: bool(values.browserCheckNetworkErrors, true),
      testAction: str(values.testAction, 'manage'),
      testRunTests: bool(values.testRunTests, true),
      exposeDbPort: bool(values.exposeDbPort, false),
      maxFixRounds: num(values.maxFixRounds, 5),
    };

    // Map run-config answers to the downstream steps' exact field ids. The runner
    // auto-submits these in auto-continue mode and pre-fills the forms otherwise.
    // 06a/07 get fixed empty entries so their optional-only forms auto-pass (detect-time
    // defaults win); 08e gets an explicit empty selection so the optional-insights triage
    // never blocks the run.
    const preAnswers: Record<string, Record<string, unknown>> = {
      '06a-db-migrate': {},
      '06b-sprint-planning': {
        decision: runConfig.sprintDecision,
        autoResolveConflicts: runConfig.sprintAutoResolveConflicts,
        reviewEnabled: runConfig.sprintReviewEnabled,
      },
      '07-phase-2-implement': {},
      '08-phase-5-verify': {
        runTest: runConfig.verifyRunTest,
        runLint: runConfig.verifyRunLint,
        runTypecheck: runConfig.verifyRunTypecheck,
      },
      // Propagate the chosen browser mode to BOTH the setup step (whose output
      // 08a-verify / Gate-2 read to drive the live browser + the directAccess flag)
      // and the verify step's own form, so 06 is the single browser-mode source of
      // truth. 06 never auto-submits, so this is the user's explicit choice.
      '08a-browser-setup': {
        mode: runConfig.browserMode,
        checkConsoleErrors: runConfig.browserCheckConsoleErrors,
        checkNetworkErrors: runConfig.browserCheckNetworkErrors,
      },
      '08a-browser-verify': {
        mode: runConfig.browserMode,
        checkConsoleErrors: runConfig.browserCheckConsoleErrors,
        checkNetworkErrors: runConfig.browserCheckNetworkErrors,
      },
      '08b-test-management': {
        action: runConfig.testAction,
        runTests: runConfig.testRunTests,
      },
      '08e-insights-triage': { selectedInsights: [] },
    };

    await ctx.db
      .update(schema.tasks)
      .set({
        simplifyCode: runConfig.simplifyCode,
        adversarialQaLevel:
          runConfig.adversarialQaLevel !== 'none' ? runConfig.adversarialQaLevel : null,
        maxFixRounds: runConfig.maxFixRounds,
        exposeDbPort: runConfig.exposeDbPort,
        preAnswers,
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ runConfig }, 'run configuration recorded for the hands-free stretch');

    return runConfig;
  },
};
