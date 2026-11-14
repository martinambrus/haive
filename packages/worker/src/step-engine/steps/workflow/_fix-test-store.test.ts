import { gzipSync } from 'node:zlib';
import picomatch from 'picomatch';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { loadFixTestRecords, fixTestManifestReference } from './_fix-test-store.js';
import { compareTestImages, type TestImage } from './_fix-test-edits.js';
import {
  secretMaskPolicy,
  secretMaskDeniesPath,
} from '../../../queues/cli-exec/secret-mask-policy.js';
import { taskSecretMaskPolicy } from '../../../queues/cli-exec/secret-mask.js';

vi.mock('picomatch', async (original) => {
  const actual = await original<{ default: typeof picomatch }>();
  return {
    default: vi.fn((...args: Parameters<typeof actual.default>) => vi.fn(actual.default(...args))),
  };
});

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

describe('repair evidence policy cost', () => {
  it.each([false, true])(
    'compiles a constant number of matchers for a 2,000-file load (patches=%s)',
    async (patches) => {
      const image: TestImage = {
        state: 'captured',
        files: Array.from({ length: 2000 }, (_, i) => ({
          path: `tests/file-${i}.ts`,
          hash: 'same',
          size: 1,
          mode: 420,
          status: 'available' as const,
        })),
      };
      const changed: TestImage = {
        ...image,
        files: image.files!.map((f, i) => (i ? f : { ...f, hash: 'changed' })),
      };
      const { db } = fixture(image, changed, gzipSync(JSON.stringify(image)));
      vi.mocked(picomatch).mockClear();
      await loadFixTestRecords(db, 'task', 30, { patches });
      expect(picomatch).toHaveBeenCalledTimes(2);
      if (!patches) {
        const paths = vi
          .mocked(picomatch)
          .mock.results.flatMap((r) =>
            vi.mocked(r.value as ReturnType<typeof picomatch>).mock.calls.map((args) => args[0]),
          );
        expect(new Set(paths)).toEqual(new Set(['tests/file-0.ts']));
      }
    },
  );

  it('keeps per-call policy verdicts for allowed, withheld and negated fixture paths', async () => {
    const policy = secretMaskPolicy({
      allow: ['**/id_rsa'],
      denyExtend: ['**/private.json', '**/*.md', '!**/safe.md'],
    });
    vi.mocked(taskSecretMaskPolicy).mockResolvedValueOnce(policy).mockResolvedValueOnce(policy);
    const paths = [
      'tests/a.ts',
      'tests/.env.test',
      'tests/.auth/user.json',
      'tests/id_rsa',
      'tests/.env.example',
      'tests/private.json',
      'tests/other.md',
      'tests/safe.md',
      'tests/unchanged.ts',
    ];
    const image: TestImage = {
      state: 'captured',
      files: paths.map((path) => ({ path, hash: 'old', size: 1, mode: 420, status: 'available' })),
    };
    const next: TestImage = {
      ...image,
      files: image.files!.map((f) => ({
        ...f,
        hash: f.path.endsWith('unchanged.ts') ? f.hash : 'new',
        size: f.path.endsWith('.env.test') ? 2 : 1,
      })),
    };
    expect(paths.filter((p) => secretMaskDeniesPath(policy, p))).toEqual([
      'tests/.env.test',
      'tests/.auth/user.json',
      'tests/private.json',
      'tests/other.md',
    ]);
    const perCall = (image: TestImage): TestImage => ({
      ...image,
      files: image.files!.map((f) =>
        secretMaskDeniesPath(policy, f.path)
          ? { ...f, hash: 'withheld:present', status: 'content withheld', base64: undefined }
          : { ...f, base64: undefined },
      ),
    });
    for (const patches of [false, true]) {
      const { db } = fixture(image, next, gzipSync(JSON.stringify(image)));
      const [record] = await loadFixTestRecords(db, 'task', 30, { patches });
      const expected = compareTestImages(
        perCall(image),
        perCall(next),
        patches ? {} : { bytes: 0, lines: 0 },
      );
      expect(record).toMatchObject(expected);
    }
  });
});
