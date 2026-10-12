import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retireInstallManifest } from '../src/step-engine/_retire-install-manifest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop };

async function retire(content: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'retire-install-manifest-'));
  dirs.push(root);
  if (content !== null) {
    await mkdir(join(root, '.haive'), { recursive: true });
    await writeFile(join(root, '.haive', 'install.json'), content);
  }
  const warnings: string[] = [];
  const outcome = await retireInstallManifest({ repoPath: root, logger } as never, warnings);
  return { outcome, warnings, exists: existsSync(join(root, '.haive', 'install.json')) };
}

const SHAPED = { schemaVersion: 1, templateSetHash: 'abc', templates: [] };

describe('retireInstallManifest', () => {
  it('removes a file of Haive’s shape, with or without the bundles section', async () => {
    for (const doc of [SHAPED, { ...SHAPED, bundles: [] }]) {
      const r = await retire(JSON.stringify(doc));
      expect(r).toEqual({ outcome: 'removed', warnings: [], exists: false });
    }
  });

  it('reports absent when there is no file, and no .haive directory either', async () => {
    expect(await retire(null)).toEqual({ outcome: 'absent', warnings: [], exists: false });
  });

  it.each([
    ['not JSON', '{'],
    ['a list', '[]'],
    ['null', 'null'],
    ['another schemaVersion', JSON.stringify({ ...SHAPED, schemaVersion: 2 })],
    ['no templateSetHash', JSON.stringify({ schemaVersion: 1, templates: [] })],
    ['a numeric templateSetHash', JSON.stringify({ ...SHAPED, templateSetHash: 1 })],
    ['no templates list', JSON.stringify({ schemaVersion: 1, templateSetHash: 'abc' })],
    ['someone else’s keys', '{"keep":true}'],
    ['a file past the read cap', JSON.stringify({ ...SHAPED, pad: 'x'.repeat(9 * 1024 * 1024) })],
  ])('keeps a file that is %s, and says so', async (_what, content) => {
    const r = await retire(content);

    expect(r.outcome).toBe('kept');
    expect(r.exists).toBe(true);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/^\.haive\/install\.json was left in place: /);
  });
});
