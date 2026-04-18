import type { CliProviderName } from '../types/index.js';

const VOLUME_PREFIX = 'haive_cli_auth';

export function cliAuthVolumeName(
  userId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const userSlug = userId.replace(/-/g, '').slice(0, 12);
  return `${VOLUME_PREFIX}_${userSlug}_${providerName}_${pathIndex}`;
}

export function isCliAuthVolume(name: string): boolean {
  return name.startsWith(`${VOLUME_PREFIX}_`);
}
