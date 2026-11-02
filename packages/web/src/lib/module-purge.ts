import type { ModuleIntegrationCounts, ModulePurgePreview } from './api-client';

const CATEGORIES: Record<keyof ModuleIntegrationCounts, string> = {
  providerConfigs: 'provider configuration',
  connections: 'connected account',
  userSettings: 'user write setting',
  preferences: 'saved account preference',
  taskChoices: 'task account override',
  grants: 'task or repository account grant',
};

export function moduleIntegrationCountsCopy(counts: ModuleIntegrationCounts): string {
  return (Object.keys(CATEGORIES) as (keyof ModuleIntegrationCounts)[])
    .map((key) => `${counts[key]} ${CATEGORIES[key]}${counts[key] === 1 ? '' : 's'}`)
    .join(', ');
}

/** A mismatched or incomplete response cannot arm a destructive action. */
export function validModulePurgePreview(value: ModulePurgePreview, moduleId: string): boolean {
  return (
    value?.moduleId === moduleId &&
    value.integrations != null &&
    (Object.keys(CATEGORIES) as (keyof ModuleIntegrationCounts)[]).every(
      (key) => Number.isSafeInteger(value.integrations[key]) && value.integrations[key] >= 0,
    )
  );
}
