import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { buildBrowserModeOptions } from './_browser-modes.js';
import { resolveBrowserRuntime, type BrowserRuntimeInfo } from './_browser-runtime.js';

/** Browser-test method chosen here. 'mcp' → 08a-browser-verify runs the automated
 *  agent test. 'interactive' → 08a is skipped and the human verifies hands-on in the
 *  live (in-app VNC) browser at Gate 2. 'direct' → like interactive, but the human
 *  tests in their OWN browser via a published URL (no VNC): 08a-verify / Gate-2 run
 *  the interactive gate and surface a directAccess flag instead of the VNC panel.
 *  'skip' → no browser testing at all (Gate 2 hides the live browser too). */
export interface BrowserSetupApply {
  mode: 'mcp' | 'interactive' | 'direct' | 'skip';
  appUrl: string | null;
  checkConsoleErrors: boolean;
  checkNetworkErrors: boolean;
  skipped: boolean;
}

// Setup-only step: pick the browser-test method BEFORE the test step brings the
// live browser up, so the configuration form never sits next to the VNC panel.
// The actual test + the headed-browser gate live in 08a-browser-verify.
export const browserSetupStep: StepDefinition<BrowserRuntimeInfo, BrowserSetupApply> = {
  metadata: {
    id: '08a-browser-setup',
    workflowType: 'workflow',
    index: 8.45,
    title: 'Phase 5a: Browser test method',
    description:
      'Choose how to verify the running app in a browser; the next step brings the browser up.',
    requiresCli: false,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const rt = await resolveBrowserRuntime(ctx);
    return rt.available;
  },

  async detect(ctx: StepContext): Promise<BrowserRuntimeInfo> {
    return resolveBrowserRuntime(ctx);
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.available) return null;
    const hasRuntime = detected.ddevMode || detected.appRunnerMode;
    return {
      title: 'Browser test method',
      description: [
        `App URL: ${detected.appUrl ?? '(unknown)'}`,
        hasRuntime
          ? 'Pick how to verify the app: Automated runs an agent that tests it in the browser now; Manual brings the live browser up at Gate 2 for you to drive; Skip does no browser testing (no live browser at Gate 2 either).'
          : 'No runtime is available to browser-test against, so only Skip is offered.',
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
          default: hasRuntime ? 'mcp' : 'skip',
          required: true,
        },
        {
          type: 'text' as const,
          id: 'appUrl',
          label: 'Application URL to validate',
          default: detected.appUrl ?? 'http://localhost',
        },
        {
          type: 'checkbox' as const,
          id: 'checkConsoleErrors',
          label: 'Check for console errors',
          default: true,
          visibleWhen: { field: 'mode', notEquals: 'skip' },
        },
        {
          type: 'checkbox' as const,
          id: 'checkNetworkErrors',
          label: 'Check for failed network requests',
          default: true,
          visibleWhen: { field: 'mode', notEquals: 'skip' },
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<BrowserSetupApply> {
    const v = args.formValues as {
      mode?: string;
      appUrl?: string;
      checkConsoleErrors?: boolean;
      checkNetworkErrors?: boolean;
    };
    const mode: BrowserSetupApply['mode'] =
      v.mode === 'interactive'
        ? 'interactive'
        : v.mode === 'direct'
          ? 'direct'
          : v.mode === 'skip'
            ? 'skip'
            : 'mcp';
    ctx.logger.info({ mode }, 'browser test method chosen');
    return {
      mode,
      appUrl: (v.appUrl ?? '').trim() || args.detected.appUrl,
      checkConsoleErrors: v.checkConsoleErrors !== false,
      checkNetworkErrors: v.checkNetworkErrors !== false,
      skipped: mode === 'skip',
    };
  },
};
