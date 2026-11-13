import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fault: null as null | ((kind: string, target: string) => Error | undefined),
  clone: vi.fn(async () => {
    throw new Error('unexpected clone');
  }),
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  const wrap =
    (kind: 'open' | 'lstat' | 'readdir') =>
    async (...args: unknown[]) => {
      const err = h.fault?.(kind, String(args[0]));
      if (err) throw err;
      return (real[kind] as (...args: unknown[]) => Promise<unknown>)(...args);
    };
  return { ...real, open: wrap('open'), lstat: wrap('lstat'), readdir: wrap('readdir') };
});
vi.mock('../src/repo/clone.js', async (original) => ({
  ...(await original<typeof import('../src/repo/clone.js')>()),
  gitClone: h.clone,
}));
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { LEGACY_KB_DIR } from '@haive/shared/knowledge-paths';
import { parseBundle } from '../src/bundle-parser/index.js';
import { classifyBundle } from '../src/bundle-parser/classifier.js';
import { handleResyncGit } from '../src/repo/bundle-ingest.js';
import { stampPlanMirrorHashesAtBoot } from '../src/plan/mirror.js';
import { migrateLegacyKnowledge } from '../src/step-engine/steps/onboarding/_kb-legacy.js';
import { checkSkill } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';

let root: string;
const REPO = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const BUNDLE = '00000000-0000-4000-8000-000000000003';
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'fs-resource-'));
  h.clone.mockClear();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(async () => {
  h.fault = null;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const resource = (code: string) =>
  Object.assign(new Error('injected descriptor shortage'), { code });

it.each(['EMFILE', 'ENFILE'])(
  'keeps legacy knowledge when a listing fails with %s',
  async (code) => {
    await mkdir(path.join(root, LEGACY_KB_DIR, 'nested'), { recursive: true });
    const kept = path.join(root, LEGACY_KB_DIR, 'nested/keep.md');
    await writeFile(kept, 'irreplaceable knowledge');
    let listings = 0;
    const err = resource(code);
    h.fault = (kind) => (kind === 'readdir' && ++listings === 2 ? err : undefined);
    await expect(migrateLegacyKnowledge(root)).rejects.toBe(err);
    expect(await readFile(kept, 'utf8')).toBe('irreplaceable knowledge');
  },
);

it.each(['EMFILE', 'ENFILE'])('never wipes and re-clones a bundle on %s', async (code) => {
  const dest = path.join(root, `${USER}/${BUNDLE}/extracted`);
  await mkdir(path.join(dest, '.git'), { recursive: true });
  await writeFile(path.join(dest, 'keep'), 'uncommitted bundle edit');
  const fake = createFakeDb({ customBundles: schema.customBundles });
  fake.insert(schema.customBundles, {
    id: BUNDLE,
    userId: USER,
    repositoryId: REPO,
    sourceType: 'git',
    gitUrl: 'https://example.test/bundle.git',
    storageRoot: dest,
  });
  const err = resource(code);
  let fired = false;
  h.fault = (kind, target) => {
    if (!fired && kind === 'lstat' && target.endsWith('/.git')) {
      fired = true;
      return err;
    }
  };
  await expect(
    handleResyncGit({ bundleId: BUNDLE, userId: USER }, fake.db as unknown as Database, root),
  ).rejects.toBe(err);
  expect(h.clone).not.toHaveBeenCalled();
  expect(await readFile(path.join(dest, 'keep'), 'utf8')).toBe('uncommitted bundle edit');
});

it.each(['EMFILE', 'ENFILE'])('never stamps an unread plan as absent on %s', async (code) => {
  await mkdir(path.join(root, '.haive-data'));
  await writeFile(path.join(root, HAIVE_DATA_FILES.plan), '{"a":"teammate plan"}');
  const fake = createFakeDb({
    repositories: schema.repositories,
    planMirrorState: schema.planMirrorState,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeCodeLinks: schema.planNodeCodeLinks,
  });
  fake.insert(schema.repositories, { id: REPO, storagePath: root });
  fake.insert(schema.planMirrorState, {
    repositoryId: REPO,
    revision: 1,
    writtenRevision: 1,
    syncedHash: null,
  });
  const err = resource(code);
  h.fault = (kind, target) => (kind === 'lstat' && target.endsWith('/plan.json') ? err : undefined);
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ repositoryId: REPO }] }) }),
    transaction: fake.db.transaction.bind(fake.db),
  };
  expect(await stampPlanMirrorHashesAtBoot(db as unknown as Database)).toBe(0);
  expect(fake.rows(schema.planMirrorState)[0]?.syncedHash).toBeNull();
  expect(logger.warn).toHaveBeenCalledWith(
    { err, repositoryId: REPO },
    'plan mirror hash not stamped at boot',
  );
});

it.each(['EMFILE', 'ENFILE'])(
  'does not send an unread skill to missing-file regeneration on %s',
  async (code) => {
    const err = resource(code);
    h.fault = (kind) => (kind === 'open' ? err : undefined);
    await expect(checkSkill(root, '.claude/skills', 'keep')).rejects.toBe(err);
  },
);

it.each(['EMFILE', 'ENFILE'])('never returns a partial bundle catalog on %s', async (code) => {
  await mkdir(path.join(root, 'agents'), { recursive: true });
  await writeFile(path.join(root, 'agents/keep.md'), 'agent');
  const err = resource(code);
  h.fault = (kind) => (kind === 'readdir' ? err : undefined);
  await expect(classifyBundle(root, '')).rejects.toBe(err);
});

it.each([1, 2])('never publishes a bundle after resource failure at agent read %s', async (nth) => {
  const tree = path.join(root, 'user/bundle/extracted');
  await mkdir(path.join(tree, 'agents'), { recursive: true });
  await writeFile(
    path.join(tree, 'agents/keep.md'),
    '---\nname: canonical\ndescription: keep\n---\n# Keep\nInstructions',
  );
  const err = resource('EMFILE');
  let reads = 0;
  h.fault = (kind, target) =>
    kind === 'lstat' && target.endsWith('/keep.md') && ++reads === nth ? err : undefined;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
      }),
    }),
  };
  await expect(
    parseBundle('bundle', db as never, logger, root, { storageRoot: tree, repositoryId: REPO }),
  ).rejects.toBe(err);
});
