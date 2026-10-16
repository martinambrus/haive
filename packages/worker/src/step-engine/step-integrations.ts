import type { Database, schema } from '@haive/database';
import {
  IntegrationToolNameError,
  getIntegrationProvider,
  integrationTools,
  lockTaskIntegrations,
  recordTaskGrants,
  resolveStepIntegrations,
  type IntegrationBinding,
  type IntegrationResolution,
} from '@haive/shared/integrations';
import {
  parseStepId,
  type ComposableStepEntry,
  type IntegrationRequirement,
} from '@haive/shared/modularity';
import type { StepRegistry } from './registry.js';
import type { StepDefinition } from './step-definition.js';
import { insertOwnedRun } from './step-ownership.js';

export const INTEGRATION_UNRESOLVED_REASON = 'integration-unresolved';
export const INTEGRATION_PROVIDER_PINNED_REASON = 'integration-provider-pinned';
export const INTEGRATION_TOOLS_UNLISTABLE_REASON = 'integration-tools-unlistable';
export const INTEGRATIONS_NO_SIGNING_KEY_REASON = 'integrations-no-signing-key';

export type DispatchIntegrations =
  | { ok: true; bindings: IntegrationBinding[]; resolutions: IntegrationResolution[] }
  | { ok: false; failure: string };

let catalog: ReadonlyMap<string, ComposableStepEntry> = new Map();

export function setComposableCatalog(entries: ReadonlyMap<string, ComposableStepEntry>): void {
  catalog = entries;
}

/** What the catalog entry of a step declares; a prompt step declares none yet. */
export function stepIntegrationRequirements(
  stepDef: StepDefinition,
): readonly IntegrationRequirement[] {
  const id = stepDef.metadata.id;
  return parseStepId(id)?.kind === 'custom' ? [] : (catalog.get(id)?.integrations ?? []);
}

export function assertIntegrationsDeliverable(
  registry: StepRegistry,
  entries: ReadonlyMap<string, ComposableStepEntry>,
): void {
  for (const entry of entries.values()) {
    if ((entry.integrations ?? []).length === 0) continue;
    const def = registry.require(entry.stepId);
    if (
      ![def.llm, def.agentMining].some(
        (spec) => spec !== undefined && spec.toolProfile === undefined,
      )
    ) {
      throw new Error(
        `Composable entry ${entry.stepId} declares integrations, but the step has no llm or agent mining phase without a toolProfile to carry them`,
      );
    }
  }
}

const bindingsOf = (resolutions: readonly IntegrationResolution[]): IntegrationBinding[] =>
  resolutions.flatMap((resolution) =>
    resolution.status === 'resolved'
      ? [
          {
            requirementId: resolution.requirementId,
            categoryId: resolution.categoryId,
            providerId: resolution.providerId,
            connectionId: resolution.connectionId,
            access: resolution.access,
          },
        ]
      : [],
  );

function unresolvedFailure(resolutions: readonly IntegrationResolution[]): string | null {
  const lost = resolutions.flatMap((resolution) =>
    resolution.status === 'unresolved' && !resolution.optional
      ? [`${resolution.requirementId} (${resolution.categoryId}): ${resolution.reason}`]
      : [],
  );
  return lost.length > 0
    ? `${INTEGRATION_UNRESOLVED_REASON}: ${lost.join('; ')}. Fix that, then retry the step.`
    : null;
}

export async function resolveDispatchIntegrations(
  db: Database,
  taskId: string,
  requirements: readonly IntegrationRequirement[],
): Promise<DispatchIntegrations> {
  const pinned = requirements.find((requirement) => requirement.category === undefined);
  if (pinned) {
    return {
      ok: false,
      failure: `${INTEGRATION_PROVIDER_PINNED_REASON}: ${pinned.id} pins the provider ${pinned.provider}, and a step cannot be given a pinned provider yet.`,
    };
  }
  const resolutions = await resolveStepIntegrations(db, { taskId }, requirements);
  const unresolved = unresolvedFailure(resolutions);
  if (unresolved !== null) return { ok: false, failure: unresolved };
  const bindings = bindingsOf(resolutions);
  if (bindings.length === 0) return { ok: true, bindings, resolutions };
  if (!process.env.CONFIG_ENCRYPTION_KEY) {
    return {
      ok: false,
      failure: `${INTEGRATIONS_NO_SIGNING_KEY_REASON}: CONFIG_ENCRYPTION_KEY is not set, so this step's integrations cannot be given their token. Set it for the api and the worker, then retry the step.`,
    };
  }
  try {
    integrationTools(bindings, getIntegrationProvider, { writeAllowed: () => true });
  } catch (err) {
    if (!(err instanceof IntegrationToolNameError)) throw err;
    return { ok: false, failure: `${INTEGRATION_TOOLS_UNLISTABLE_REASON}: ${err.message}.` };
  }
  return { ok: true, bindings, resolutions };
}

/** Resolves again under the task lock, so the grant and the stamp follow the choice as it stands now; a required requirement lost since then writes nothing. */
export async function insertStampedRun(
  db: Database,
  taskId: string,
  stepRowId: string,
  values: typeof schema.cliInvocations.$inferInsert,
  requirements: readonly IntegrationRequirement[],
): Promise<typeof schema.cliInvocations.$inferSelect | { failure: string }> {
  return db.transaction(async (tx) => {
    await lockTaskIntegrations(tx, taskId);
    const resolutions = await resolveStepIntegrations(tx, { taskId }, requirements);
    const failure = unresolvedFailure(resolutions);
    if (failure !== null) return { failure };
    await recordTaskGrants(tx, taskId, resolutions);
    const bindings = bindingsOf(resolutions);
    return insertOwnedRun(tx, stepRowId, {
      ...values,
      integrations: bindings.length > 0 ? bindings : null,
    });
  });
}
