import type { CliProviderName } from '../types/index.js';

const VOLUME_PREFIX = 'haive_cli_auth';
const TASK_SEGMENT = 'task';

export function cliAuthVolumeName(
  userId: string,
  providerName: CliProviderName,
  pathIndex: number,
): string {
  const userSlug = userId.replace(/-/g, '').slice(0, 12);
  return `${VOLUME_PREFIX}_${userSlug}_${providerName}_${pathIndex}`;
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
