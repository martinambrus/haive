import type { CliProviderName } from '../types/index.js';

const VOLUME_PREFIX = 'haive_cli_auth';
const TASK_SEGMENT = 'task';
const PROVIDER_SEGMENT = 'p';

export function cliAuthVolumeName(
  userId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const userSlug = userId.replace(/-/g, '').slice(0, 12);
  return `${VOLUME_PREFIX}_${userSlug}_${providerName}_${pathIndex}`;
}

/** Per-provider isolated auth volume. Used when `cli_providers.isolate_auth=true`
 *  so two providers of the same CLI (e.g. two gemini configs) keep separate
 *  credentials. The provider id slug (first 12 hex chars after stripping dashes)
 *  is enough to disambiguate inside the user's namespace. */
export function cliAuthProviderVolumeName(
  providerId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const providerSlug = providerId.replace(/-/g, '').slice(0, 12);
  return `${VOLUME_PREFIX}_${PROVIDER_SEGMENT}_${providerSlug}_${providerName}_${pathIndex}`;
}

export function cliAuthTaskVolumeName(
  taskId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const taskSlug = taskId.replace(/-/g, '').slice(0, 12);
  return `${VOLUME_PREFIX}_${TASK_SEGMENT}_${taskSlug}_${providerName}_${pathIndex}`;
}

export function isCliAuthVolume(name: string): boolean {
  return name.startsWith(`${VOLUME_PREFIX}_`);
}

export function isCliAuthTaskVolume(name: string): boolean {
  return name.startsWith(`${VOLUME_PREFIX}_${TASK_SEGMENT}_`);
}

export function isCliAuthProviderVolume(name: string): boolean {
  return name.startsWith(`${VOLUME_PREFIX}_${PROVIDER_SEGMENT}_`);
}
