import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { PROJECT_STATE_DIR, settingFileName } from '@haive/shared/project-state';
import { completePreparationImports } from '../src/repo/clone.js';
import { withRepoJobOwner } from '../src/repo/job-owner.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';

vi.mock('../src/project-state/sync.js', () => ({ syncProjectStateFromCheckout: vi.fn() }));
vi.mock('../src/plan/mirror.js', () => ({
  importPlanMirror: vi.fn(async () => ({
    imported: false,
    code: 'no_mirror',
    reason: 'no plan mirror',
  })),
  reconcilePlanFromCheckout: vi.fn(),
  recordPlanMirrorError: vi.fn(),
}));

const dirs: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A checkout holding both the legacy exclusions mirror and the project-state record file for the
 *  same unit, so the legacy import defers that unit to the sync and returns true. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'complete-preparation-held-'));
  dirs.push(root);
  await mkdir(join(root, '.haive-data'));
  await writeFile(
    join(root, '.haive-data/exclusions.json'),
    '{"schemaVersion":1,"scopeExcludeGlobs":["vendor/**"]}',
  );
  const unit = join(root, PROJECT_STATE_DIR, settingFileName('scope-exclude-globs'));
  await mkdir(join(unit, '..'), { recursive: true });
  await writeFile(unit, '{}');
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    planNodes: schema.planNodes,
  });
  const id = randomUUID();
  const jobId = randomUUID();
  fake.insert(schema.repositories, {
    id,
    userId: randomUUID(),
    name: 'acme',
    source: 'blank',
    status: 'ready',
    storagePath: root,
    refreshPending: true,
    refreshJobId: jobId,
  });
  const db = fake.db as unknown as Database;
  const globs = async () =>
    (await db.select().from(schema.repositories).where(eq(schema.repositories.id, id)))[0]!
      .scopeExcludeGlobs;
  const run = () => withRepoJobOwner(id, jobId, () => completePreparationImports(db, id, root));
  return { globs, run };
}

describe('the legacy mirror fallback after a project-state sync', () => {
  it('does not run when the sync was held and never imported the record', async () => {
    const f = await fixture();
    vi.mocked(syncProjectStateFromCheckout).mockResolvedValue({
      outcome: 'held',
      code: 'checkout_unavailable',
    } as never);

    await f.run();

    expect(syncProjectStateFromCheckout).toHaveBeenCalledTimes(1);
    expect(await f.globs()).toBeNull();
  });

  it('runs when the sync finished without a change', async () => {
    const f = await fixture();
    vi.mocked(syncProjectStateFromCheckout).mockResolvedValue({ outcome: 'unchanged' } as never);

    await f.run();

    expect(await f.globs()).toEqual(['vendor/**']);
  });
});
