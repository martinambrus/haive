import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRootClaim, schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { withPlanCheckoutAccess } from '../src/repo/checkout-access-scope.js';
import { gitRun } from '../src/repo/git-exec.js';
import { applyPlanPatch } from '@haive/shared/plan';
import {
  importPlanMirror,
  reconcilePlanFromCheckout,
  stampPlanMirrorHashesAtBoot,
  writePlanMirror,
} from '../src/plan/mirror.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plan-checkout-access-'));
  dirs.push(root);
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeCodeLinks: schema.planNodeCodeLinks,
    planMirrorState: schema.planMirrorState,
    projectStateConflicts: schema.projectStateConflicts,
  });
  const id = randomUUID();
  fake.insert(schema.repositories, {
    id,
    userId: randomUUID(),
    status: 'ready',
    storagePath: root,
  });
  const mirror = {
    schemaVersion: 2,
    nodes: [
      {
        id: randomUUID(),
        parentId: null,
        ordinal: 0,
        title: 'Unverified replacement',
        kind: 'component',
        body: null,
        status: 'todo',
        taskable: false,
      },
    ],
    edges: [],
    codeLinks: [],
  };
  await mkdir(join(root, '.haive-data'));
  await writeFile(join(root, '.haive-data/plan.json'), JSON.stringify(mirror));
  await writeFile(join(root, '.haive-data/plan.md'), 'preserved markdown');
  return { fake, db: fake.db as unknown as Database, id, root };
}

describe('plan mirror checkout admission', () => {
  it.each(
    (['write', 'import', 'reconcile'] as const).flatMap((mode) =>
      (['ready', 'cloning', 'error'] as const).map((status) => [mode, status] as const),
    ),
  )('holds %s before reading an extant %s checkout under a foreign owner', async (mode, status) => {
    const f = await fixture();
    if (mode === 'write')
      await applyPlanPatch(
        f.db,
        { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Local plan' }] },
        { repositoryId: f.id, origin: 'user' },
      );
    const before = await readFile(join(f.root, '.haive-data/plan.json'));
    const owner = await acquireRootClaim(f.db, f.id, 'rebuild');
    f.fake.rows(schema.repositories)[0]!.status = status;
    try {
      const run =
        mode === 'write'
          ? writePlanMirror
          : mode === 'import'
            ? importPlanMirror
            : reconcilePlanFromCheckout;
      await expect(run(f.db, f.id, f.root)).rejects.toMatchObject({
        holdReason: 'checkout_unavailable',
      });
      expect(await readFile(join(f.root, '.haive-data/plan.json'))).toEqual(before);
      expect(await readFile(join(f.root, '.haive-data/plan.md'), 'utf8')).toBe(
        'preserved markdown',
      );
      if (mode !== 'write') expect(f.fake.rows(schema.planNodes)).toHaveLength(0);
    } finally {
      await owner!.release();
    }
  });
});

describe('what a held plan mirror records', () => {
  const state = (f: Awaited<ReturnType<typeof fixture>>) => f.fake.rows(schema.planMirrorState)[0]!;

  it('leaves the revision of a dirty row alone while the hold repeats', async () => {
    const f = await fixture();
    await applyPlanPatch(
      f.db,
      { ops: [{ op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Local plan' }] },
      { repositoryId: f.id, origin: 'user' },
    );
    expect(state(f)).toMatchObject({ revision: 1, writtenRevision: 0 });
    const owner = await acquireRootClaim(f.db, f.id, 'rebuild');
    try {
      for (let tick = 0; tick < 3; tick++)
        await expect(writePlanMirror(f.db, f.id, f.root)).rejects.toMatchObject({
          holdReason: 'checkout_unavailable',
        });
    } finally {
      await owner!.release();
    }
    expect(state(f)).toMatchObject({ revision: 1, writtenRevision: 0 });
    expect(state(f).lastError).toContain('checkout is preparing or unavailable');
  });

  it('makes a clean row dirty, so the sweep retries what was held', async () => {
    const f = await fixture();
    f.fake.insert(schema.planMirrorState, { repositoryId: f.id, revision: 3, writtenRevision: 3 });
    const owner = await acquireRootClaim(f.db, f.id, 'rebuild');
    try {
      await expect(importPlanMirror(f.db, f.id, f.root)).rejects.toMatchObject({
        holdReason: 'checkout_unavailable',
      });
    } finally {
      await owner!.release();
    }
    expect(state(f)).toMatchObject({ revision: 4, writtenRevision: 3 });
    expect(state(f).lastError).toContain('checkout is preparing or unavailable');
  });

  it('writes nothing for a boot stamp that is held, so a clean unstamped row stays clean', async () => {
    const f = await fixture();
    f.fake.insert(schema.planMirrorState, { repositoryId: f.id, revision: 1, writtenRevision: 1 });
    // The fake cannot evaluate the sweep's column-to-column filter, so the candidate list is given.
    const boot = {
      select: () => ({ from: () => ({ where: async () => [{ repositoryId: f.id }] }) }),
      transaction: f.fake.db.transaction.bind(f.fake.db),
    } as unknown as Database;
    const owner = await acquireRootClaim(f.db, f.id, 'rebuild');
    try {
      expect(await stampPlanMirrorHashesAtBoot(boot)).toBe(0);
    } finally {
      await owner!.release();
    }
    expect(state(f)).toMatchObject({ revision: 1, writtenRevision: 1 });
    expect(state(f).syncedHash ?? null).toBeNull();
    expect(state(f).lastError ?? null).toBeNull();
  });
});

it('refuses another Git command after the plan mutation capability is released', async () => {
  const f = await fixture();
  const owner = (await acquireRootClaim(f.db, f.id, 'mutation'))!;
  await withPlanCheckoutAccess({ mode: 'mutation', owner }, async () => {
    await owner.release();
    await expect(gitRun(f.root, ['status'])).rejects.toMatchObject({
      code: 'checkout_unavailable',
    });
  });
});
