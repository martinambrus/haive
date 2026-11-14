import { FIX_LOOP_ACTION_FIELD, type FormSchema } from '@haive/shared';
import type { CliProviderRecord } from '../../../cli-adapters/types.js';

// The gate's form field and its constants live apart from the dispatch checks in
// _fix-round-cli.ts: _fix-loop.ts needs only these, and importing the dispatcher from
// there closes an import cycle back through the step modules that read _fix-loop.ts at load.

/** The implementation step every fix round re-enters. Kept here so the form builder
 * and dispatch lookup share it without importing the gate/diagnosis module. */
export const FIX_LOOP_TARGET_STEP_ID = '07-phase-2-implement';

export const FIX_ROUND_CLI_FIELD = 'fixRoundCliProviderId';

/** A separate slot leaves the task's ordinary step/seat choices intact. The exact round
 * lookup expires it after that round, while a recovery or Retry of that round keeps it. */
export const fixRoundCliRole = (round: number): string => `fix:${round}:default`;

export interface FixRoundCliOptions {
  round: number;
  providers: Pick<CliProviderRecord, 'id' | 'label'>[];
}

export function fixRoundCliField(options?: FixRoundCliOptions): FormSchema['fields'][number] {
  return {
    type: 'select',
    id: FIX_ROUND_CLI_FIELD,
    label: 'CLI for the next implementation fix',
    description: options?.providers.length
      ? 'Applies only to the implementation step in the next fix round of this task. ' +
        'Your worktree is kept. Later rounds use your existing CLI choices.'
      : 'No enabled CLI is eligible for the next fix round; your existing CLI choice will be used.',
    default: 'same',
    options: [
      { value: 'same', label: 'The same CLI' },
      ...(options?.providers ?? []).map((p) => ({ value: p.id, label: p.label })),
    ],
    visibleWhen: { field: FIX_LOOP_ACTION_FIELD, equals: 'continue' },
  };
}
