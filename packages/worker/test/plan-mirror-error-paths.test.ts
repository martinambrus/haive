import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared/logger';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  PlanMirrorHeldError,
  recordPlanMirrorError,
  recordPlanReconcileFailure,
} from '../src/plan/mirror.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const SERVER_PATH = '/srv/haive/repos/user/private-repo/.haive-data/plan.json';
let db: Database;

beforeEach(() => {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO });
  db = fake.db as unknown as Database;
});
afterEach(() => vi.restoreAllMocks());

async function lastError() {
  const state = await db.query.planMirrorState.findFirst();
  return state?.lastError as string;
}

describe('person-facing plan snapshot errors', () => {
  it.each(['EACCES', 'ENOENT'])(
    'records %s without the server path on insert and update',
    async (code) => {
      const err = Object.assign(new Error(`${code}: cannot open '${SERVER_PATH}'`), {
        code,
        path: SERVER_PATH,
        syscall: 'open',
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        await recordPlanMirrorError(db, REPO, err);
        const message = await lastError();
        expect(message).not.toContain('/srv/');
        expect(message).not.toContain('private-repo');
        expect(message).toContain(code);
        expect(message).toMatch(/plan snapshot/i);
      }
    },
  );

  it('keeps full diagnostics and repository identity in the warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const err = Object.assign(new Error(`EACCES: open '${SERVER_PATH}'`), { code: 'EACCES' });
    await recordPlanMirrorError(db, REPO, err);
    expect(warn).toHaveBeenCalledWith({ err, repositoryId: REPO }, expect.any(String));
  });

  it.each([
    new Error(`git branch failed in /srv/haive/repos/private-repo: failed`),
    new PlanMirrorHeldError(`cannot read '${SERVER_PATH}'`),
    `Plan snapshot not imported: cannot read '${SERVER_PATH}'`,
  ])('does not persist absolute paths from wrapped or textual diagnostics: %s', async (err) => {
    await recordPlanMirrorError(db, REPO, err);
    expect(await lastError()).not.toContain('/srv/');
  });

  it.each([
    new PlanMirrorHeldError('a merge or rebase is open; finish it before saving the plan'),
    'Plan snapshot not imported: the committed plan snapshot is not valid JSON',
    new Error('Database operation failed'),
    new PlanMirrorHeldError('the committed .haive-data/plan.json has a different root'),
  ])('preserves a path-free reason verbatim: %s', async (err) => {
    await recordPlanMirrorError(db, REPO, err);
    expect(await lastError()).toBe(err instanceof Error ? err.message : err);
  });

  it('still hides bound database parameters', async () => {
    const err = new DrizzleQueryError('select $1', ['private-value'], new Error('private-value'));
    await recordPlanMirrorError(db, REPO, err);
    expect(await lastError()).toBe('Database operation failed');
  });

  it('uses the same safe recorder for a failed checkout reconcile and keeps the row dirty', async () => {
    await recordPlanReconcileFailure(db, REPO, new Error(`cannot read '${SERVER_PATH}'`));
    expect(await lastError()).not.toContain('/srv/');
    const state = await db.query.planMirrorState.findFirst();
    expect(state?.revision).toBeGreaterThan(state?.writtenRevision as number);
  });
});
