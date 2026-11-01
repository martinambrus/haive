import { afterEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared/logger';
import { PlanMirrorHeldError, recordPlanMirrorError } from '../src/plan/mirror.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const SERVER_PATH = '/srv/private/repo/plan.json';
afterEach(() => vi.restoreAllMocks());
it.each([
  new PlanMirrorHeldError(`cannot read '${SERVER_PATH}'`),
  new PlanMirrorHeldError('a merge or rebase is open'),
  new Error('a path-free failure'),
  new Error(`cannot read '${SERVER_PATH}'`),
])('leaves logging to callers for: %s', async (err) => {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, { id: REPO });
  const warn = vi.spyOn(logger, 'warn');
  await recordPlanMirrorError(fake.db as unknown as Database, REPO, err);
  expect(warn).not.toHaveBeenCalled();
});
