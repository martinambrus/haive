import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { STEP_CLI_ROLES } from '@haive/shared';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition, StepLoopPassRecord } from '../../step-definition.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { extractFencedJson } from '../_fenced-json.js';
import { collectImplementationFiles } from './_impl-changes.js';
import { loadAppBootOutput, resolveDdevWorkspace } from './_task-meta.js';
import { resolveBrowserRuntime } from './_browser-runtime.js';
import { ensureAppServing } from './_app-runtime.js';
import { runnerExec, startBrowserDesktop } from '../../../sandbox/ddev-runner.js';
import {
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
  /** Method chosen at 08a-browser-setup (mcp | interactive | skip). */
  mode: BrowserMode;
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
  /** Live headed browser for the interactive gate: brought up + navigated in
   *  detect (idempotent, mirrors 09-gate-2) so the noVNC panel shows the running
   *  app during the form, with the probe verdict to pre-set the approve/reject
   *  default. null when there's no runtime to bring up; available:false on a
   *  bring-up failure (the gate still renders, just without the panel). */
  liveBrowser: {
    available: boolean;
    appUrl: string | null;
    probe: BrowserReport | null;
    reason?: string;
  } | null;
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
  /** Tester's fix-scope judgement on a failed mcp pass (null otherwise): 'trivial'
   *  keeps the in-step fixer loop, 'implementation' stops it so fixLoop escalates. */
  fixScope: 'trivial' | 'implementation' | null;
  /** Internal loop bookkeeping (the runner re-applies per pass). */
  source: 'probe' | 'tester' | 'fixer' | 'manual' | 'skip';
}

const testerOutputSchema = z.object({
  passed: z.boolean(),
  failures: z
    .array(z.object({ description: z.string(), evidence: z.string().optional() }))
    .default([]),
  visual_verdict: z.enum(['STYLED', 'NEEDS_POLISH', 'UNSTYLED', 'SKIPPED']).optional(),
  // On a failure, the tester's judgement of WHERE the fix belongs: 'trivial' = an
  // in-step fixer can patch it (typo/one-liner); 'implementation' = route to the
  // implementation agent. Defaults to 'implementation' so an unjudged fail escalates.
  fix_scope: z.enum(['trivial', 'implementation']).default('implementation'),
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
  fixScope: 'trivial' | 'implementation';
  notes: string;
} | null {
  const parsed = testerOutputSchema.safeParse(fencedCandidate(raw));
  if (!parsed.success) return null;
  return {
    passed: parsed.data.passed,
    failures: parsed.data.failures,
    visualVerdict: parsed.data.visual_verdict ?? null,
    fixScope: parsed.data.fix_scope,
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
  /** HTTP status of the app's main response; null when navigation got NO response
   *  (TLS/connection/DNS error or timeout) → the app was unreachable. Absent on
   *  legacy probe reports written before this field existed. */
  httpStatus?: number | null;
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
  const httpBad = httpStatus !== null && httpStatus >= 500;
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

/** Bring up the per-task headed browser + navigate it to the app for the gate,
 *  mirroring 09-gate-2's live-browser bring-up. Idempotent (ensureAppServing +
 *  pgrep-guarded desktop). Returns the probe verdict so the form pre-sets the
 *  approve/reject default and shows the auto-checks. Best-effort: any failure
 *  yields available:false so the gate still renders, just without the panel. */
async function bringUpLiveBrowser(
  ctx: StepContext,
  detected: Omit<BrowserVerifyDetect, 'liveBrowser'>,
): Promise<BrowserVerifyDetect['liveBrowser']> {
  if (!detected.available || (!detected.ddevMode && !detected.appRunnerMode)) return null;
  try {
    await ctx.emitProgress('Bringing up the browser for verification…');
    const runtime = await ensureAppServing(ctx);
    const appUrl = detected.appUrl || runtime.url || 'http://localhost';
    let probe: BrowserReport | null = null;
    if (runtime.mode === 'ddev') {
      await startBrowserDesktop(runtime.handle);
      const r = await runnerExec(runtime.handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
        timeoutMs: 60_000,
      });
      probe = extractReport(r.output);
    } else if (runtime.mode === 'app-runner') {
      await startAppBrowserDesktop(runtime.handle);
      const r = await appRunnerExec(
        runtime.handle,
        `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
        { timeoutMs: 60_000 },
      );
      probe = extractReport(r.output);
    }
    return { available: true, appUrl, probe };
  } catch (err) {
    ctx.logger.warn({ err }, '08a live browser bring-up failed');
    return {
      available: false,
      appUrl: detected.appUrl,
      probe: null,
      reason: (err as Error).message,
    };
  }
}

/** Build the implementer's diagnosis from an interactive REJECT: the developer's
 *  feedback plus the auto-probe's console/network findings. */
function formatInteractiveReject(out: BrowserVerifyApply): string {
  const parts = [
    'Interactive browser verification was REJECTED by the developer after hands-on testing.',
  ];
  if (out.output.trim()) {
    parts.push('', 'Feedback to address:', out.output.trim());
  } else {
    parts.push(
      '',
      '(no specific feedback given — re-check the implementation against the spec and the errors below)',
    );
  }
  if (out.consoleErrors.length > 0) {
    parts.push(
      '',
      'Console errors observed:',
      ...out.consoleErrors.slice(0, 20).map((e) => `- ${e}`),
    );
  }
  if (out.networkErrors.length > 0) {
    parts.push(
      '',
      'Network errors observed:',
      ...out.networkErrors.slice(0, 20).map((e) => `- ${e}`),
    );
  }
  return parts.join('\n');
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

  // Fix-loop: a failed browser verification routes back to implementation with the
  // observed failures + console/network errors as the diagnosis. Skipped runs pass.
  fixLoop: {
    evaluate: (out) => {
      // Interactive verification is a HUMAN gate: a reject routes via restartLoop
      // (uncapped) below, not the automated fix loop — don't double-fire here.
      if (out.method === 'interactive') return null;
      if (out.skipped || !out.ran || out.passed) return null;
      const parts: string[] = [];
      if (out.failures.length) {
        parts.push(
          '### Failures\n' +
            out.failures
              .map((f) => `- ${f.description}${f.evidence ? ` (${f.evidence})` : ''}`)
              .join('\n'),
        );
      }
      if (out.consoleErrors.length) {
        parts.push(
          '### Console errors\n' +
            out.consoleErrors
              .slice(0, 20)
              .map((e) => `- ${e}`)
              .join('\n'),
        );
      }
      if (out.networkErrors.length) {
        parts.push(
          '### Network errors\n' +
            out.networkErrors
              .slice(0, 20)
              .map((e) => `- ${e}`)
              .join('\n'),
        );
      }
      return {
        blocking: true,
        diagnosis: parts.join('\n\n') || out.output.slice(-2000) || 'Browser verification failed.',
      };
    },
  },

  // Restart-loop: an interactive (human) REJECT restarts from implementation with the
  // developer's feedback + observed errors attached — UNCAPPED, like Gate 2. fixLoop
  // above returns null for interactive, so only one of the two ever fires.
  restartLoop: {
    evaluate: (out) =>
      out.method === 'interactive' && out.ran && !out.passed
        ? { diagnosis: formatInteractiveReject(out) }
        : null,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    if (!envTemplate || envTemplate.status !== 'ready') return false;
    const deps = envTemplate.declaredDeps as Record<string, unknown> | null;
    if (!deps?.browserTesting) return false;
    // Don't run when the user picked Skip at the setup step (08a-browser-setup).
    const setup = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08a-browser-setup');
    if ((setup?.output as { mode?: string } | null)?.mode === 'skip') return false;
    // DDEV-enabled projects run in the per-task runner. `.ddev` lives in the
    // worktree — the implementation may have just written it (add-ddev task).
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await pathExists(ddevConfigPath(ws.workspace)))) return true;
    // Otherwise rely on the legacy 01a-app-boot path.
    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    return boot !== null && boot.booted && !boot.skipped;
  },

  async detect(ctx: StepContext): Promise<BrowserVerifyDetect> {
    const rt = await resolveBrowserRuntime(ctx);
    // Method chosen at 08a-browser-setup; default mcp when a runtime exists (a
    // legacy task created before the split has no setup row).
    const setup = await loadPreviousStepOutput(ctx.db, ctx.taskId, '08a-browser-setup');
    const setupOut = (setup?.output as { mode?: string; appUrl?: string } | null) ?? null;
    const mode = ((setupOut?.mode as BrowserMode | undefined) ??
      (rt.ddevMode || rt.appRunnerMode ? 'mcp' : 'skip')) as BrowserMode;
    const baseDetect = {
      browserTesting: rt.browserTesting,
      ddevMode: rt.ddevMode,
      appRunnerMode: rt.appRunnerMode,
      envImageTag: rt.envImageTag,
      repoSubpath: rt.repoSubpath,
      appBooted: rt.appBooted,
      appUrl: (setupOut?.appUrl ?? '').trim() || rt.appUrl,
      available: rt.available,
      skipReason: rt.skipReason,
      mode,
    };
    if (!rt.available || mode === 'skip') {
      return { ...baseDetect, spec: '', implementationFiles: [], liveBrowser: null };
    }

    // Spec (05a → 05 → 04 precedence) + changed files for the tester prompts.
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';
    const implementationFiles = await collectImplementationFiles(
      ctx,
      rt.workspace ?? ctx.workspacePath,
    );
    const detectedForBringUp = { ...baseDetect, spec, implementationFiles };

    // Bring up the live headed browser for the gate (idempotent; mirrors 09-gate-2).
    // Best-effort — a failure leaves the gate usable, just without the live panel.
    const liveBrowser = await bringUpLiveBrowser(ctx, detectedForBringUp);
    return { ...detectedForBringUp, liveBrowser };
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.available) return null;
    const lb = detected.liveBrowser;
    const probe = lb?.probe ?? null;
    // Pre-set the interactive verdict from the auto-probe: clean → approve; any
    // console/network error or a 5xx → reject (the user can override after looking).
    const probeClean =
      probe != null &&
      probe.consoleErrors.length === 0 &&
      probe.networkErrors.length === 0 &&
      !(probe.httpStatus != null && probe.httpStatus >= 500);
    const infoSections: InfoSection[] = [];
    if (lb && lb.available === false && lb.reason) {
      infoSections.push({
        title: 'Live browser unavailable',
        preview: 'bring-up failed',
        body: `The headed browser could not be brought up:\n\n${lb.reason}\n\nInteractive verification needs the panel — retry the step, or pick automated/skip.`,
        defaultOpen: true,
      });
    } else if (probe) {
      const lines = [
        `**HTTP status:** ${probe.httpStatus ?? '(no response)'}`,
        `**Page title:** ${probe.pageTitle ?? '(none)'}`,
        `**Console errors:** ${probe.consoleErrors.length}`,
        `**Network errors:** ${probe.networkErrors.length}`,
      ];
      if (probe.consoleErrors.length > 0) {
        lines.push(
          '',
          '## Console errors',
          ...probe.consoleErrors.slice(0, 20).map((e) => `- ${e}`),
        );
      }
      if (probe.networkErrors.length > 0) {
        lines.push(
          '',
          '## Network errors',
          ...probe.networkErrors.slice(0, 20).map((e) => `- ${e}`),
        );
      }
      infoSections.push({
        title: 'Automated checks',
        preview: probeClean ? 'clean' : 'issues found',
        body: lines.join('\n'),
        defaultOpen: !probeClean,
      });
    }
    // Automated (mcp): no human input — the agent tests + decides. Auto-submit so
    // the step proceeds straight to the agent; the panel still shows it working.
    if (detected.mode === 'mcp') {
      return {
        title: 'Browser validation (automated)',
        description: `App URL: ${detected.appUrl ?? '(unknown)'}\nAn agent is testing the app in the live browser — watch it in the Browser panel.`,
        ...(infoSections.length > 0 ? { infoSections } : {}),
        fields: [],
        autoSubmit: true,
        submitLabel: 'Run agent testing',
      };
    }
    // Interactive: the human approve/reject gate (the live browser shows above).
    return {
      title: 'Browser validation',
      description: `App URL: ${detected.appUrl ?? '(unknown)'}\nDrive the app in the Browser panel, then Approve or Reject. The automated checks summarized above ran during bring-up.`,
      ...(infoSections.length > 0 ? { infoSections } : {}),
      fields: [
        {
          type: 'radio' as const,
          id: 'decision',
          label: 'Your verdict',
          options: [
            { value: 'approve', label: 'Approve — the app works, proceed' },
            { value: 'reject', label: 'Reject — re-run implementation with my feedback' },
          ],
          default: probeClean ? 'approve' : 'reject',
          required: true,
        },
        {
          type: 'textarea' as const,
          id: 'feedback',
          label: 'Feedback for the implementer (used when you Reject)',
          rows: 4,
        },
      ],
      submitLabel: 'Submit',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    // Only the agent modes dispatch a CLI; the probe modes + skip resolve in apply.
    skipIf: ({ detected }) => {
      const mode = (detected as BrowserVerifyDetect).mode;
      return mode !== 'mcp' && mode !== 'manual';
    },
    // mcp mode needs the runner's headed browser up so chrome-devtools connects
    // to the SAME browser the user watches. Idempotent (pgrep-guarded).
    prepare: async ({ ctx, detected }) => {
      if ((detected as BrowserVerifyDetect).mode !== 'mcp') return;
      await ctx.emitProgress('Starting the browser desktop for agent testing…');
      // mcp drives the SAME visible browser via chrome-devtools, so the app must
      // be serving and the headed desktop up. ensureAppServing boots DDEV /
      // relaunches a restart-killed app-runner process; then start the desktop on
      // whichever runner backs it.
      const runtime = await ensureAppServing(ctx);
      const appUrl = runtime.url || (detected as BrowserVerifyDetect).appUrl || 'http://localhost';
      // Point the visible desktop at the app up front so the user sees the app —
      // not about:blank — while the agent spins up (the agent re-navigates as it
      // tests). Best-effort: a nav miss never blocks the agent.
      if (runtime.mode === 'ddev') {
        await startBrowserDesktop(runtime.handle);
        await runnerExec(runtime.handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
          timeoutMs: 30_000,
        }).catch(() => {});
      } else if (runtime.mode === 'app-runner') {
        await startAppBrowserDesktop(runtime.handle);
        await appRunnerExec(
          runtime.handle,
          `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
          { timeoutMs: 30_000 },
        ).catch(() => {});
      }
    },
    buildPrompt: (args) => {
      const d = args.detected as BrowserVerifyDetect;
      const appUrl = d.appUrl || 'the app URL';
      if (d.mode === 'manual') return buildChecklistPrompt(d, appUrl);
      return buildTesterPrompt(d, appUrl);
    },
    bypassStub: (args) => {
      if ((args.detected as BrowserVerifyDetect).mode === 'manual')
        return { checklist_markdown: '# Test checklist\n- [ ] bypass stub' };
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
      // mcp tester failed: keep the in-step fixer loop ONLY for a trivial bug (a typo /
      // one-liner the tester flagged `trivial`). A substantial failure stops the loop
      // here so fixLoop escalates to the implementation agent (full pipeline re-run).
      return (
        out.method === 'mcp' &&
        out.source === 'tester' &&
        out.passed === false &&
        out.fixScope === 'trivial'
      );
    },
    buildIterationPrompt: ({ detected, iteration, previousIterations }) => {
      const d = detected as BrowserVerifyDetect;
      const appUrl = d.appUrl || 'the app URL';
      if (roleForIteration(iteration) === ROLE_FIXER) {
        const prior = latestTester(previousIterations);
        return buildFixerPrompt(d, prior?.failures ?? []);
      }
      return buildTesterPrompt(d, appUrl); // re-test after a fix
    },
  },

  async apply(ctx, args): Promise<BrowserVerifyApply> {
    const detected = args.detected;
    const mode = detected.mode;
    const baseApply = {
      consoleErrors: [],
      consoleWarnings: [],
      networkErrors: [],
      pageTitle: null,
      failures: [] as TestFailure[],
      visualVerdict: null as string | null,
      checklistMarkdown: null as string | null,
      fixesApplied: [] as string[],
      fixScope: null as 'trivial' | 'implementation' | null,
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

    // Interactive (human gate): detect already brought the browser up + probed, and
    // the user drove it in the panel. The submitted verdict decides — approve
    // advances, reject routes back to implementation via restartLoop. No re-probe;
    // carry detect's probe so gate-2 + the reject diagnosis have the findings.
    if (mode === 'interactive') {
      const decision =
        (args.formValues as { decision?: string }).decision === 'reject' ? 'reject' : 'approve';
      const feedback = ((args.formValues as { feedback?: string }).feedback ?? '').trim();
      const probe = detected.liveBrowser?.probe ?? null;
      ctx.logger.info({ decision }, 'interactive browser verification decision');
      return {
        ...baseApply,
        ran: true,
        skipped: false,
        method: 'interactive',
        appUrl: detected.liveBrowser?.appUrl ?? detected.appUrl,
        consoleErrors: probe?.consoleErrors ?? [],
        networkErrors: probe?.networkErrors ?? [],
        pageTitle: probe?.pageTitle ?? null,
        passed: decision === 'approve',
        output: decision === 'reject' ? feedback : '',
        source: 'probe',
      };
    }
    // Probe mode (headless) falls through to the probe below.

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
    // Ensure the app is actually serving — boots the DDEV env, or brings the
    // app-runner container back AND relaunches a restart-killed dev server — and
    // resolve its authoritative URL. A DDEV boot failure THROWS → the step fails
    // and routes back to the developer via the recovery actions (Retry /
    // Retry-with-AI). A user-entered URL still overrides.
    const runtime = await ensureAppServing(ctx);
    const appUrl = appUrlOverride || runtime.url || detected.appUrl || 'http://localhost';

    if (runtime.mode === 'ddev') {
      if (interactive) {
        // Headed Chrome on the runner's virtual desktop: the user watches and
        // interacts via the web Browser (noVNC) panel while the probe runs the
        // same checks over CDP — and the browser STAYS OPEN afterwards.
        await ctx.emitProgress('Starting the browser desktop…');
        await startBrowserDesktop(runtime.handle);
        await ctx.emitProgress('Running browser validation (interactive)…');
        rawOutput = (
          await runnerExec(runtime.handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
            timeoutMs: 90_000,
          })
        ).output;
      } else {
        await ctx.emitProgress('Running browser validation…');
        rawOutput = (
          await runnerExec(runtime.handle, `node /opt/browser-check.js '${appUrl}'`, {
            timeoutMs: 90_000,
          })
        ).output;
      }
    } else if (runtime.mode === 'app-runner') {
      // Non-DDEV: the app + the headed-browser desktop live in the per-task
      // app-runner container, so the probe runs INSIDE it (browser hits the app
      // on localhost). Probe scripts were injected at /opt/browser by the runner.
      if (interactive) {
        await ctx.emitProgress('Starting the browser desktop…');
        await startAppBrowserDesktop(runtime.handle);
        await ctx.emitProgress('Running browser validation (interactive)…');
        rawOutput = (
          await appRunnerExec(
            runtime.handle,
            `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
            { timeoutMs: 90_000 },
          )
        ).output;
      } else {
        await ctx.emitProgress('Running browser validation…');
        rawOutput = (
          await appRunnerExec(runtime.handle, `node /opt/browser/browser-check.js '${appUrl}'`, {
            timeoutMs: 90_000,
          })
        ).output;
      }
    } else {
      // Legacy host boot (or no runtime handle): host-side puppeteer check.
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

    // Explicit environment-failure handling: when the browser got NO HTTP
    // response (TLS/connection/DNS error or timeout — e.g. an untrusted local
    // DDEV cert, or the app not serving), the app was never reachable. That is
    // not a code defect, so FAIL the step (recovery: Retry / Skip) instead of
    // letting a passed=false route back to implementation via the fix-loop.
    // Guarded on the field's presence so legacy reports keep their prior behavior.
    if ('httpStatus' in report && report.httpStatus === null) {
      throw new Error(
        `Could not reach the app at ${appUrl}: the browser received no HTTP response ` +
          `(TLS/connection error or timeout — e.g. an untrusted local cert, or the app is ` +
          `not serving). This is an environment issue, not a code defect — fix the ` +
          `environment and Retry, or Skip browser validation.`,
      );
    }

    const checkConsole = values.checkConsoleErrors !== false;
    const checkNetwork = values.checkNetworkErrors !== false;
    // A 5xx (server crash — e.g. PHP memory exhaustion) is a hard fail even when no
    // JS console/network error fired; 4xx (401/403/404) are fine for login-gated apps.
    const httpBad = 'httpStatus' in report && report.httpStatus != null && report.httpStatus >= 500;
    const passed =
      !httpBad &&
      (!checkConsole || report.consoleErrors.length === 0) &&
      (!checkNetwork || report.networkErrors.length === 0);

    ctx.logger.info(
      {
        pageTitle: report.pageTitle,
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
    fixScope: null as 'trivial' | 'implementation' | null,
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
      fixScope: 'implementation',
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
    fixScope: passed ? null : verdict.fixScope,
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
    '{ "passed": true|false, "failures": [{ "description": "...", "evidence": "file:line or screenshot path" }], "visual_verdict": "STYLED|NEEDS_POLISH|UNSTYLED|SKIPPED", "fix_scope": "trivial|implementation", "notes": "" }',
    'passed=false if ANY functional OR blocking visual check failed. visual_verdict SKIPPED for',
    'backend-only changes. On a failure, set fix_scope "trivial" ONLY for a tiny self-evident bug',
    '(a JS typo, a one-line logic slip, a wrong CSS value) a focused fixer can patch in place; use',
    '"implementation" for anything needing real design/logic work or spanning multiple files (it',
    'routes back to the implementation agent). When passed=true, fix_scope is ignored.',
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
    'Make ONLY the fixes needed for these failures — do not add unrelated changes. Do NOT run git.',
    '',
    "A chrome-devtools MCP is connected to the running app's browser — the same instance the tester",
    'used. After applying your fix, VERIFY it in the browser via chrome-devtools: navigate to the',
    'affected view, reproduce each failure above, and confirm it is resolved before finishing. If a',
    'fix did not hold, iterate until the browser confirms it; note anything still broken. Do not run',
    'the project test suite — the tester re-checks after you.',
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
