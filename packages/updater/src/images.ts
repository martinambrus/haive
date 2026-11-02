import { randomUUID } from 'node:crypto';
import { imageRepo } from '@haive/shared/naming';
import type { ComposeContext } from './docker.js';
import * as dk from './docker.js';
import { readEnvVar } from './run.js';

export const IMAGE_KEYS = ['HAIVE_API_IMAGE', 'HAIVE_WORKER_IMAGE', 'HAIVE_WEB_IMAGE'] as const;
export type ImageOverrides = Record<(typeof IMAGE_KEYS)[number], string>;
export const emptyOverrides = (): ImageOverrides => ({
  HAIVE_API_IMAGE: '',
  HAIVE_WORKER_IMAGE: '',
  HAIVE_WEB_IMAGE: '',
});

export async function readImageOverrides(file: string): Promise<ImageOverrides> {
  const result = emptyOverrides();
  for (const key of IMAGE_KEYS) result[key] = (await readEnvVar(file, key)) ?? '';
  return result;
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
): Promise<ImageOverrides> {
  const target = emptyOverrides();
  // Never let previous local pins make compose pull the old own-module images.
  await dk.pullImages(compose, {
    ...process.env,
    HAIVE_VERSION: version,
    HAIVE_REGISTRY: registry,
    ...target,
  });
  const source = await readEnvVar(envFile, 'HAIVE_OWN_MODULES_HOST_DIR');
  const current = await readImageOverrides(envFile);
  if (!source) {
    if (IMAGE_KEYS.some((key) => current[key]))
      throw new Error(
        'image overrides require HAIVE_OWN_MODULES_HOST_DIR to rebuild before upgrading',
      );
    return target;
  }
  if (!source.startsWith('/') || source.includes(','))
    throw new Error('HAIVE_OWN_MODULES_HOST_DIR must be an absolute daemon path without commas');
  const template = await readEnvVar(envFile, 'HAIVE_BUILDER_IMAGE');
  if (template && !template.includes('{version}'))
    throw new Error('HAIVE_BUILDER_IMAGE must contain {version}');
  const builderImage =
    template?.replaceAll('{version}', version) || `${registry}/haive-builder:${version}`;
  const installEnv = { HAIVE_INSTALL_ID: (await readEnvVar(envFile, 'HAIVE_INSTALL_ID')) ?? '' };
  const suffix = randomUUID();
  target.HAIVE_API_IMAGE = `${imageRepo('own-api', installEnv)}:${version}-${suffix}`;
  target.HAIVE_WORKER_IMAGE = `${imageRepo('own-worker', installEnv)}:${version}-${suffix}`;
  const rebuildWeb = (await readEnvVar(envFile, 'HAIVE_OWN_MODULES_REBUILD_WEB')) === 'true';
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
