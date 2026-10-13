import {
  CLI_DISPATCH_STEPS,
  PROVIDER_SENSITIVE_STEP_IDS,
  SKIPPABLE_STEP_IDS,
  STEP_CLI_ROLES,
} from '@haive/shared';
import { schema } from '@haive/database';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import { resetStepFlagsCache, type StepFlags } from '../src/lib/step-flags.js';

const WORKTREE_ENTRY: ComposableStepEntry = {
  stepId: '01-worktree-setup',
  label: 'Worktree setup',
  group: 'setup',
  dispatchesCli: false,
  requires: [{ needs: 'repository', reason: 'Cuts the worktree from the repository.' }],
  provides: ['worktree', 'clean-tree'],
};

const IMPLEMENT_ENTRY: ComposableStepEntry = {
  stepId: '07-phase-2-implement',
  label: 'Implement',
  group: 'implement',
  dispatchesCli: true,
  requires: [{ needs: 'worktree', reason: 'Writes in the worktree.' }],
  provides: ['implementation'],
};

/** The flags a synced catalog holds for the core steps, rebuilt from the shared static lists. */
export function staticStepFlags(): Map<string, StepFlags> {
  const out = new Map<string, StepFlags>();
  const get = (stepId: string): StepFlags => {
    let flags = out.get(stepId);
    if (!flags) {
      flags = {
        stepId,
        title: stepId,
        workflowType: 'workflow',
        allowSkip: false,
        dispatchesStepCli: false,
        providerSensitive: false,
        cliRoles: null,
        stepIndex: null,
        composable: null,
      };
      out.set(stepId, flags);
    }
    return flags;
  };
  CLI_DISPATCH_STEPS.forEach((s, i) => {
    Object.assign(get(s.id), {
      title: s.title,
      workflowType: s.workflowType,
      dispatchesStepCli: true,
      stepIndex: i,
    });
  });
  for (const id of SKIPPABLE_STEP_IDS) get(id).allowSkip = true;
  for (const id of PROVIDER_SENSITIVE_STEP_IDS) get(id).providerSensitive = true;
  for (const [id, roles] of Object.entries(STEP_CLI_ROLES)) get(id).cliRoles = roles;
  get('01-worktree-setup').composable = WORKTREE_ENTRY;
  get('07-phase-2-implement').composable = IMPLEMENT_ENTRY;
  return out;
}

/** Fills a fake db's step_catalog with the static flags, and drops the loader's cache. */
export function seedStepCatalog(fake: {
  insert: (table: typeof schema.stepCatalog, row: Record<string, unknown>) => unknown;
}): void {
  resetStepFlagsCache();
  for (const f of staticStepFlags().values()) {
    fake.insert(schema.stepCatalog, {
      stepId: f.stepId,
      source: 'core',
      title: f.title,
      workflowType: f.workflowType,
      dispatchesCli: f.dispatchesStepCli,
      dispatchesStepCli: f.dispatchesStepCli,
      allowSkip: f.allowSkip,
      providerSensitive: f.providerSensitive,
      cliRoles: f.cliRoles,
      stepIndex: f.stepIndex,
      composable: f.composable !== null,
      entry: f.composable,
    });
  }
}
