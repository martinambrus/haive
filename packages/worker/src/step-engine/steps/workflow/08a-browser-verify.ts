import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { STEP_CLI_ROLES } from '@haive/shared';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { extractFencedJson } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { loadAppBootOutput, resolveDdevWorkspace } from './_task-meta.js';
import { buildBrowserModeOptions } from './_browser-modes.js';
import {
  runnerHandleForTask,
  runnerExec,
  ensureDdevStarted,
  startBrowserDesktop,
  ddevPrimaryUrl,
} from '../../../sandbox/ddev-runner.js';
import {
  ensureAppRunnerStarted,
  appRunnerExec,
  startBrowserDesktop as startAppBrowserDesktop,
} from '../../../sandbox/app-runner.js';

const exec = promisify(execFile);

type BrowserMode = 'headless' | 'interactive' | 'mcp' | 'manual' | 'skip';
const ROLE_TESTER = 'tester';
const ROLE_FIXER = 'fixer';

function roleForIteration(iteration: number): string {
  return iteration % 2 === 0 ? ROLE_TESTER : ROLE_FIXER;
}

interface BrowserVerifyDetect {
  available: boolean;
  skipReason: string | null;
  appUrl: string | null;
  browserTesting: boolean;
  appBooted: boolean;
  /** When true the app runs in the per-task DDEV runner, so the headless-Chrome
   *  check runs INSIDE the runner (where <name>.ddev.site resolves). */
  ddevMode: boolean;
  /** When true the app runs in the per-task (non-DDEV) app-runner container,
   *  which hosts the headed-browser desktop just like the DDEV runner. mcp mode
   *  stays DDEV-only; this enables headless + interactive here. */
  appRunnerMode: boolean;
  /** The env-replicate image tag, needed to (re)start the app-runner. */
  envImageTag: string | null;
  repoSubpath: string | null;
  /** Spec + changed files for the MCP tester / manual-checklist prompts. */
  spec: string;
  implementationFiles: string[];
}

interface TestFailure {
  description: string;
  evidence?: string;
}

interface BrowserVerifyApply {
  ran: boolean;
  skipped: boolean;
  method: BrowserMode;
  appUrl: string | null;
  consoleErrors: string[];
  consoleWarnings: string[];
  networkErrors: string[];
  pageTitle: string | null;
  passed: boolean;
  output: string;
  // MCP / manual extras (empty/null for the probe modes).
  failures: TestFailure[];
  visualVerdict: string | null;
  checklistMarkdown: string | null;
  fixesApplied: string[];
  /** Internal loop bookkeeping (the runner re-applies per pass). */
  source: 'probe' | 'tester' | 'fixer' | 'manual' | 'skip';
}

const testerOutputSchema = z.object({
  passed: z.boolean(),
  failures: z
    .array(z.object({ description: z.string(), evidence: z.string().optional() }))
    .default([]),
  visual_verdict: z.enum(['STYLED', 'NEEDS_POLISH', 'UNSTYLED', 'SKIPPED']).optional(),
  notes: z.string().default(''),
});

const fixerOutputSchema = z.object({
  fixes_made: z.array(z.string()).default([]),
  notes: z.string().default(''),
});

const checklistOutputSchema = z.object({
  checklist_markdown: z.string().default(''),
});

function fencedCandidate(raw: unknown): unknown {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const body = extractFencedJson(raw);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** Parse the MCP tester verdict; null when unparseable (caller treats a parse
 *  miss as a FAILED test so a broken tester never silently passes). */
export function parseBrowserTestOutput(raw: unknown): {
  passed: boolean;
  failures: TestFailure[];
  visualVerdict: string | null;
  notes: string;
} | null {
  const parsed = testerOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return {
    passed: parsed.data.passed,
    failures: parsed.data.failures,
    visualVerdict: parsed.data.visual_verdict ?? null,
    notes: parsed.data.notes,
  };
}

export function parseFixerOutput(raw: unknown): { fixesMade: string[]; notes: string } {
  const parsed = fixerOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return { fixesMade: [], notes: '' };
  return { fixesMade: parsed.data.fixes_made, notes: parsed.data.notes };
}

export function parseChecklistOutput(raw: unknown): string {
  const parsed = checklistOutputSchema.safeParse(fencedCandidate(raw));
  if (parsed.success && parsed.data.checklist_markdown.trim())
    return parsed.data.checklist_markdown;
  // Fall back to the raw text (the agent may have written plain markdown).
  return typeof raw === 'string' ? raw.slice(0, 16_000) : '';
}

/** Latest tester (or probe) pass — its failures drive the fixer + final output. */
function latestTester(previous: StepLoopPassRecord[]): BrowserVerifyApply | null {
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    const out = previous[i]?.applyOutput as BrowserVerifyApply | undefined;
    if (out && out.source === 'tester') return out;
  }
  return null;
}

function accumulatedFixes(previous: StepLoopPassRecord[]): string[] {
  const last = previous[previous.length - 1]?.applyOutput as BrowserVerifyApply | undefined;
  return last?.fixesApplied ?? [];
}

const SEARCH_LADDER = [
  'When you need existing patterns or context, search in this order:',
  '1. `rag_search` FIRST (semantic + lexical over the indexed code and knowledge base),',
  '2. then the relevant `.claude/knowledge_base/` files,',
  '3. then Grep / Read the codebase directly.',
] as const;

// Condensed Visual Inspection Protocol (the onboarded integration-tester agent
// carries the full version; this is the in-prompt fallback so any provider runs
// it even without that file).
const VISUAL_PROTOCOL = [
  'VISUAL INSPECTION PROTOCOL (mandatory for UI changes): for every UI element this change',
  'touched, use the chrome-devtools MCP `evaluate_script` for cheap text/JSON checks:',
  '- Visibility: actually rendered (not display:none/visibility:hidden/opacity:0/offscreen/zero-size).',
  '- Contrast: text meets WCAG AA against its computed background.',
  '- Sibling-style consistency: same visual group shares font/color/spacing/control styling.',
  '- Offscreen controls: no interactive element clipped by overflow or outside the viewport.',
  '- Console errors: no JS errors or uncaught rejections during the flow.',
  'Take screenshots ONLY on a suspected anomaly, saved compressed (webp) to',
  '.claude/tasks/<task>/screenshots/. A visibility/contrast/consistency failure is a BLOCKING test',
  'failure, same as a functional one.',
] as const;

interface BrowserReport {
  pageTitle: string | null;
  httpStatus: number | null;
  consoleErrors: string[];
  consoleWarnings: string[];
  networkErrors: string[];
  passed: boolean;
}

// Legacy host-side check (non-DDEV projects whose app 01a-app-boot booted). The
// DDEV path uses the identical check baked into the runner image
// (packages/worker/docker/ddev-runner/browser-check.js).
const BROWSER_CHECK_SCRIPT = `
const puppeteer = require('puppeteer-core');
async function run() {
  const url = process.argv[2];
  if (!url) { console.error('usage: node script.js <url>'); process.exit(1); }
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const consoleMessages = [];
  const networkErrors = [];
  page.on('console', msg => { consoleMessages.push({ level: msg.type(), text: msg.text() }); });
  page.on('requestfailed', req => { networkErrors.push(req.url() + ' ' + (req.failure()?.errorText || 'unknown')); });
  let httpStatus = null;
  try { const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); httpStatus = resp ? resp.status() : null; }
  catch (err) { consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message }); }
  const title = await page.title().catch(() => null);
  await browser.close();
  const errors = consoleMessages.filter(m => m.level === 'error').map(m => m.text);
  const warnings = consoleMessages.filter(m => m.level === 'warning').map(m => m.text);
  const httpBad = httpStatus !== null && httpStatus >= 400;
  console.log(JSON.stringify({ pageTitle: title, httpStatus: httpStatus, consoleErrors: errors.slice(0, 50), consoleWarnings: warnings.slice(0, 50), networkErrors: networkErrors.slice(0, 50), passed: errors.length === 0 && networkErrors.length === 0 && !httpBad }));
}
run().catch(err => { console.error(err.message); process.exit(1); });
`;

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

/** Pull the single-line JSON report the browser check prints, ignoring any
 *  surrounding noise (ddev/docker exec banners, stderr). */
function extractReport(output: string): BrowserReport | null {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    if (l.startsWith('{') && l.includes('"passed"')) {
      try {
        return JSON.parse(l) as BrowserReport;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export const browserVerifyStep: StepDefinition<BrowserVerifyDetect, BrowserVerifyApply> = {
  metadata: {
    id: '08a-browser-verify',
    workflowType: 'workflow',
    index: 8.5,
    title: 'Phase 5a: Browser validation',
    description: 'Validates the running application via headless Chrome.',
    requiresCli: false,
    cliRoles: STEP_CLI_ROLES['08a-browser-verify'],
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    if (!envTemplate || envTemplate.status !== 'ready') return false;
    const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
    if (!deps?.browserTesting) return false;
    // DDEV-enabled projects run in the per-task runner. `.ddev` lives in the
    // worktree — the implementation may have just written it (add-ddev task).
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await pathExists(ddevConfigPath(ws.workspace)))) return true;
    // Otherwise rely on the legacy 01a-app-boot path.
    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    return boot !== null && boot.booted && !boot.skipped;
  },

  async detect(ctx: StepContext): Promise<BrowserVerifyDetect> {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
    const browserTesting = !!deps.browserTesting;

    const base = {
      browserTesting,
      ddevMode: false,
      appRunnerMode: false,
      envImageTag: null as string | null,
      repoSubpath: null as string | null,
      appBooted: false,
      appUrl: null as string | null,
      spec: '',
      implementationFiles: [] as string[],
    };

    if (!browserTesting) {
      return {
        ...base,
        available: false,
        skipReason: 'Browser testing not enabled in environment template',
      };
    }

    // Spec (05a → 05 → 04 precedence) + changed files for the tester/manual prompts.
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';

    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await pathExists(ddevConfigPath(ws.workspace)))) {
      const implementationFiles = await collectImplementationFiles(ctx, ws.workspace);
      // DDEV path: the runner targets the worktree (where `.ddev` lives). It may
      // not be up yet (a task that just implemented .ddev, where 01c skipped
      // early) — apply boots it via ensureDdevStarted and fails hard if it can't.
      // Surface the URL now only if it already happens to run.
      const url = await ddevPrimaryUrl(runnerHandleForTask(ctx.taskId, ws.repoSubpath));
      return {
        browserTesting: true,
        ddevMode: true,
        appRunnerMode: false,
        envImageTag: null,
        repoSubpath: ws.repoSubpath,
        appBooted: url !== null,
        appUrl: url,
        available: true,
        skipReason: null,
        spec,
        implementationFiles,
      };
    }

    // Legacy / non-DDEV path: rely on 01a-app-boot. A non-DDEV app may run in its
    // per-task app-runner container (01a containerized path), which hosts the
    // headed-browser desktop when the env image was built with browser testing —
    // so headless + interactive run INSIDE that container, like the DDEV runner.
    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    const appBooted = boot !== null && boot.booted && !boot.skipped;
    if (!appBooted) {
      return {
        ...base,
        available: false,
        skipReason: 'Application was not booted (app-boot step skipped or failed)',
      };
    }
    const appRunnerMode = boot?.containerized === true && !!boot.runtimeContainer;
    const appRunnerWs = appRunnerMode
      ? await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath)
      : null;
    return {
      browserTesting: true,
      ddevMode: false,
      appRunnerMode,
      envImageTag: appRunnerMode ? (envTemplate?.imageTag ?? null) : null,
      repoSubpath: appRunnerWs?.repoSubpath ?? null,
      appBooted: true,
      appUrl: boot?.appUrl ?? null,
      available: true,
      skipReason: null,
      spec,
      implementationFiles: await collectImplementationFiles(ctx, ctx.workspacePath),
    };
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.available) return null;
    return {
      title: 'Browser validation',
      description: [
        `App URL: ${detected.appUrl ?? '(unknown)'}`,
        detected.ddevMode
          ? 'Launches headless Chrome INSIDE the DDEV runner to validate the running app.'
          : detected.appRunnerMode
            ? 'Launches headless Chrome INSIDE the app-runner container to validate the running app.'
            : 'Launches headless Chrome to validate the running application.',
      ].join('\n'),
      fields: [
        {
          type: 'radio' as const,
          id: 'mode',
          label: 'Testing method',
          options: buildBrowserModeOptions({
            ddevMode: detected.ddevMode,
            appRunnerMode: detected.appRunnerMode,
          }),
          default: 'headless',
          required: true,
        },
        {
          type: 'text',
          id: 'appUrl',
          label: 'Application URL to validate',
          default: detected.appUrl ?? 'http://localhost',
        },
        {
          type: 'checkbox',
          id: 'checkConsoleErrors',
          label: 'Check for console errors',
          default: true,
          visibleWhen: { field: 'mode', notEquals: 'skip' },
        },
        {
          type: 'checkbox',
          id: 'checkNetworkErrors',
          label: 'Check for failed network requests',
          default: true,
          visibleWhen: { field: 'mode', notEquals: 'skip' },
        },
      ],
      submitLabel: 'Run browser validation',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    // Only the agent modes dispatch a CLI; the probe modes + skip resolve in apply.
    skipIf: ({ formValues }) => {
      const mode = (formValues as { mode?: string }).mode;
      return mode !== 'mcp' && mode !== 'manual';
    },
    // mcp mode needs the runner's headed browser up so chrome-devtools connects
    // to the SAME browser the user watches. Idempotent (pgrep-guarded).
    prepare: async ({ ctx, detected, formValues }) => {
      const d = detected as BrowserVerifyDetect;
      if ((formValues as { mode?: string }).mode !== 'mcp') return;
      if (!d.repoSubpath) return;
      await ctx.emitProgress('Starting the browser desktop for agent testing…');
      // mcp drives the SAME visible browser via chrome-devtools, so the headed
      // desktop must be up — in the DDEV runner OR the env-replicate app-runner.
      if (d.ddevMode) {
        const handle = await ensureDdevStarted(ctx.taskId, d.repoSubpath);
        await startBrowserDesktop(handle);
      } else if (d.appRunnerMode && d.envImageTag) {
        const handle = await ensureAppRunnerStarted(ctx.taskId, d.repoSubpath, d.envImageTag);
        await startAppBrowserDesktop(handle);
      }
    },
    buildPrompt: (args) => {
      const d = args.detected as BrowserVerifyDetect;
      const mode = (args.formValues as { mode?: string; appUrl?: string }).mode;
      const appUrl = (args.formValues as { appUrl?: string }).appUrl || d.appUrl || 'the app URL';
      if (mode === 'manual') return buildChecklistPrompt(d, appUrl);
      return buildTesterPrompt(d, appUrl);
    },
    bypassStub: (args) => {
      const mode = (args.formValues as { mode?: string }).mode;
      if (mode === 'manual') return { checklist_markdown: '# Test checklist\n- [ ] bypass stub' };
      return { passed: true, failures: [], visual_verdict: 'SKIPPED', notes: 'bypass stub' };
    },
  },

  loop: {
    // mcp mode only: tester <-> fixer up to 10 rounds (legacy cap), then gate-2
    // escalates. Manual/probe modes never set passed=false from a tester pass,
    // so shouldContinue stays false and they run a single pass.
    maxIterations: 10,
    passesPerRound: 2,
    resolveRole: roleForIteration,
    shouldContinue: ({ applyOutput, iteration }) => {
      if (roleForIteration(iteration) === ROLE_FIXER) return true; // after a fix, re-test
      const out = applyOutput as BrowserVerifyApply;
      return out.method === 'mcp' && out.source === 'tester' && out.passed === false;
    },
    buildIterationPrompt: ({ detected, formValues, iteration, previousIterations }) => {
      const d = detected as BrowserVerifyDetect;
      const appUrl = (formValues as { appUrl?: string }).appUrl || d.appUrl || 'the app URL';
      if (roleForIteration(iteration) === ROLE_FIXER) {
        const prior = latestTester(previousIterations);
        return buildFixerPrompt(d, prior?.failures ?? []);
      }
      return buildTesterPrompt(d, appUrl); // re-test after a fix
    },
  },

  async apply(ctx, args): Promise<BrowserVerifyApply> {
    const detected = args.detected;
    const mode = ((args.formValues as { mode?: string }).mode ?? 'headless') as BrowserMode;
    const baseApply = {
      consoleErrors: [],
      consoleWarnings: [],
      networkErrors: [],
      pageTitle: null,
      failures: [] as TestFailure[],
      visualVerdict: null as string | null,
      checklistMarkdown: null as string | null,
      fixesApplied: [] as string[],
    };
    const skipped: BrowserVerifyApply = {
      ...baseApply,
      ran: false,
      skipped: true,
      method: mode,
      appUrl: null,
      passed: false,
      output: detected.skipReason ?? 'skipped',
      source: 'skip',
    };
    if (!detected.available) return skipped;

    // User chose to skip browser testing (legacy Option C).
    if (mode === 'skip') {
      ctx.logger.info('browser testing skipped by user');
      return { ...skipped, ran: true, skipped: true, output: 'skipped by user', passed: true };
    }

    // Manual checklist (legacy Option B): the agent generated it; gate-2 is the
    // confirmation. A checklist is not a pass/fail — record it, pass through.
    if (mode === 'manual') {
      const checklist = parseChecklistOutput(args.llmOutput ?? null);
      ctx.logger.info({ length: checklist.length }, 'manual test checklist generated');
      return {
        ...baseApply,
        ran: true,
        skipped: false,
        method: 'manual',
        appUrl: detected.appUrl,
        checklistMarkdown: checklist,
        passed: true,
        output: '',
        source: 'manual',
      };
    }

    // MCP agent testing (legacy Option A): tester/fixer loop.
    if (mode === 'mcp') {
      return applyMcp(ctx, args, detected);
    }
    // Probe modes (headless / interactive) fall through to the probe below.

    const values = args.formValues as {
      mode?: string;
      appUrl?: string;
      checkConsoleErrors?: boolean;
      checkNetworkErrors?: boolean;
    };
    const appUrlOverride = (values.appUrl ?? '').trim();
    const interactive = values.mode === 'interactive';
    ctx.logger.info({ ddevMode: detected.ddevMode, interactive }, 'running browser validation');

    let rawOutput: string;
    let appUrl: string;

    if (detected.ddevMode && detected.repoSubpath) {
      // Boot the (possibly just-implemented) DDEV env. A boot failure THROWS →
      // the step fails and routes back to the developer via the recovery actions
      // (Retry / Retry-with-AI). A correctly-implemented DDEV should always boot.
      await ctx.emitProgress('Ensuring the DDEV environment is up…');
      const handle = await ensureDdevStarted(ctx.taskId, detected.repoSubpath);
      appUrl = appUrlOverride || (await ddevPrimaryUrl(handle)) || 'http://localhost';
      if (interactive) {
        // Headed Chrome on the runner's virtual desktop: the user watches and
        // interacts via the web Browser (noVNC) panel while the probe runs the
        // same checks over CDP — and the browser STAYS OPEN afterwards.
        await ctx.emitProgress('Starting the browser desktop…');
        await startBrowserDesktop(handle);
        await ctx.emitProgress('Running browser validation (interactive)…');
        const res = await runnerExec(handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
          timeoutMs: 90_000,
        });
        rawOutput = res.output;
      } else {
        await ctx.emitProgress('Running browser validation…');
        const res = await runnerExec(handle, `node /opt/browser-check.js '${appUrl}'`, {
          timeoutMs: 90_000,
        });
        rawOutput = res.output;
      }
    } else if (detected.appRunnerMode && detected.repoSubpath && detected.envImageTag) {
      // Non-DDEV: the app + the headed-browser desktop live in the per-task
      // app-runner container, so the probe runs INSIDE it (browser hits the app
      // on localhost). Probe scripts were injected at /opt/browser by the runner.
      await ctx.emitProgress('Ensuring the app-runner is up…');
      const handle = await ensureAppRunnerStarted(
        ctx.taskId,
        detected.repoSubpath,
        detected.envImageTag,
      );
      appUrl = appUrlOverride || detected.appUrl || 'http://localhost';
      if (interactive) {
        await ctx.emitProgress('Starting the browser desktop…');
        await startAppBrowserDesktop(handle);
        await ctx.emitProgress('Running browser validation (interactive)…');
        const res = await appRunnerExec(
          handle,
          `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
          { timeoutMs: 90_000 },
        );
        rawOutput = res.output;
      } else {
        await ctx.emitProgress('Running browser validation…');
        const res = await appRunnerExec(handle, `node /opt/browser/browser-check.js '${appUrl}'`, {
          timeoutMs: 90_000,
        });
        rawOutput = res.output;
      }
    } else {
      appUrl = appUrlOverride || detected.appUrl || 'http://localhost';
      try {
        const r = await exec('node', ['-e', BROWSER_CHECK_SCRIPT, appUrl], {
          cwd: ctx.workspacePath,
          timeout: 60_000,
          maxBuffer: 5 * 1024 * 1024,
        });
        rawOutput = r.stdout;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ err: message, appUrl }, 'browser validation failed to run');
        return { ...skipped, ran: true, skipped: false, appUrl, output: message.slice(0, 2000) };
      }
    }

    const report = extractReport(rawOutput);
    if (!report) {
      return {
        ...skipped,
        ran: true,
        skipped: false,
        method: mode,
        appUrl,
        output: `no report parsed: ${rawOutput.slice(-1500)}`,
        source: 'probe',
      };
    }

    const checkConsole = values.checkConsoleErrors !== false;
    const checkNetwork = values.checkNetworkErrors !== false;
    // The HTTP status is ALWAYS enforced — a 4xx/5xx page that renders cleanly must
    // still fail — independent of the optional console/network checks.
    const httpOk = report.httpStatus === null || report.httpStatus < 400;
    const passed =
      httpOk &&
      (!checkConsole || report.consoleErrors.length === 0) &&
      (!checkNetwork || report.networkErrors.length === 0);

    ctx.logger.info(
      {
        pageTitle: report.pageTitle,
        httpStatus: report.httpStatus,
        consoleErrors: report.consoleErrors.length,
        networkErrors: report.networkErrors.length,
        passed,
      },
      'browser validation complete',
    );

    return {
      ...baseApply,
      ran: true,
      skipped: false,
      method: mode,
      appUrl,
      consoleErrors: report.consoleErrors,
      consoleWarnings: report.consoleWarnings,
      networkErrors: report.networkErrors,
      pageTitle: report.pageTitle,
      passed,
      output: '',
      source: 'probe',
    };
  },
};

// --- MCP tester loop apply -------------------------------------------------

async function applyMcp(
  ctx: StepContext,
  args: { iteration: number; llmOutput?: unknown; previousIterations: StepLoopPassRecord[] },
  detected: BrowserVerifyDetect,
): Promise<BrowserVerifyApply> {
  const base = {
    consoleErrors: [],
    consoleWarnings: [],
    networkErrors: [],
    pageTitle: null,
    appUrl: detected.appUrl,
    ran: true,
    skipped: false,
    method: 'mcp' as BrowserMode,
  };

  // Fixer pass: record fixes, carry the prior tester verdict forward (still
  // failing until the next tester pass re-scores).
  if (roleForIteration(args.iteration) === ROLE_FIXER) {
    const fix = parseFixerOutput(args.llmOutput ?? null);
    const prior = latestTester(args.previousIterations);
    ctx.logger.info({ fixes: fix.fixesMade.length }, 'browser-test fixer pass complete');
    return {
      ...base,
      failures: prior?.failures ?? [],
      visualVerdict: prior?.visualVerdict ?? null,
      checklistMarkdown: null,
      fixesApplied: [...accumulatedFixes(args.previousIterations), ...fix.fixesMade],
      passed: false,
      output: '',
      source: 'fixer',
    };
  }

  // Tester pass: parse the verdict. A parse miss = FAILED (never silently pass).
  const verdict = parseBrowserTestOutput(args.llmOutput ?? null);
  const fixesSoFar = accumulatedFixes(args.previousIterations);
  if (!verdict) {
    ctx.logger.warn('browser tester output unparseable — treating as failed');
    return {
      ...base,
      failures: [{ description: 'Tester output could not be parsed; review the raw report.' }],
      visualVerdict: null,
      checklistMarkdown: null,
      fixesApplied: fixesSoFar,
      passed: false,
      output: typeof args.llmOutput === 'string' ? args.llmOutput.slice(-2000) : '',
      source: 'tester',
    };
  }
  const visualFail = verdict.visualVerdict === 'UNSTYLED';
  const passed = verdict.passed && !visualFail;
  ctx.logger.info(
    { passed, failures: verdict.failures.length, visual: verdict.visualVerdict },
    'browser tester pass complete',
  );
  return {
    ...base,
    failures: verdict.failures,
    visualVerdict: verdict.visualVerdict,
    checklistMarkdown: null,
    fixesApplied: fixesSoFar,
    passed,
    output: verdict.notes,
    source: 'tester',
  };
}

// --- Prompt builders -------------------------------------------------------

function buildTesterPrompt(d: BrowserVerifyDetect, appUrl: string): string {
  return [
    'You are the browser integration-tester. Test the implemented feature in a REAL browser using',
    'the chrome-devtools MCP tools (the browser is already running — connect to it).',
    `Application URL: ${appUrl}`,
    'If a `.claude/agents/integration-tester.md` agent definition exists in the repo, follow it;',
    'otherwise follow the protocol below.',
    d.implementationFiles.length > 0
      ? `Changed files (focus your testing here):\n- ${d.implementationFiles.join('\n- ')}`
      : '',
    '',
    'Test the spec acceptance criteria end-to-end from the user perspective. MCP clicks are REAL',
    'tests — if an interaction fails, it is a bug.',
    '',
    ...VISUAL_PROTOCOL,
    '',
    'Do NOT run git. Do NOT edit application code in this pass (a separate fix pass does that).',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "passed": true|false, "failures": [{ "description": "...", "evidence": "file:line or screenshot path" }], "visual_verdict": "STYLED|NEEDS_POLISH|UNSTYLED|SKIPPED", "notes": "" }',
    'passed=false if ANY functional OR blocking visual check failed. visual_verdict SKIPPED for',
    'backend-only changes.',
    '',
    '=== Spec (acceptance criteria) ===',
    d.spec || '(no spec recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildFixerPrompt(d: BrowserVerifyDetect, failures: TestFailure[]): string {
  return [
    'Browser testing found failures in the implemented feature. Fix them by editing the code',
    'directly.',
    failures.length > 0
      ? `Failures to fix:\n${failures.map((f, n) => `${n + 1}. ${f.description}${f.evidence ? ` (evidence: ${f.evidence})` : ''}`).join('\n')}`
      : '(the tester reported a failure without a list — re-read its report and fix what is broken)',
    '',
    'Make ONLY the fixes needed for these failures — do not add unrelated changes. Do NOT run git',
    'and do NOT run the tests yourself (the tester re-verifies next).',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "fixes_made": ["<each fix>"], "notes": "<caveats or empty>" }',
    '',
    '=== Spec (the expected behavior) ===',
    d.spec || '(no spec recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildChecklistPrompt(d: BrowserVerifyDetect, appUrl: string): string {
  return [
    'Generate a structured MANUAL testing checklist for the implemented feature, for a human to',
    'verify by hand in the browser.',
    `Application URL: ${appUrl}`,
    d.implementationFiles.length > 0
      ? `Changed files:\n- ${d.implementationFiles.join('\n- ')}`
      : '',
    '',
    'Cover: 1) pre-test setup (URL, credentials, prerequisites), 2) happy-path tests (step by step),',
    '3) edge cases, 4) error scenarios, 5) visual/UI checks, 6) data validation. Each test has a',
    '`- [ ]` checkbox, clear step-by-step instructions, and an expected result.',
    ...SEARCH_LADDER,
    '',
    'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    '{ "checklist_markdown": "<the full checklist as markdown>" }',
    '',
    '=== Spec (acceptance criteria) ===',
    d.spec || '(no spec recorded)',
  ]
    .filter(Boolean)
    .join('\n');
}
