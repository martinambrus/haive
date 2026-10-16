import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  lockNewWorkFenceExclusive,
  lockNewWorkFenceShared,
  locksOutNonAdmins,
  NEW_WORK_FENCE_KEY,
  parseMaintenanceState,
  refusesNewWork,
} from './maintenance.js';

describe('parseMaintenanceState', () => {
  it('accepts every real state', () => {
    expect(parseMaintenanceState('normal')).toBe('normal');
    expect(parseMaintenanceState('draining')).toBe('draining');
    expect(parseMaintenanceState('maintenance')).toBe('maintenance');
  });

  // Fails OPEN, and the direction is the whole point. A wrong guess towards "locked" is a lockout
  // nobody can clear from the UI — the config that decides it is only reachable through an admin
  // route the gate would be refusing. A wrong guess towards "open" is an upgrade running with
  // users still connected, which the operator can see and fix.
  it('falls back to normal on anything it does not recognise', () => {
    expect(parseMaintenanceState(null)).toBe('normal');
    expect(parseMaintenanceState(undefined)).toBe('normal');
    expect(parseMaintenanceState('')).toBe('normal');
    expect(parseMaintenanceState('MAINTENANCE')).toBe('normal');
    expect(parseMaintenanceState('true')).toBe('normal');
  });
});

describe('refusesNewWork', () => {
  // Both non-normal states hold new work. That is why the state has three values rather than
  // two: a drain needs to stop people STARTING things long before it stops letting them in.
  it('holds new tasks while draining as well as during maintenance', () => {
    expect(refusesNewWork('normal')).toBe(false);
    expect(refusesNewWork('draining')).toBe(true);
    expect(refusesNewWork('maintenance')).toBe(true);
  });
});

describe('locksOutNonAdmins', () => {
  it('only full maintenance locks anyone out', () => {
    expect(locksOutNonAdmins('normal')).toBe(false);
    // The distinction that makes draining usable: work already running keeps going and its owner
    // can still watch it.
    expect(locksOutNonAdmins('draining')).toBe(false);
    expect(locksOutNonAdmins('maintenance')).toBe(true);
  });
});

describe('NEW_WORK_FENCE_KEY', () => {
  // Admission and a state transition meet only by hashing this same string for their advisory lock.
  it('is the string both sides hash', () => {
    expect(NEW_WORK_FENCE_KEY).toBe('haive-new-work-fence');
  });
});

describe('the fence statements', () => {
  const sent = async (
    lock: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<void>,
  ) => {
    const queries: SQL[] = [];
    await lock({
      execute: async (query) => {
        queries.push(query);
      },
    });
    return queries.map((query) => new PgDialect().sqlToQuery(query));
  };

  it('takes the shared side as one transaction lock on the key', async () => {
    expect(await sent(lockNewWorkFenceShared)).toMatchObject([
      {
        sql: 'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
        params: [NEW_WORK_FENCE_KEY],
      },
    ]);
  });

  it('takes the exclusive side as one transaction lock on the same key', async () => {
    expect(await sent(lockNewWorkFenceExclusive)).toMatchObject([
      {
        sql: 'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        params: [NEW_WORK_FENCE_KEY],
      },
    ]);
  });
});
