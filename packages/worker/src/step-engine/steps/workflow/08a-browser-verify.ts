import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { loadAppBootOutput } from './_task-meta.js';

const exec = promisify(execFile);

interface BrowserVerifyDetect {
  available: boolean;
  skipReason: string | null;
  appUrl: string | null;
  browserTesting: boolean;
  appBooted: boolean;
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

  page.on('console', msg => {
    consoleMessages.push({ level: msg.type(), text: msg.text() });
  });

  page.on('requestfailed', req => {
    networkErrors.push(req.url() + ' ' + (req.failure()?.errorText || 'unknown'));
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    consoleMessages.push({ level: 'error', text: 'Navigation failed: ' + err.message });
  }

  const title = await page.title().catch(() => null);
  await browser.close();

  const errors = consoleMessages.filter(m => m.level === 'error').map(m => m.text);
  const warnings = consoleMessages.filter(m => m.level === 'warning').map(m => m.text);

  console.log(JSON.stringify({
    pageTitle: title,
    consoleErrors: errors.slice(0, 50),
    consoleWarnings: warnings.slice(0, 50),
    networkErrors: networkErrors.slice(0, 50),
    passed: errors.length === 0 && networkErrors.length === 0,
  }));
}

run().catch(err => {
  console.error(err.message);
  process.exit(1);
});
`;

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

    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    return boot !== null && boot.booted && !boot.skipped;
  },

  async detect(ctx: StepContext): Promise<BrowserVerifyDetect> {
    const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
    const browserTesting = !!deps.browserTesting;

    const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
    const appBooted = boot !== null && boot.booted && !boot.skipped;
    const appUrl = boot?.appUrl ?? null;

    if (!browserTesting) {
      return {
        available: false,
        skipReason: 'Browser testing not enabled in environment template',
        appUrl: null,
        browserTesting: false,
        appBooted,
      };
    }
    if (!appBooted) {
      return {
        available: false,
        skipReason: 'Application was not booted (app-boot step skipped or failed)',
        appUrl: null,
        browserTesting: true,
        appBooted: false,
      };
    }

    return {
      available: true,
      skipReason: null,
      appUrl,
      browserTesting: true,
      appBooted: true,
    };
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.available) return null;

    return {
      title: 'Browser validation',
      description: [
        `App URL: ${detected.appUrl ?? '(unknown)'}`,
        'Launches headless Chrome to validate the running application.',
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
    if (!detected.available) {
      return {
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
    }

    const values = args.formValues as {
      appUrl?: string;
      checkConsoleErrors?: boolean;
      checkNetworkErrors?: boolean;
    };
    const appUrl = (values.appUrl ?? detected.appUrl ?? 'http://localhost').trim();

    ctx.logger.info({ appUrl }, 'running browser validation');

    try {
      const { stdout, stderr } = await exec('node', ['-e', BROWSER_CHECK_SCRIPT, appUrl], {
        cwd: ctx.workspacePath,
        timeout: 60_000,
        maxBuffer: 5 * 1024 * 1024,
      });

      const report = JSON.parse(stdout.trim()) as {
        pageTitle: string | null;
        consoleErrors: string[];
        consoleWarnings: string[];
        networkErrors: string[];
        passed: boolean;
      };

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
        output: stderr ? stderr.slice(0, 2000) : '',
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ err: message, appUrl }, 'browser validation failed');
      return {
        ran: true,
        skipped: false,
        appUrl,
        consoleErrors: [],
        consoleWarnings: [],
        networkErrors: [],
        pageTitle: null,
        passed: false,
        output: message.slice(0, 2000),
      };
    }
  },
};
