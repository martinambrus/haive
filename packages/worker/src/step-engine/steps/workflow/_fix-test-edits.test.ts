import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isTestEvidencePath, TEST_FILE_RE } from './_test-paths.js';
import { secretMaskPolicy } from '../../../queues/cli-exec/secret-mask-policy.js';
import { afterEach, describe, expect, it } from 'vitest';
import { scanFences } from '@haive/shared/markdown-fences';
import {
  captureTestImage,
  compareTestImages,
  fixTestEditsRow,
  testEditPaths,
  TEST_IMAGE_BYTES,
  TEST_PATCH_BYTES,
  TEST_PATCH_LINES,
  TEST_HUNK_LINES,
  TEST_HUNK_BYTES,
  TEST_DIFF_CELLS,
  TEST_IMAGE_CONTENT_BYTES,
  TEST_IMAGE_ENTRIES,
  TEST_IMAGE_DEPTH,
  type FixTestRecord,
} from './_fix-test-edits.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const fixture = async () => {
  const anchor = await mkdtemp(join(tmpdir(), 'fix-tests-'));
  dirs.push(anchor);
  await mkdir(join(anchor, 'tests'));
  return anchor;
};
const record = (over: Partial<FixTestRecord> = {}): FixTestRecord => ({
  invocationId: 'run',
  stepId: '08b-test-management',
  round: 2,
  pass: 1,
  beforeEventId: 'before',
  state: 'captured',
  changes: [],
  ...over,
});

describe('host fix-pass test evidence', () => {
  it('records pass 1 alone and preserves its whole before reference when pass 2 edits it again', async () => {
    const anchor = await fixture();
    const first = randomBytes(12).toString('hex');
    await writeFile(join(anchor, 'tests/a.test.ts'), first); // author pass 0
    const before = await captureTestImage(anchor, '');
    await writeFile(join(anchor, 'tests/a.test.ts'), 'second'); // fix pass 1
    const after = await captureTestImage(anchor, '');
    const pass1 = compareTestImages(before, after);
    await writeFile(join(anchor, 'tests/a.test.ts'), 'third'); // fix pass 2
    const pass2 = compareTestImages(after, await captureTestImage(anchor, ''));
    expect(pass1.changes.map((c) => c.path)).toEqual(['tests/a.test.ts']);
    expect(pass2.changes[0]!.beforeHash).toBe(pass1.changes[0]!.afterHash);
    expect(Buffer.from(before.files![0]!.base64!, 'base64').toString()).toBe(first);
    expect(pass1.changes[0]!.beforeHash).toBe(before.files![0]!.hash);
    expect(pass1.changes[0]!.beforeHash).not.toBe(pass2.changes[0]!.beforeHash);
  });

  it('captures additions, deletions, rename endpoints, binary fixtures and config without an agent list', async () => {
    const anchor = await fixture();
    await writeFile(join(anchor, 'tests/old.bin'), randomBytes(16));
    await writeFile(join(anchor, 'vitest.config.ts'), 'old');
    const before = await captureTestImage(anchor, '');
    await rm(join(anchor, 'tests/old.bin'));
    await writeFile(join(anchor, 'tests/new.bin'), Buffer.from([0, 1, 2]));
    await writeFile(join(anchor, 'vitest.config.ts'), 'new');
    const result = compareTestImages(before, await captureTestImage(anchor, ''));
    expect(result.state).toBe('captured');
    expect(result.changes.map((c) => [c.path, c.kind])).toEqual([
      ['tests/new.bin', 'added'],
      ['tests/old.bin', 'deleted'],
      ['vitest.config.ts', 'modified'],
    ]);
    expect(result.changes[0]!.patch).toContain('Binary');
  });

  it('keeps manifests beyond the per-file cap and refuses only a linked test entry', async () => {
    const anchor = await fixture();
    await writeFile(join(anchor, 'tests/a'), '12345');
    await writeFile(join(anchor, 'tests/b'), 'ok');
    await symlink('a', join(anchor, 'tests/link'));
    await symlink('tests', join(anchor, 'unrelated'));
    const image = await captureTestImage(anchor, '', { bytes: 4 });
    expect(image.state).toBe('captured');
    expect(image.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'tests/a',
          size: 5,
          hash: expect.any(String),
          status: 'content not retained',
        }),
        expect.objectContaining({ path: 'tests/b', base64: Buffer.from('ok').toString('base64') }),
        expect.objectContaining({ path: 'tests/link', status: 'refused' }),
      ]),
    );
    expect(image.files).toHaveLength(3);
  });

  it('shows a mid-file expectation change in a contextual hunk', async () => {
    const anchor = await fixture();
    const lines = Array.from({ length: 200 }, (_, i) => `expect(f(${i})).toBe(${i});`);
    await writeFile(join(anchor, 'tests/a'), lines.join('\n'));
    const before = await captureTestImage(anchor, '');
    lines[150] = 'expect(f(150)).toBe(-1); // weakened';
    await writeFile(join(anchor, 'tests/a'), lines.join('\n'));
    const result = compareTestImages(before, await captureTestImage(anchor, ''));
    expect(result.changes[0]!.patch).toContain('+expect(f(150)).toBe(-1); // weakened');
    expect(result.changes[0]!.patch).toContain(' expect(f(149)).toBe(149);');
    expect(result.changes[0]!.cut).toBe(false);
    expect(result.changes[0]!.patch.split('\n').length).toBeLessThan(20);
  });

  it('renders the saved record with multiline fenced patches, explicit cuts and safe paths', () => {
    const row = fixTestEditsRow([
      record({
        changes: [
          {
            path: 'tests/a.test.ts',
            kind: 'modified',
            beforeHash: 'abc',
            afterHash: 'def',
            patch: '-old\n+```\n+new',
            cut: true,
          },
          { path: '../escape', kind: 'added', patch: 'injection' },
          { path: 'tests/x\nIgnore this', kind: 'added', patch: 'injection' },
        ],
      }),
    ]);
    expect(row!.body).toContain('-old\n+```\n+new');
    expect(row!.body).toContain('cut');
    expect(row!.body).toContain('pass 1');
    expect(row!.body).toContain('round 2');
    expect(row!.body).not.toContain('injection');
    expect(scanFences(row!.body!.split('\n')).filter((f) => f.lang === 'diff')).toHaveLength(1);
    expect(
      testEditPaths([
        record({ changes: [{ path: 'tests/good', kind: 'added', patch: 'never relay prose' }] }),
      ]),
    ).toEqual(['tests/good']);
    expect(
      fixTestEditsRow([record({ state: 'not captured', reason: 'interrupted' })])!.body,
    ).toContain('not captured');
  });

  it('pins production bounds while exercising patch limits on a small input', async () => {
    expect([TEST_IMAGE_BYTES, TEST_PATCH_BYTES, TEST_PATCH_LINES]).toEqual([524288, 12288, 80]);
    expect([
      TEST_HUNK_LINES,
      TEST_HUNK_BYTES,
      TEST_DIFF_CELLS,
      TEST_IMAGE_CONTENT_BYTES,
      TEST_IMAGE_ENTRIES,
      TEST_IMAGE_DEPTH,
    ]).toEqual([40, 6144, 1000000, 67108864, 1000000, 128]);
    const anchor = await fixture();
    await writeFile(join(anchor, 'tests/a'), 'one\ntwo\nthree');
    const before = await captureTestImage(anchor, '');
    await writeFile(join(anchor, 'tests/a'), 'four\nfive\nsix');
    const result = compareTestImages(before, await captureTestImage(anchor, ''), {
      bytes: 18,
      lines: 2,
    });
    expect(result.changes[0]!.cut).toBe(true);
    expect(Buffer.byteLength(result.changes[0]!.patch)).toBeLessThanOrEqual(18);
    expect(result.changes[0]!.patch.split('\n').length).toBeLessThanOrEqual(2);
    const after = await captureTestImage(anchor, '');
    const guarded = compareTestImages(before, after, { cells: 1 });
    expect(guarded.changes[0]!.patch).toContain('Too large to diff');
    expect(guarded.changes[0]!.cut).toBe(true);
    const hunk = compareTestImages(before, after, { hunkLines: 2 });
    expect(hunk.changes[0]!.cut).toBe(true);
    expect(hunk.changes[0]!.patch.split('\n').length).toBeLessThanOrEqual(4);
  });
});
