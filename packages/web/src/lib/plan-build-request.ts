import type { buildPlan } from './api-client';

type PlanBuildBody = Parameters<typeof buildPlan>[1];

/** The build request the plan starter sends. The questioner is named only when questions are
 *  asked, since the server remembers it as the user's choice for the next build. */
export function planBuildBody(
  mode: PlanBuildBody['mode'],
  opts: {
    description?: string;
    deferStart?: boolean;
    clarify: boolean;
    plannerCliProviderId: string;
    questionerCliProviderId: string;
  },
): PlanBuildBody {
  return {
    mode,
    clarify: opts.clarify,
    ...(opts.description ? { description: opts.description } : {}),
    ...(opts.deferStart ? { deferStart: true } : {}),
    ...(opts.plannerCliProviderId ? { cliProviderId: opts.plannerCliProviderId } : {}),
    ...(opts.clarify && opts.questionerCliProviderId
      ? { questionerCliProviderId: opts.questionerCliProviderId }
      : {}),
  };
}
