import { CONFIG_KEYS, configService } from '@haive/shared';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

interface ChooseViewDetect {
  /** Own-browser access is offered only when the global direct-access flag is on. */
  directAccessAvailable: boolean;
}

interface ChooseViewApply {
  /** 'vnc' = watch/control the in-app browser; 'direct' = open in the user's own browser. */
  viewMode: 'vnc' | 'direct';
}

/** run_app viewing-mode gate. The user picks ONE surface BEFORE the runtime hold
 *  step (99-run-app-ready) so that step brings up only the chosen surface: VNC
 *  navigates the in-runner headed browser to the app, own-browser does not start
 *  the VNC desktop at all (it only slows the user's own-browser session). Mirrors
 *  08a-browser-setup's interactive-vs-direct choice. */
export const chooseViewStep: StepDefinition<ChooseViewDetect, ChooseViewApply> = {
  metadata: {
    id: '98-choose-view',
    workflowType: 'run_app',
    index: 0,
    title: 'Choose how to view the app',
    description:
      'Pick whether to view the running app in the in-app browser (VNC) or your own browser.',
    requiresCli: false,
  },

  async detect(): Promise<ChooseViewDetect> {
    const directAccessAvailable = await configService.getBoolean(
      CONFIG_KEYS.BROWSER_DIRECT_ACCESS,
      true,
    );
    return { directAccessAvailable };
  },

  form(_ctx: StepContext, detected): FormSchema {
    const options = [
      {
        value: 'vnc',
        label: 'In-app browser (VNC) — watch and control it here; we open it on the app for you',
      },
      ...(detected.directAccessAvailable
        ? [
            {
              value: 'direct',
              label: 'My own browser — open the app via a URL we provide (no in-app VNC)',
            },
          ]
        : []),
    ];
    return {
      title: 'Choose how to view the app',
      description:
        'Pick one. Only the surface you pick is shown on the next screen — the other never starts.',
      fields: [
        {
          type: 'radio' as const,
          id: 'viewMode',
          label: 'Viewing mode',
          options,
          default: 'vnc',
          required: true,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx: StepContext, args): Promise<ChooseViewApply> {
    const v = args.formValues as { viewMode?: string };
    const viewMode: ChooseViewApply['viewMode'] = v.viewMode === 'direct' ? 'direct' : 'vnc';
    ctx.logger.info({ viewMode }, 'run-app viewing mode chosen');
    return { viewMode };
  },
};
