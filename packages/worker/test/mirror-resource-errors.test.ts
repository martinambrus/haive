import { readlinkSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      const target = String(args[0]);
      if (
        h.error &&
        target.endsWith('/environment.json') &&
        readlinkSync(path.dirname(target)).endsWith('/state/project')
      )
        throw h.error;
      return real.lstat(...args);
    },
  };
});
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { logger } from '@haive/shared';
import { persistDetection } from '../src/repo/clone.js';
let root: string;
afterEach(async () => {
  h.error = null;
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it.each(['EMFILE', 'ENFILE'])(
  'never fills a column from a stale legacy mirror when its record-unit probe fails with %s',
  async (code) => {
    root = await mkdtemp(path.join(tmpdir(), 'mirror-resource-'));
    await mkdir(path.join(root, '.haive-data/state/project'), { recursive: true });
    await writeFile(path.join(root, '.haive-data/state/project/environment.json'), '{}');
    await writeFile(
      path.join(root, '.haive-data/environment.json'),
      JSON.stringify({
        schemaVersion: 1,
        envDetectData: { framework: 'stale' },
        confirmedValues: {},
      }),
    );
    const fake = createFakeDb({
      repositories: schema.repositories,
      projectStateOutbox: schema.projectStateOutbox,
    });
    const id = '00000000-0000-4000-8000-000000000001';
    fake.insert(schema.repositories, { id });
    h.error = Object.assign(new Error('injected'), { code });
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await persistDetection(fake.db as unknown as Database, id, root);
    expect(fake.rows(schema.repositories)[0]?.onboardingEnvironment).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { err: h.error, repositoryId: id },
      'haive-data mirror import failed (non-fatal)',
    );
  },
);
