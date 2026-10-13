import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  retireInstallManifest,
  retireLegacyMirrors,
} from '../src/step-engine/_retire-install-manifest.js';

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

describe('retireLegacyMirrors', () => {
  const ENV_UNIT = '.haive-data/state/project/environment.json';
  const GLOBS_UNIT = '.haive-data/state/settings/scope-exclude-globs.json';
  const ENV = { schemaVersion: 1, envDetectData: {}, confirmedValues: {} };
  const GLOBS = { schemaVersion: 1, scopeExcludeGlobs: ['a/**'] };

  async function retire(files: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'retire-legacy-mirrors-'));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(join(root, rel, '..'), { recursive: true });
      await writeFile(
        join(root, rel),
        typeof content === 'string' ? content : JSON.stringify(content),
      );
    }
    const warnings: string[] = [];
    const results = await retireLegacyMirrors({ repoPath: root, logger } as never, warnings);
    return {
      outcomes: Object.fromEntries(results.map((r) => [r.path, r.outcome])),
      warnings,
      exists: (rel: string) => existsSync(join(root, rel)),
    };
  }

  it('removes each mirror of Haive’s shape once its record file exists', async () => {
    const r = await retire({
      '.haive-data/environment.json': ENV,
      '.haive-data/exclusions.json': GLOBS,
      [ENV_UNIT]: {},
      [GLOBS_UNIT]: [],
    });

    expect(r.outcomes).toEqual({
      '.haive-data/environment.json': 'removed',
      '.haive-data/exclusions.json': 'removed',
    });
    expect(r.exists('.haive-data/environment.json')).toBe(false);
    expect(r.exists('.haive-data/exclusions.json')).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('decides per unit: a mirror whose record file is missing stays, silently', async () => {
    const r = await retire({
      '.haive-data/environment.json': ENV,
      '.haive-data/exclusions.json': GLOBS,
      [ENV_UNIT]: {},
    });

    expect(r.outcomes).toEqual({
      '.haive-data/environment.json': 'removed',
      '.haive-data/exclusions.json': 'kept',
    });
    expect(r.exists('.haive-data/exclusions.json')).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('reports absent when there is no mirror to remove', async () => {
    const r = await retire({ [ENV_UNIT]: {}, [GLOBS_UNIT]: [] });

    expect(Object.values(r.outcomes)).toEqual(['absent', 'absent']);
  });

  it.each([
    ['environment.json', 'another schemaVersion', { ...ENV, schemaVersion: 2 }],
    ['environment.json', 'no confirmedValues', { schemaVersion: 1, envDetectData: {} }],
    ['environment.json', 'a list', []],
    ['environment.json', 'not JSON', '{'],
    ['exclusions.json', 'another schemaVersion', { ...GLOBS, schemaVersion: 2 }],
    ['exclusions.json', 'a non-string glob', { schemaVersion: 1, scopeExcludeGlobs: [1] }],
    ['exclusions.json', 'someone else’s keys', { keep: true }],
  ])('keeps %s holding %s, and says so', async (name, _what, content) => {
    const r = await retire({ [`.haive-data/${name}`]: content, [ENV_UNIT]: {}, [GLOBS_UNIT]: [] });

    expect(r.exists(`.haive-data/${name}`)).toBe(true);
    expect(r.outcomes[`.haive-data/${name}`]).toBe('kept');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      new RegExp(`^\\.haive-data/${name.replace('.', '\\.')} was left in place: `),
    );
  });
});
