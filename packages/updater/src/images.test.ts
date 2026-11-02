import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  emptyOverrides,
  imageFor,
  journalImages,
  prepareImages,
  readImageOverrides,
  readImageSettings,
} from './images.js';
import { preflight } from './preflight.js';
import { parseReleaseManifest } from '@haive/shared/release';
import * as dk from './docker.js';

const dirs: string[] = [];
beforeEach(() => {
  // Syntax is exercised through real Compose in the read-only integration receipt; units isolate transport.
  vi.spyOn(dk, 'resolveImageSettings').mockImplementation(async (file, keys) => {
    const values = parseEnv(await readFile(file, 'utf8'));
    return Object.fromEntries(keys.map((key) => [key, values[key] ?? '']));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function env(text: string) {
  const dir = await mkdtemp(join(tmpdir(), 'haive-image-test-'));
  dirs.push(dir);
  const file = join(dir, '.env');
  await writeFile(file, text);
  return file;
}

describe('own-module preflight', () => {
  it.each([
    { line: '', prefix: 'haive' },
    { line: 'HAIVE_INSTALL_ID=\n', prefix: 'haive' },
    { line: 'HAIVE_INSTALL_ID=team_a\n', prefix: 'team_a' },
  ])('names all derived images from install config: $prefix ($line)', async ({ line, prefix }) => {
    vi.stubEnv('HAIVE_INSTALL_ID', 'ambient');
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    const file = await env(
      `${line}HAIVE_OWN_MODULES_HOST_DIR=/modules\nHAIVE_OWN_MODULES_REBUILD_WEB=true\n`,
    );
    const result = await prepareImages({ dir: '/install', files: [] }, file, '1.1.0', 'public');
    const tag = result.HAIVE_API_IMAGE.slice(result.HAIVE_API_IMAGE.indexOf(':'));
    expect(tag).toMatch(/^:1\.1\.0-[0-9a-f-]{36}$/);
    expect(result).toEqual({
      HAIVE_API_IMAGE: `${prefix}-own-api${tag}`,
      HAIVE_WORKER_IMAGE: `${prefix}-own-worker${tag}`,
      HAIVE_WEB_IMAGE: `${prefix}-own-web${tag}`,
    });
    expect(build).toHaveBeenCalledWith(
      expect.anything(),
      '/modules',
      expect.objectContaining({
        outputImages: {
          api: result.HAIVE_API_IMAGE,
          worker: result.HAIVE_WORKER_IMAGE,
          web: result.HAIVE_WEB_IMAGE,
        },
      }),
    );
    expect(process.env.HAIVE_INSTALL_ID).toBe('ambient');
  });
  it('rejects an invalid configured install identity without building or changing ambient state', async () => {
    vi.stubEnv('HAIVE_INSTALL_ID', 'ambient');
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    await expect(
      prepareImages(
        { dir: '/install', files: [] },
        await env('HAIVE_INSTALL_ID=Bad-ID\nHAIVE_OWN_MODULES_HOST_DIR=/modules\n'),
        '1.1.0',
        'public',
      ),
    ).rejects.toThrow('HAIVE_INSTALL_ID must be');
    expect(build).not.toHaveBeenCalled();
    expect(process.env.HAIVE_INSTALL_ID).toBe('ambient');
  });
  it('pulls stock images with old overrides cleared, builds matching customer variant without changing pins', async () => {
    const text =
      'HAIVE_VERSION=1.0.0\nHAIVE_API_IMAGE=own-api:old\nHAIVE_OWN_MODULES_HOST_DIR=/customer/modules\nHAIVE_BUILDER_IMAGE=customer/builder:{version}\n';
    const file = await env(text);
    const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    const result = await prepareImages({ dir: '/install', files: [] }, file, '1.1.0', 'customer');
    expect(pull).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ HAIVE_VERSION: '1.1.0', HAIVE_API_IMAGE: '' }),
    );
    expect(build).toHaveBeenCalledWith(
      'customer/builder:1.1.0',
      '/customer/modules',
      expect.objectContaining({
        version: '1.1.0',
        baseImages: {
          api: 'customer/haive-api:1.1.0',
          worker: 'customer/haive-worker:1.1.0',
          web: 'customer/haive-web:1.1.0',
        },
        outputImages: { api: result.HAIVE_API_IMAGE, worker: result.HAIVE_WORKER_IMAGE },
        rebuildWeb: false,
      }),
    );
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(result.HAIVE_API_IMAGE).not.toBe('own-api:old');
    expect(result.HAIVE_WEB_IMAGE).toBe('');
  });
  it('propagates a build failure with the installation pins untouched', async () => {
    const text = 'HAIVE_OWN_MODULES_HOST_DIR=/modules\n';
    const file = await env(text);
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    vi.spyOn(dk, 'buildOwnModules').mockRejectedValue(new Error('compilation failed'));
    await expect(
      prepareImages({ dir: '/install', files: [] }, file, '1.1.0', 'public'),
    ).rejects.toThrow('compilation failed');
    expect(await readFile(file, 'utf8')).toBe(text);
  });
  it('does not build for module-free installs and refuses silently dropping an own module', async () => {
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    expect(await prepareImages({ dir: '/', files: [] }, await env(''), '1.1.0', 'public')).toEqual(
      emptyOverrides(),
    );
    expect(build).not.toHaveBeenCalled();
    await expect(
      prepareImages(
        { dir: '/', files: [] },
        await env('HAIVE_API_IMAGE=own:old'),
        '1.1.0',
        'public',
      ),
    ).rejects.toThrow('HAIVE_OWN_MODULES_HOST_DIR');
  });
});

it('resumed migrations and commit can select exact derived targets, while old journals remain compatible', () => {
  const refs = {
    ...emptyOverrides(),
    HAIVE_API_IMAGE: 'local-api:one',
    HAIVE_WORKER_IMAGE: 'local-worker:one',
  };
  const restored = journalImages(JSON.parse(JSON.stringify(refs)));
  expect(imageFor('api', '1.1.0', 'public', restored)).toBe('local-api:one');
  expect(imageFor('worker', '1.1.0', 'public', restored)).toBe('local-worker:one');
  expect(imageFor('web', '1.1.0', 'public', restored)).toBe('public/haive-web:1.1.0');
  expect(journalImages(undefined)).toBeUndefined();
  expect(() => journalImages({ HAIVE_API_IMAGE: 'local-api:one' })).toThrow('invalid journal');
});

it('quoted current Compose image refs pass rollback preflight and survive journal normalization', async () => {
  const file = await env(
    'HAIVE_API_IMAGE="own-api:1.0.0" # current API\nHAIVE_WORKER_IMAGE=\'own-worker:1.0.0\'\nHAIVE_WEB_IMAGE=own-web:1.0.0 # current web\n',
  );
  const text = await readFile(file, 'utf8');
  const refs = await readImageOverrides(file);
  const local = ['own-api:1.0.0', 'own-worker:1.0.0', 'own-web:1.0.0'];
  const currentImages = (['api', 'worker', 'web'] as const).map((host) =>
    imageFor(host, '1.0.0', 'public', refs),
  );
  expect(
    preflight({
      currentVersion: '1.0.0',
      target: parseReleaseManifest({
        manifestVersion: 1,
        version: '1.1.0',
        builtAt: '2026-11-02',
        migrationHead: '0220',
      }),
      localImages: local,
      currentImages,
      freeBytes: 1,
      snapshotBytes: 0,
    }),
  ).toEqual({ ok: true });
  expect(Object.values(journalImages(JSON.parse(JSON.stringify(refs)))!)).toEqual(local);
  expect(await readFile(file, 'utf8')).toBe(text);
});

it('reuses one resolved snapshot for quoted build settings and explicit install identity', async () => {
  vi.stubEnv('HAIVE_INSTALL_ID', 'ambient');
  const text =
    'HAIVE_INSTALL_ID="team_a" # namespace\nHAIVE_OWN_MODULES_HOST_DIR=\'/prepared modules\'\nHAIVE_BUILDER_IMAGE="customer/builder:{version}"\nHAIVE_OWN_MODULES_REBUILD_WEB="true" # opt in\n';
  const file = await env(text);
  const snapshot = await readImageSettings(file);
  await writeFile(file, 'HAIVE_OWN_MODULES_HOST_DIR=/changed\n');
  vi.spyOn(dk, 'pullImages').mockResolvedValue();
  const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
  const refs = await prepareImages(
    { dir: '/install', files: [] },
    file,
    '1.1.0',
    'customer',
    snapshot,
  );
  expect(dk.resolveImageSettings).toHaveBeenCalledTimes(1);
  expect(build).toHaveBeenCalledWith(
    'customer/builder:1.1.0',
    '/prepared modules',
    expect.objectContaining({
      rebuildWeb: true,
      outputImages: {
        api: refs.HAIVE_API_IMAGE,
        worker: refs.HAIVE_WORKER_IMAGE,
        web: refs.HAIVE_WEB_IMAGE,
      },
    }),
  );
  expect(refs.HAIVE_API_IMAGE).toMatch(/^team_a-own-api:/);
  expect(refs.HAIVE_WEB_IMAGE).toMatch(/^team_a-own-web:/);
  expect(process.env.HAIVE_INSTALL_ID).toBe('ambient');
  expect(await readFile(file, 'utf8')).toBe('HAIVE_OWN_MODULES_HOST_DIR=/changed\n');
});

it('fails visibly before pulling or building for unsupported web settings', async () => {
  const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
  const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
  const file = await env(
    'HAIVE_OWN_MODULES_HOST_DIR=/modules\nHAIVE_OWN_MODULES_REBUILD_WEB=yes\n',
  );
  await expect(prepareImages({ dir: '/', files: [] }, file, '1.1.0', 'public')).rejects.toThrow(
    'must be true or false',
  );
  expect(pull).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
});
