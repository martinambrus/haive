import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { pathExists } from '../onboarding/_helpers.js';
import { loadAppBootOutput, resolveDdevWorkspace } from './_task-meta.js';
import {
  runnerHandleForTask,
  ddevExec,
  runnerExec,
  ensureDdevStarted,
} from '../../../sandbox/ddev-runner.js';

const exec = promisify(execFile);

interface BrowserVerifyDetect {
  available: boolean;
  skipReason: string | null;
  appUrl: string | null;
  browserTesting: boolean;
  appBooted: boolean;
  /** When true the app runs in the per-task DDEV runner, so the headless-Chrome
   *  check runs INSIDE the runner (where <name>.ddev.site resolves). */
  ddevMode: boolean;
  repoSubpath: string | null;
}

interface BrowserVerifyApply {
  ran: boolean;
  skipped: boolean;
  appUrl: string | null;
  consoleErrors: string[];
  consoleWarnings: string[];
  networkErrors: string[];
  pageTitle: string | null;
  passed: boolean;
  output: string;
}

interface BrowserReport {
  pageTitle: string | null;
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
  try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }); }
  catch (err) { consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message }); }
  const title = await page.title().catch(() => null);
  await browser.close();
  const errors = consoleMessages.filter(m => m.level === 'error').map(m => m.text);
  const warnings = consoleMessages.filter(m => m.level === 'warning').map(m => m.text);
  console.log(JSON.stringify({ pageTitle: title, consoleErrors: errors.slice(0, 50), consoleWarnings: warnings.slice(0, 50), networkErrors: networkErrors.slice(0, 50), passed: errors.length === 0 && networkErrors.length === 0 }));
}
run().catch(err => { console.error(err.message); process.exit(1); });
`;

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

/** The DDEV project's primary URL, via `ddev describe -j` inside the runner. */
async function ddevPrimaryUrl(
  handle: ReturnType<typeof runnerHandleForTask>,
): Promise<string | null> {
  const res = await ddevExec(handle, 'describe -j', { timeoutMs: 30_000 });
  if (res.exitCode !== 0) return null;
  const start = res.output.indexOf('{');
  const end = res.output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(res.output.slice(start, end + 1)) as {
      raw?: { primary_url?: string };
    };
    return parsed.raw?.primary_url ?? null;
  } catch {
    return null;
  }
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
      repoSubpath: null as string | null,
      appBooted: false,
      appUrl: null as string | null,
    };

    if (!browserTesting) {
      return {
        ...base,
        available: false,
        skipReason: 'Browser testing not enabled in environment template',
      };
    }

    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    if (ws && (await pathExists(ddevConfigPath(ws.workspace)))) {
      // DDEV path: the runner targets the worktree (where `.ddev` lives). It may
      // not be up yet (a task that just implemented .ddev, where 01c skipped
      // early) — apply boots it via ensureDdevStarted and fails hard if it can't.
      // Surface the URL now only if it already happens to run.
      const url = await ddevPrimaryUrl(runnerHandleForTask(ctx.taskId, ws.repoSubpath));
      return {
        browserTesting: true,
        ddevMode: true,
        repoSubpath: ws.repoSubpath,
        appBooted: url !== null,
        appUrl: url,
        available: true,
        skipReason: null,
      };
    }

    // Legacy path: rely on 01a-app-boot.
    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    const appBooted = boot !== null && boot.booted && !boot.skipped;
    if (!appBooted) {
      return {
        ...base,
        available: false,
        skipReason: 'Application was not booted (app-boot step skipped or failed)',
      };
    }
    return {
      browserTesting: true,
      ddevMode: false,
      repoSubpath: null,
      appBooted: true,
      appUrl: boot?.appUrl ?? null,
      available: true,
      skipReason: null,
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
          : 'Launches headless Chrome to validate the running application.',
      ].join('\n'),
      fields: [
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
        },
        {
          type: 'checkbox',
          id: 'checkNetworkErrors',
          label: 'Check for failed network requests',
          default: true,
        },
      ],
      submitLabel: 'Run browser validation',
    };
  },

  async apply(ctx, args): Promise<BrowserVerifyApply> {
    const detected = args.detected;
    const skipped: BrowserVerifyApply = {
      ran: false,
      skipped: true,
      appUrl: null,
      consoleErrors: [],
      consoleWarnings: [],
      networkErrors: [],
      pageTitle: null,
      passed: false,
      output: detected.skipReason ?? 'skipped',
    };
    if (!detected.available) return skipped;

    const values = args.formValues as {
      appUrl?: string;
      checkConsoleErrors?: boolean;
      checkNetworkErrors?: boolean;
    };
    const appUrlOverride = (values.appUrl ?? '').trim();
    ctx.logger.info({ ddevMode: detected.ddevMode }, 'running browser validation');

    let rawOutput: string;
    let appUrl: string;

    if (detected.ddevMode && detected.repoSubpath) {
      // Boot the (possibly just-implemented) DDEV env. A boot failure THROWS →
      // the step fails and routes back to the developer via the recovery actions
      // (Retry / Retry-with-AI). A correctly-implemented DDEV should always boot.
      await ctx.emitProgress('Ensuring the DDEV environment is up…');
      const handle = await ensureDdevStarted(ctx.taskId, detected.repoSubpath);
      appUrl = appUrlOverride || (await ddevPrimaryUrl(handle)) || 'http://localhost';
      await ctx.emitProgress('Running browser validation…');
      const res = await runnerExec(handle, `node /opt/browser-check.js '${appUrl}'`, {
        timeoutMs: 90_000,
      });
      rawOutput = res.output;
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
        appUrl,
        output: `no report parsed: ${rawOutput.slice(-1500)}`,
      };
    }

    const checkConsole = values.checkConsoleErrors !== false;
    const checkNetwork = values.checkNetworkErrors !== false;
    const passed =
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
      ran: true,
      skipped: false,
      appUrl,
      consoleErrors: report.consoleErrors,
      consoleWarnings: report.consoleWarnings,
      networkErrors: report.networkErrors,
      pageTitle: report.pageTitle,
      passed,
      output: '',
    };
  },
};
