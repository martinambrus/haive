import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyOverrides, imageFor, journalImages, prepareImages } from './images.js';
import * as dk from './docker.js';

const dirs: string[] = [];
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
