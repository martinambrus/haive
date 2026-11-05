import { afterEach, expect, it, vi } from 'vitest';
import { prepareImages, emptyOverrides, type ImageSettings } from './images.js';
import * as dk from './docker.js';

const pin = (host: string) => `private/haive-acme-${host}@sha256:${'a'.repeat(64)}`;
const images = { api: pin('api'), worker: pin('worker'), web: pin('web'), builder: pin('builder') };
const compose = { dir: '/install', files: [] };
function settings(own = false): ImageSettings {
  return {
    ...emptyOverrides(),
    HAIVE_CHANNEL: 'acme',
    HAIVE_CHANNEL_REGISTRY: 'private',
    DOCKER_CONFIG: '/install/.docker',
    HAIVE_OWN_MODULES_HOST_DIR: own ? '/modules' : '',
    HAIVE_INSTALL_ID: '',
    HAIVE_BUILDER_IMAGE: '',
    HAIVE_OWN_MODULES_REBUILD_WEB: '',
  };
}
afterEach(() => vi.restoreAllMocks());
it('channel without own modules pulls and returns only manifest pinned overrides', async () => {
  const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
  const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
  const s = { ...settings(), HAIVE_API_IMAGE: 'private/old:1' };
  const result = await prepareImages(compose, '/install/.env', '9.9.9', 'public', s, images);
  expect(result).toEqual({
    HAIVE_API_IMAGE: images.api,
    HAIVE_WORKER_IMAGE: images.worker,
    HAIVE_WEB_IMAGE: images.web,
  });
  expect(pull).toHaveBeenCalledWith(compose, expect.objectContaining(result));
  expect(build).not.toHaveBeenCalled();
});
it.each([false, true])(
  'channel with own modules selects manifest base and builder (web=%s)',
  async (rebuild) => {
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    const s = {
      ...settings(true),
      HAIVE_BUILDER_IMAGE: 'public/builder:{version}',
      HAIVE_OWN_MODULES_REBUILD_WEB: String(rebuild),
    };
    const result = await prepareImages(compose, '/install/.env', '9.9.9', 'public', s, images);
    expect(build).toHaveBeenCalledWith(
      images.builder,
      '/modules',
      expect.objectContaining({
        builderImage: images.builder,
        baseImages: { api: images.api, worker: images.worker, web: images.web },
        rebuildWeb: rebuild,
      }),
      '/install/.docker',
    );
    expect(result.HAIVE_API_IMAGE).toMatch(/^haive-own-api:9\.9\.9-/);
    expect(result.HAIVE_WEB_IMAGE).toEqual(
      rebuild ? expect.stringMatching(/^haive-own-web:/) : images.web,
    );
  },
);
it('channel with own modules refuses missing builder before pulls', async () => {
  const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
  const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
  await expect(
    prepareImages(compose, '/install/.env', '9.9.9', 'public', settings(true), {
      ...images,
      builder: undefined,
    }),
  ).rejects.toThrow('builder');
  expect(pull).not.toHaveBeenCalled();
  expect(build).not.toHaveBeenCalled();
});
it.each([undefined, { ...images, api: undefined }, { ...images, web: 'public/web:latest' }])(
  'channel refuses incomplete or unpinned images: %j',
  async (refs) => {
    vi.spyOn(dk, 'pullImages').mockResolvedValue();
    await expect(
      prepareImages(compose, '/install/.env', '9.9.9', 'public', settings(), refs),
    ).rejects.toThrow('channel');
    expect(dk.pullImages).not.toHaveBeenCalled();
  },
);
it('public output and tag pull remain unchanged; public pins still require own modules', async () => {
  const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
  const s = { ...settings(), HAIVE_CHANNEL: '' };
  expect(await prepareImages(compose, '/install/.env', '9.9.9', 'public', s)).toEqual(
    emptyOverrides(),
  );
  expect(pull).toHaveBeenCalledWith(compose, {
    ...process.env,
    HAIVE_VERSION: '9.9.9',
    HAIVE_REGISTRY: 'public',
    ...emptyOverrides(),
  });
  await expect(
    prepareImages(compose, '/install/.env', '9.9.9', 'public', {
      ...s,
      HAIVE_API_IMAGE: 'own:old',
    }),
  ).rejects.toThrow('HAIVE_OWN_MODULES_HOST_DIR');
});

it.each(['api', 'worker', 'web', 'builder'] as const)(
  'refuses a foreign pinned %s repository before Docker calls',
  async (host) => {
    const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
    const build = vi.spyOn(dk, 'buildOwnModules').mockResolvedValue();
    for (const repository of [
      'other/haive-acme-',
      'private/haive-other-',
      'private/haive-acme-evil-',
    ]) {
      await expect(
        prepareImages(compose, '/install/.env', '9.9.9', 'public', settings(true), {
          ...images,
          [host]: `${repository}${host}@sha256:${'a'.repeat(64)}`,
        }),
      ).rejects.toThrow(`channel manifest ${host} repository`);
    }
    expect(pull).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  },
);
it('channel without a registry refuses before Docker calls', async () => {
  const pull = vi.spyOn(dk, 'pullImages').mockResolvedValue();
  await expect(
    prepareImages(
      compose,
      '/install/.env',
      '9.9.9',
      'public',
      {
        ...settings(),
        HAIVE_CHANNEL_REGISTRY: '',
      },
      images,
    ),
  ).rejects.toThrow('HAIVE_CHANNEL_REGISTRY');
  expect(pull).not.toHaveBeenCalled();
});
