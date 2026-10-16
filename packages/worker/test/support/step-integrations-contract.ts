import type { Database, schema } from '@haive/database';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import type { IntegrationBinding, IntegrationResolution } from '@haive/shared/integrations';
import type { StepDefinition } from '../../src/step-engine/step-definition.js';

export const REASON = {
  unresolved: 'integration-unresolved',
  pinned: 'integration-provider-pinned',
  unlistable: 'integration-tools-unlistable',
  noSigningKey: 'integrations-no-signing-key',
} as const;

export const MODULE_PATH = 'packages/worker/src/step-engine/step-integrations.ts';
export const SERVER_NAME = 'haive-integrations';

export type DispatchIntegrations =
  | { ok: true; bindings: IntegrationBinding[]; resolutions: IntegrationResolution[] }
  | { ok: false; failure: string };

export type RunValues = typeof schema.cliInvocations.$inferInsert;

export interface StepIntegrations {
  setComposableCatalog(catalog: ReadonlyMap<string, ComposableStepEntry>): void;
  stepIntegrationRequirements(stepDef: StepDefinition): readonly IntegrationRequirement[];
  resolveDispatchIntegrations(
    db: Database,
    taskId: string,
    requirements: readonly IntegrationRequirement[],
  ): Promise<DispatchIntegrations>;
  insertStampedRun(
    db: Database,
    taskId: string,
    stepRowId: string,
    values: RunValues,
    requirements: readonly IntegrationRequirement[],
    named?: ReadonlyMap<string, string | null>,
  ): Promise<unknown>;
  INTEGRATION_UNRESOLVED_REASON: string;
  INTEGRATION_ACCOUNT_CHANGED_REASON: string;
  INTEGRATION_PROVIDER_PINNED_REASON: string;
  INTEGRATION_TOOLS_UNLISTABLE_REASON: string;
  INTEGRATIONS_NO_SIGNING_KEY_REASON: string;
}

const EXPORTS = [
  'setComposableCatalog',
  'stepIntegrationRequirements',
  'resolveDispatchIntegrations',
  'insertStampedRun',
  'INTEGRATION_UNRESOLVED_REASON',
  'INTEGRATION_PROVIDER_PINNED_REASON',
  'INTEGRATION_TOOLS_UNLISTABLE_REASON',
  'INTEGRATIONS_NO_SIGNING_KEY_REASON',
] as const;

async function load(specifier: string): Promise<StepIntegrations> {
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `I5d-2 contract: ${MODULE_PATH} cannot be loaded (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const missing = EXPORTS.filter((name) => !(name in loaded));
  if (missing.length > 0) {
    throw new Error(`I5d-2 contract: ${MODULE_PATH} does not export ${missing.join(', ')}`);
  }
  return loaded as unknown as StepIntegrations;
}

const REAL_SPECIFIER = '../../src/step-engine/step-integrations.js';

export const realStepIntegrations = (): Promise<StepIntegrations> => load(REAL_SPECIFIER);

export const stepIntegrationsUnderTest = (): Promise<StepIntegrations> => load(REAL_SPECIFIER);
