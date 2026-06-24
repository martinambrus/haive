import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { propagateModelHealthCliToTaskDefault } from '../src/routes/tasks/_helpers.js';

/** Records the fluent drizzle calls the helper makes so each test can assert the
 *  exact writes. The helper only ever does update().set().where() (the task
 *  default rewrite) and insert().values() (the audit event via appendTaskEvent),
 *  so the fake supports just those two chains. */
interface Recorded {
  updateCalls: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }>;
  insertCalls: Array<{ table: unknown; values: Record<string, unknown> }>;
}

function makeFakeTx(): { tx: never; recorded: Recorded } {
  const recorded: Recorded = { updateCalls: [], insertCalls: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx: any = {
    update: (table: unknown) => ({
      set: (s: Record<string, unknown>) => ({
        where: async (w: unknown) => {
          recorded.updateCalls.push({ table, set: s, where: w });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        recorded.insertCalls.push({ table, values: v });
      },
    }),
  };
  return { tx: tx as never, recorded };
}

describe('propagateModelHealthCliToTaskDefault', () => {
  it('rewrites tasks.cli_provider_id when a provider is picked on the workflow canary', async () => {
    const { tx, recorded } = makeFakeTx();
    const did = await propagateModelHealthCliToTaskDefault(tx, {
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      stepId: '00-model-health-workflow',
      cliProviderId: 'provider-good',
      by: 'user-1',
    });

    expect(did).toBe(true);
    expect(recorded.updateCalls).toHaveLength(1);
    expect(recorded.updateCalls[0].table).toBe(schema.tasks);
    expect(recorded.updateCalls[0].set.cliProviderId).toBe('provider-good');
    expect(recorded.updateCalls[0].set.updatedAt).toBeInstanceOf(Date);
  });

  it('records a task.cli_provider_changed event naming the originating step', async () => {
    const { tx, recorded } = makeFakeTx();
    await propagateModelHealthCliToTaskDefault(tx, {
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      stepId: '00-model-health-workflow',
      cliProviderId: 'provider-good',
      by: 'user-1',
    });

    expect(recorded.insertCalls).toHaveLength(1);
    expect(recorded.insertCalls[0].table).toBe(schema.taskEvents);
    expect(recorded.insertCalls[0].values).toMatchObject({
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      eventType: 'task.cli_provider_changed',
      payload: { cliProviderId: 'provider-good', via: '00-model-health-workflow', by: 'user-1' },
    });
  });

  it('also fires for the onboarding canary (both pipelines covered)', async () => {
    const { tx, recorded } = makeFakeTx();
    const did = await propagateModelHealthCliToTaskDefault(tx, {
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      stepId: '00-model-health-onboarding',
      cliProviderId: 'provider-good',
      by: 'user-1',
    });

    expect(did).toBe(true);
    expect(recorded.updateCalls).toHaveLength(1);
    expect(recorded.updateCalls[0].set.cliProviderId).toBe('provider-good');
  });

  it('is a no-op on a non-canary step (per-step change must not touch the task default)', async () => {
    const { tx, recorded } = makeFakeTx();
    const did = await propagateModelHealthCliToTaskDefault(tx, {
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      stepId: '07-implement',
      cliProviderId: 'provider-good',
      by: 'user-1',
    });

    expect(did).toBe(false);
    expect(recorded.updateCalls).toEqual([]);
    expect(recorded.insertCalls).toEqual([]);
  });

  it('is a no-op when the canary pref is cleared (no new provider to propagate)', async () => {
    const { tx, recorded } = makeFakeTx();
    const did = await propagateModelHealthCliToTaskDefault(tx, {
      taskId: 'task-1',
      taskStepId: 'step-row-1',
      stepId: '00-model-health-workflow',
      cliProviderId: null,
      by: 'user-1',
    });

    expect(did).toBe(false);
    expect(recorded.updateCalls).toEqual([]);
    expect(recorded.insertCalls).toEqual([]);
  });
});
