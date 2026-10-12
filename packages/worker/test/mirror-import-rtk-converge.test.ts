import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { RTK_ENABLED_UNIT, conflictSide } from '@haive/shared/project-state';
import { persistDetection } from '../src/repo/clone.js';

vi.mock('../src/project-state/rtk-conflict.js', () => ({ raiseRtkQuestion: vi.fn() }));
vi.mock('../src/project-state/sync.js', () => ({
  syncProjectStateFromCheckout: vi.fn(async () => ({ outcome: 'unchanged' })),
}));
vi.mock('../src/plan/mirror.js', () => ({
  importPlanMirror: vi.fn(async () => ({ imported: false, code: 'no_mirror', reason: 'none' })),
  recordPlanMirrorError: vi.fn(),
}));

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scan(rtkEnabled: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'mirror-rtk-'));
  dirs.push(root);
  await mkdir(join(root, '.haive-data'));
  await writeFile(
    join(root, '.haive-data/tooling.json'),
    JSON.stringify({ schemaVersion: 1, tooling: { ragMode: 'none', rtkEnabled } }),
  );
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'git_https',
    rtkEnabled: true,
    onboardingTooling: null,
  });
  fake.insert(schema.projectStateConflicts, {
    repositoryId: REPO,
    unit: RTK_ENABLED_UNIT,
    base: conflictSide(true),
    local: conflictSide(true),
    incoming: conflictSide(false),
  });
  await persistDetection(fake.db as unknown as Database, REPO, root);
  return fake;
}

describe('the mirror import writing rtk_enabled and a pending RTK question', () => {
  it('closes the question as converged when the mirror switches RTK off', async () => {
    const fake = await scan(false);

    expect(fake.rows(schema.repositories)[0]!.rtkEnabled).toBe(false);
    expect(fake.rows(schema.projectStateConflicts)[0]).toMatchObject({ resolution: 'converged' });
  });

  it('leaves it pending when the mirror leaves RTK on', async () => {
    const fake = await scan(true);

    expect(fake.rows(schema.repositories)[0]!.rtkEnabled).toBe(true);
    expect(fake.rows(schema.projectStateConflicts)[0]).toMatchObject({ resolution: null });
  });
});
