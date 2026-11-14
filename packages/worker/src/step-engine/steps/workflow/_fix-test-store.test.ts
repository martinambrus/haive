import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { loadFixTestRecords, fixTestManifestReference } from './_fix-test-store.js';
import type { TestImage } from './_fix-test-edits.js';

vi.mock('../../../queues/cli-exec/secret-mask.js', () => ({
  taskSecretMaskPolicy: vi.fn(async () => null),
}));

// The loader's query seam returns a before event, an after event and their durable manifests.
function fixture(before: TestImage, after: TestImage, beforeData: Buffer | null | undefined) {
  const meta = { invocationId: 'run', stepId: '08b-test-management', pass: 1, round: 1 };
  const a = fixTestManifestReference(meta, before);
  const b = fixTestManifestReference(meta, after);
  const replies: unknown[][] = [
    [{ id: 'before', payload: a }],
    [{ id: 'after', payload: b }],
    [
      ...(beforeData === undefined
        ? []
        : [{ hash: 'manifest:' + a.manifestHash, data: beforeData }]),
      { hash: 'manifest:' + b.manifestHash, data: gzipSync(JSON.stringify(after)) },
    ],
  ];
  const select = vi.fn(() => {
    const result = replies.shift() ?? [];
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  });
  return { db: { select } as unknown as Database, select };
}
const before: TestImage = {
  state: 'captured',
  files: [{ path: 'tests/a', hash: 'before', status: 'available', mode: 420, size: 1 }],
};
const after: TestImage = {
  state: 'captured',
  files: [{ path: 'tests/a', hash: 'after', status: 'available', mode: 420, size: 1 }],
};

describe('repair manifest loading', () => {
  it.each([
    ['missing row', undefined],
    ['missing gzip', null],
    ['corrupt gzip', Buffer.from('invalid gzip')],
    ['undecodable JSON', gzipSync('{')],
  ])('discloses %s as not captured for prompt and gate loads', async (_name, data) => {
    for (const patches of [false, true]) {
      const { db } = fixture(before, after, data);
      await expect(loadFixTestRecords(db, 'task', 30, { patches })).resolves.toMatchObject([
        { state: 'not captured', reason: 'Missing manifest.', changes: [] },
      ]);
    }
  });
});
