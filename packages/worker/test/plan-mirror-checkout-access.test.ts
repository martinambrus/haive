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
