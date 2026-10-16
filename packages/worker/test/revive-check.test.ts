import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbTx } from '@haive/database';
import { configService, logger } from '@haive/shared';
import { admitReopen, readMaintenanceState } from '../src/queues/_revive-check.js';

const TASK = '00000000-0000-4000-8000-000000000001';

/** A transaction that records what a check sends it, in order, and refuses every write. */
function setup(taskStatus: string | null = 'failed') {
  const log: string[] = [];
  const refuse = (what: string) => () => {
    log.push(what);
    throw new Error(`a reopen check never sends ${what}`);
  };
  const tx = {
    execute: async () => {
      log.push('takes the fence');
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            log.push('reads the task');
            return taskStatus ? [{ status: taskStatus }] : [];
          },
        }),
      }),
    }),
    update: refuse('an update'),
    insert: refuse('an insert'),
    delete: refuse('a delete'),
  };
  /** What the state read answers: a stored value, or an Error that fails the read. */
  const stored = (value: string | null | Error) =>
    vi.spyOn(configService, 'getFresh').mockImplementation(async () => {
      log.push('reads the state');
      if (value instanceof Error) throw value;
      return value;
    });
  return { tx: tx as unknown as DbTx, log, stored };
}

afterEach(() => vi.restoreAllMocks());

describe('admitReopen, the read under the fence', () => {
  it('takes the fence, reads the state under it, and reads nothing else while it is normal', async () => {
    const t = setup();
    t.stored('normal');

    await expect(admitReopen(t.tx, TASK)).resolves.toEqual({ held: false, state: 'normal' });

    expect(t.log).toEqual(['takes the fence', 'reads the state']);
  });

  it('admits when no state is stored, and reports no hold', async () => {
    const t = setup();
    t.stored(null);

    await expect(admitReopen(t.tx, TASK)).resolves.toEqual({ held: false, state: 'normal' });
  });

  it.each(['draining', 'maintenance'])(
    'refuses a failed task while the system is %s',
    async (state) => {
      const t = setup('failed');
      t.stored(state);

      await expect(admitReopen(t.tx, TASK)).rejects.toMatchObject({ name: 'NewWorkHeld', state });

      expect(t.log).toEqual(['takes the fence', 'reads the state', 'reads the task']);
    },
  );

  it.each(['draining', 'maintenance'])(
    'admits a task that is not failed while the system is %s, and reports the hold',
    async (state) => {
      const t = setup('running');
      t.stored(state);

      await expect(admitReopen(t.tx, TASK)).resolves.toEqual({ held: true, state });

      expect(t.log).toEqual(['takes the fence', 'reads the state', 'reads the task']);
    },
  );

  it('reports no hold for a task that is not failed while the system is normal', async () => {
    const t = setup('running');
    t.stored('normal');

    await expect(admitReopen(t.tx, TASK)).resolves.toEqual({ held: false, state: 'normal' });
  });

  it.each(['failed', 'running'])(
    'throws, with no task read and nothing written, when the state of a %s task cannot be read',
    async (status) => {
      const t = setup(status);
      const down = new Error('redis went away');
      t.stored(down);

      await expect(admitReopen(t.tx, TASK)).rejects.toMatchObject({
        name: 'MaintenanceStateUnreadable',
        cause: down,
      });

      expect(t.log).toEqual(['takes the fence', 'reads the state']);
    },
  );
});

describe('readMaintenanceState, the early checks outside the fence', () => {
  it('answers the stored state', async () => {
    setup().stored('draining');

    await expect(readMaintenanceState(TASK)).resolves.toBe('draining');
  });

  it('answers normal and warns when the state cannot be read', async () => {
    setup().stored(new Error('redis went away'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(readMaintenanceState(TASK)).resolves.toBe('normal');

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, err: expect.any(Error) }),
      expect.any(String),
    );
  });
});
