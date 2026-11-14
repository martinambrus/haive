import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bundleHash, classifyBundle, requireUnmodifiedBundle, stageBundle } from './bundle.js';
import { readComposeContext } from './compose-context.js';

const body = Buffer.from('services: {}\n');
const hash = bundleHash(body);
const baseFiles = { 'docker-compose.yml': hash, 'docker-compose.run.yml': hash };
const bundle = { files: baseFiles, known: [baseFiles], env: [] };
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rbr-bundle-'));
  for (const name of Object.keys(baseFiles)) await writeFile(join(dir, name), body);
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

it.each(['pristine', 'modified', 'legacy-known', 'legacy-unknown'] as const)(
  'classifies %s before replacement decisions',
  async (kind) => {
    if (kind === 'pristine' || kind === 'modified')
      await writeFile(
        join(dir, '.haive-bundle.json'),
        JSON.stringify({ version: '1.0.0', files: baseFiles }),
      );
    if (kind === 'modified' || kind === 'legacy-unknown')
      await writeFile(join(dir, 'docker-compose.run.yml'), 'edited');
    const classification = await classifyBundle(await readComposeContext(dir), bundle);
    expect(classification.kind).toBe(kind);
    if (kind === 'modified' || kind === 'legacy-unknown') {
      expect(classification.differingFile).toBe('docker-compose.run.yml');
      expect(() => requireUnmodifiedBundle(classification, false)).toThrow(
        '--replace-modified-bundle',
      );
    } else requireUnmodifiedBundle(classification, false);
    requireUnmodifiedBundle(classification, true);
  },
);

it('recognises only the installed overlay in historical bundles and stages its target counterpart', async () => {
  const overlay = 'docker-compose.vulkan.yml';
  await writeFile(join(dir, overlay), body);
  const files = { ...baseFiles, [overlay]: hash, 'docker-compose.gpu.yml': hash };
  const target = { ...bundle, files, known: [files] };
  const compose = await readComposeContext(dir);
  expect((await classifyBundle(compose, target)).kind).toBe('legacy-known');
  const staged = await stageBundle(
    compose,
    target,
    new Map(Object.keys(files).map((name) => [name, body])),
  );
  expect(staged.dir).toBe(dir);
  expect(staged.files.map((file) => file.split('/').at(-1))).toEqual([
    ...Object.keys(baseFiles),
    overlay,
  ]);
  expect(await readFile(staged.files[2]!)).toEqual(body);
  const owner = await stat(dir);
  for (const file of staged.files) {
    const mode = await stat(file);
    expect([mode.uid, mode.gid, mode.mode & 0o777]).toEqual([owner.uid, owner.gid, 0o644]);
  }
});

it('does not substitute a different target overlay when the installed overlay is absent from target', async () => {
  await writeFile(join(dir, 'docker-compose.gpu.yml'), body);
  const files = { ...baseFiles, 'docker-compose.vulkan.yml': hash };
  const staged = await stageBundle(
    await readComposeContext(dir),
    { ...bundle, files },
    new Map(Object.keys(files).map((name) => [name, body])),
  );
  expect(staged.files).toHaveLength(2);
});

it('rejects a malformed installed record as modified', async () => {
  await writeFile(join(dir, '.haive-bundle.json'), '{}');
  expect(await classifyBundle(await readComposeContext(dir), bundle)).toEqual({
    kind: 'modified',
    differingFile: '.haive-bundle.json',
  });
});

it('names the first differing file in the closest known legacy record', async () => {
  const older = {
    'docker-compose.yml': bundleHash(Buffer.from('older base')),
    'docker-compose.run.yml': bundleHash(Buffer.from('older run')),
  };
  await writeFile(join(dir, 'docker-compose.run.yml'), 'local edit');
  expect(
    await classifyBundle(await readComposeContext(dir), { ...bundle, known: [older, baseFiles] }),
  ).toEqual({
    kind: 'legacy-unknown',
    differingFile: 'docker-compose.run.yml',
  });
});
