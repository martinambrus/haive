import { randomUUID } from 'node:crypto';
import { REGISTRY_PREFIX_PATTERN, type ReleaseImages } from '@haive/shared/release';
import { imageRepo } from '@haive/shared/naming';
import type { ComposeContext } from './docker.js';
import * as dk from './docker.js';

export const IMAGE_KEYS = ['HAIVE_API_IMAGE', 'HAIVE_WORKER_IMAGE', 'HAIVE_WEB_IMAGE'] as const;
export const IMAGE_SETTING_KEYS = [
  ...IMAGE_KEYS,
  'HAIVE_OWN_MODULES_HOST_DIR',
  'HAIVE_BUILDER_IMAGE',
  'HAIVE_INSTALL_ID',
  'HAIVE_OWN_MODULES_REBUILD_WEB',
  'HAIVE_CHANNEL',
  'HAIVE_CHANNEL_REGISTRY',
  'DOCKER_CONFIG',
] as const;
export type ImageSettings = Record<(typeof IMAGE_SETTING_KEYS)[number], string>;

export async function readImageSettings(file: string): Promise<ImageSettings> {
  return (await dk.resolveImageSettings(file, IMAGE_SETTING_KEYS)) as ImageSettings;
}

export type ImageOverrides = Record<(typeof IMAGE_KEYS)[number], string>;
export const emptyOverrides = (): ImageOverrides => ({
  HAIVE_API_IMAGE: '',
  HAIVE_WORKER_IMAGE: '',
  HAIVE_WEB_IMAGE: '',
});

export async function readImageOverrides(
  file: string,
  settings?: ImageSettings,
): Promise<ImageOverrides> {
  const snapshot = settings ?? (await readImageSettings(file));
  const result = emptyOverrides();
  for (const key of IMAGE_KEYS) result[key] = snapshot[key];
  return journalImages(result)!;
}

export function imageFor(
  host: 'api' | 'worker' | 'web',
  version: string,
  registry: string,
  overrides?: ImageOverrides,
): string {
  const key = `HAIVE_${host.toUpperCase()}_IMAGE` as keyof ImageOverrides;
  return overrides?.[key] || `${registry}/haive-${host}:${version}`;
}

/** Journal values are untrusted JSON after a crash; reject malformed image state. */
export function journalImages(value: unknown): ImageOverrides | undefined {
  if (value === undefined) return undefined; // Old updater journal.
  if (value === null || typeof value !== 'object')
    throw new Error('invalid journal image overrides');
  const result = emptyOverrides();
  for (const key of IMAGE_KEYS) {
    const ref = (value as Record<string, unknown>)[key];
    if (typeof ref !== 'string' || (ref !== '' && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(ref)))
      throw new Error(`invalid journal ${key}`);
    result[key] = ref;
  }
  return result;
}

/** Phase 0, shared with the installation builder contract: no holds or .env writes. */
export async function prepareImages(
  compose: ComposeContext,
  envFile: string,
  version: string,
  registry: string,
  settings?: ImageSettings,
  channelImages?: ReleaseImages,
): Promise<ImageOverrides> {
  const snapshot = settings ?? (await readImageSettings(envFile));
  if (snapshot.HAIVE_CHANNEL && snapshot.HAIVE_CHANNEL !== 'public') {
    const plan = channelImagePlan(version, snapshot, channelImages);
    await dk.pullImages(compose, {
      ...process.env,
      HAIVE_VERSION: version,
      HAIVE_REGISTRY: registry,
      ...plan.baseOverrides,
    });
    if (plan.build) {
      await dk.buildOwnModules(
        plan.build.builderImage,
        snapshot.HAIVE_OWN_MODULES_HOST_DIR,
        plan.build,
        snapshot.DOCKER_CONFIG,
      );
    }
    return plan.overrides;
  }
  const current = await readImageOverrides(envFile, snapshot);
  const webSetting = snapshot.HAIVE_OWN_MODULES_REBUILD_WEB;
  if (webSetting !== '' && webSetting !== 'true' && webSetting !== 'false')
    throw new Error('HAIVE_OWN_MODULES_REBUILD_WEB must be true or false');
  const target = emptyOverrides();
  // Never let previous local pins make compose pull the old own-module images.
  await dk.pullImages(compose, {
    ...process.env,
    HAIVE_VERSION: version,
    HAIVE_REGISTRY: registry,
    ...target,
  });
  const source = snapshot.HAIVE_OWN_MODULES_HOST_DIR;
  if (!source) {
    if (IMAGE_KEYS.some((key) => current[key]))
      throw new Error(
        'image overrides require HAIVE_OWN_MODULES_HOST_DIR to rebuild before upgrading',
      );
    return target;
  }
  if (!source.startsWith('/') || source.includes(','))
    throw new Error('HAIVE_OWN_MODULES_HOST_DIR must be an absolute daemon path without commas');
  const template = snapshot.HAIVE_BUILDER_IMAGE;
  if (template && !template.includes('{version}'))
    throw new Error('HAIVE_BUILDER_IMAGE must contain {version}');
  const builderImage =
    template?.replaceAll('{version}', version) || `${registry}/haive-builder:${version}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(builderImage))
    throw new Error('HAIVE_BUILDER_IMAGE must resolve to an image reference');
  const installEnv = { HAIVE_INSTALL_ID: snapshot.HAIVE_INSTALL_ID };
  const suffix = randomUUID();
  target.HAIVE_API_IMAGE = `${imageRepo('own-api', installEnv)}:${version}-${suffix}`;
  target.HAIVE_WORKER_IMAGE = `${imageRepo('own-worker', installEnv)}:${version}-${suffix}`;
  const rebuildWeb = webSetting === 'true';
  if (rebuildWeb)
    target.HAIVE_WEB_IMAGE = `${imageRepo('own-web', installEnv)}:${version}-${suffix}`;
  const baseImages = Object.fromEntries(
    ['api', 'worker', 'web'].map((host) => [host, `${registry}/haive-${host}:${version}`]),
  );
  const outputImages = {
    api: target.HAIVE_API_IMAGE,
    worker: target.HAIVE_WORKER_IMAGE,
    ...(rebuildWeb ? { web: target.HAIVE_WEB_IMAGE } : {}),
  };
  await dk.buildOwnModules(builderImage, source, {
    version,
    builderImage,
    baseImages,
    outputImages,
    rebuildWeb,
  });
  return target;
}

/** Match the repository prefix accepted by the channel publisher. */
export function requireChannelRegistry(registry: string): string {
  if (!REGISTRY_PREFIX_PATTERN.test(registry))
    throw new Error('channel install requires a valid HAIVE_CHANNEL_REGISTRY');
  return registry;
}

/** A read-only plan also used by channel preflight; never substitutes public tag references. */
export function channelImagePlan(version: string, settings: ImageSettings, images?: ReleaseImages) {
  const registry = requireChannelRegistry(settings.HAIVE_CHANNEL_REGISTRY);
  const pinned = (host: 'api' | 'worker' | 'web' | 'builder'): string => {
    const ref = images?.[host];
    if (!ref || !/^[a-z0-9][a-z0-9._/:-]*@sha256:[a-f0-9]{64}$/.test(ref))
      throw new Error(`channel manifest requires a pinned ${host} image`);
    if (ref.split('@')[0] !== `${registry}/haive-${settings.HAIVE_CHANNEL}-${host}`)
      throw new Error(`channel manifest ${host} repository differs from install channel registry`);
    return ref;
  };
  const baseImages = { api: pinned('api'), worker: pinned('worker'), web: pinned('web') };
  const baseOverrides = {
    HAIVE_API_IMAGE: baseImages.api,
    HAIVE_WORKER_IMAGE: baseImages.worker,
    HAIVE_WEB_IMAGE: baseImages.web,
  };
  const webSetting = settings.HAIVE_OWN_MODULES_REBUILD_WEB;
  if (webSetting !== '' && webSetting !== 'true' && webSetting !== 'false')
    throw new Error('HAIVE_OWN_MODULES_REBUILD_WEB must be true or false');
  const source = settings.HAIVE_OWN_MODULES_HOST_DIR;
  if (!source) return { overrides: baseOverrides, baseOverrides };
  if (!source.startsWith('/') || source.includes(','))
    throw new Error('HAIVE_OWN_MODULES_HOST_DIR must be an absolute daemon path without commas');
  const builderImage = pinned('builder');
  const suffix = randomUUID();
  const installEnv = { HAIVE_INSTALL_ID: settings.HAIVE_INSTALL_ID };
  const rebuildWeb = webSetting === 'true';
  const overrides = {
    HAIVE_API_IMAGE: `${imageRepo('own-api', installEnv)}:${version}-${suffix}`,
    HAIVE_WORKER_IMAGE: `${imageRepo('own-worker', installEnv)}:${version}-${suffix}`,
    HAIVE_WEB_IMAGE: rebuildWeb
      ? `${imageRepo('own-web', installEnv)}:${version}-${suffix}`
      : baseImages.web,
  };
  return {
    overrides,
    baseOverrides,
    build: {
      version,
      builderImage,
      baseImages,
      outputImages: {
        api: overrides.HAIVE_API_IMAGE,
        worker: overrides.HAIVE_WORKER_IMAGE,
        ...(rebuildWeb ? { web: overrides.HAIVE_WEB_IMAGE } : {}),
      },
      rebuildWeb,
    },
  };
}
