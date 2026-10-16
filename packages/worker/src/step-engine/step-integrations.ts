import { inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { promptNamesAgentPath } from '@haive/shared';
import {
  IntegrationToolNameError,
  getIntegrationProvider,
  integrationTools,
  listIntegrationCategories,
  lockTaskIntegrations,
  recordTaskGrants,
  resolveStepIntegrations,
  type IntegrationBinding,
  type IntegrationResolution,
} from '@haive/shared/integrations';
import {
  describeInvalidTools,
  parseCategoryId,
  parseProviderId,
  parseStepId,
  type ComposableStepEntry,
  type IntegrationRequirement,
} from '@haive/shared/modularity';
import { fenceOpener } from '@haive/shared/markdown-fences';
import { providerLabel } from '../sandbox/mcp-surface.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import type { StepRegistry } from './registry.js';
import type { StepDefinition } from './step-definition.js';
import { insertOwnedRun } from './step-ownership.js';
import { SAFE_TITLE_CHARS, isSingleLine, survivesFence } from './steps/_untrusted-repo.js';
import { promptStepIntegrations } from './steps/custom/prompt-step.js';

export const INTEGRATION_UNRESOLVED_REASON = 'integration-unresolved';
export const INTEGRATION_PROVIDER_PINNED_REASON = 'integration-provider-pinned';
export const INTEGRATION_REQUIREMENT_INVALID_REASON = 'integration-requirement-invalid';
export const INTEGRATION_PROVIDER_UNSUPPORTED_REASON = 'integration-provider-unsupported';
export const INTEGRATION_TOOLS_UNLISTABLE_REASON = 'integration-tools-unlistable';
export const INTEGRATIONS_NO_SIGNING_KEY_REASON = 'integrations-no-signing-key';
export const INTEGRATION_ACCOUNT_CHANGED_REASON = 'integration-account-changed';

export type DispatchIntegrations =
  | { ok: true; bindings: IntegrationBinding[]; resolutions: IntegrationResolution[] }
  | { ok: false; failure: string };

let catalog: ReadonlyMap<string, ComposableStepEntry> = new Map();

export function setComposableCatalog(entries: ReadonlyMap<string, ComposableStepEntry>): void {
  catalog = entries;
}

/** What the catalog entry of a step declares; a prompt step declares what its task pinned. */
export function stepIntegrationRequirements(
  stepDef: StepDefinition,
): readonly IntegrationRequirement[] {
  const id = stepDef.metadata.id;
  return parseStepId(id)?.kind === 'custom'
    ? (promptStepIntegrations(stepDef)?.requirements ?? [])
    : (catalog.get(id)?.integrations ?? []);
}

/** Why a pinned prompt step cannot dispatch: a requirement it stored no longer parses. Null when none fails. */
export function invalidRequirementsFailure(stepDef: StepDefinition): string | null {
  const invalid = promptStepIntegrations(stepDef)?.invalid ?? [];
  return invalid.length > 0
    ? `${INTEGRATION_REQUIREMENT_INVALID_REASON}: this step's integrations no longer pass their checks: ${describeInvalidTools(invalid)}. The task pinned them when it was created; fix them in the task type and start a new task.`
    : null;
}

function undeclaredModuleTarget(requirement: IntegrationRequirement): string | null {
  const { category, provider } = requirement;
  if (
    category !== undefined &&
    parseCategoryId(category)?.kind === 'module' &&
    !listIntegrationCategories().some((declared) => declared.id === category)
  ) {
    return `the category ${category}`;
  }
  if (
    provider !== undefined &&
    parseProviderId(provider)?.kind === 'module' &&
    getIntegrationProvider(provider) === undefined
  ) {
    return `the provider ${provider}`;
  }
  return null;
}

export function assertModuleIntegrationsDeclared(
  entries: ReadonlyMap<string, ComposableStepEntry>,
): void {
  for (const entry of entries.values()) {
    for (const requirement of entry.integrations ?? []) {
      const target = undeclaredModuleTarget(requirement);
      if (target !== null) {
        throw new Error(
          `Composable entry ${entry.stepId} requires ${target}, which no loaded module declares`,
        );
      }
    }
  }
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

/** The api refuses calls to a module provider, so none is given to a step: a required requirement that resolved to one fails, an optional one is left out. */
function withoutModuleProviders(
  requirements: readonly IntegrationRequirement[],
  resolutions: readonly IntegrationResolution[],
): { resolutions: IntegrationResolution[]; failure: string | null } {
  const optional = new Set(
    requirements.flatMap((requirement) => (requirement.optional ? [requirement.id] : [])),
  );
  const lost: string[] = [];
  const kept = resolutions.filter((resolution) => {
    if (
      resolution.status !== 'resolved' ||
      parseProviderId(resolution.providerId)?.kind !== 'module'
    ) {
      return true;
    }
    if (!optional.has(resolution.requirementId)) {
      lost.push(
        `${resolution.requirementId} (${resolution.categoryId}) resolved to the module provider ${resolution.providerId}`,
      );
    }
    return false;
  });
  return {
    resolutions: kept,
    failure:
      lost.length > 0
        ? `${INTEGRATION_PROVIDER_UNSUPPORTED_REASON}: ${lost.join('; ')}. Module providers cannot run calls yet. Choose another provider, then retry the step.`
        : null,
  };
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
  const found = await resolveStepIntegrations(db, { taskId }, requirements);
  const unresolved = unresolvedFailure(found);
  if (unresolved !== null) return { ok: false, failure: unresolved };
  const { resolutions, failure } = withoutModuleProviders(requirements, found);
  if (failure !== null) return { ok: false, failure };
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

/** Resolves again under the task lock, so the grant and the stamp follow the choice as it stands now; a required requirement lost since then writes nothing, nor does a `named` account (requirement id to the connection its prompt was built on, null for none) that is another now. */
export async function insertStampedRun(
  db: Database,
  taskId: string,
  stepRowId: string,
  values: typeof schema.cliInvocations.$inferInsert,
  requirements: readonly IntegrationRequirement[],
  named: ReadonlyMap<string, string | null> = new Map(),
): Promise<typeof schema.cliInvocations.$inferSelect | { failure: string }> {
  return db.transaction(async (tx) => {
    await lockTaskIntegrations(tx, taskId);
    const found = await resolveStepIntegrations(tx, { taskId }, requirements);
    const unresolved = unresolvedFailure(found);
    if (unresolved !== null) return { failure: unresolved };
    const { resolutions, failure } = withoutModuleProviders(requirements, found);
    if (failure !== null) return { failure };
    const bindings = bindingsOf(resolutions);
    const changed = [...named]
      .filter(
        ([id, connectionId]) =>
          (bindings.find((binding) => binding.requirementId === id)?.connectionId ?? null) !==
          connectionId,
      )
      .map(([id]) => id);
    if (changed.length > 0) {
      return {
        failure: `${INTEGRATION_ACCOUNT_CHANGED_REASON}: the account of ${changed.join(', ')} changed while this step was starting, so the prompt names another account; retry the step.`,
      };
    }
    await recordTaskGrants(tx, taskId, resolutions);
    return insertOwnedRun(tx, stepRowId, {
      ...values,
      integrations: bindings.length > 0 ? bindings : null,
    });
  });
}

export const NO_ACCOUNT_TEXT = '(no account connected)';

/** The label as the prompt will hold it (cut first, so what is judged is what is sent), or the provider's name when that is not one safe line. */
function accountText(binding: IntegrationBinding, label: string | undefined): string {
  const cut = label?.slice(0, SAFE_TITLE_CHARS);
  return cut !== undefined &&
    isSingleLine(cut) &&
    survivesFence(cut) &&
    fenceOpener(cut) === null &&
    !promptNamesAgentPath(cut, SANDBOX_WORKDIR)
    ? cut
    : providerLabel(binding.providerId);
}

/** What `{{integration:<id>.account}}` renders for each requirement: the label of its account, or `NO_ACCOUNT_TEXT` when it resolved to none. */
export function integrationAccountTexts(
  requirements: readonly IntegrationRequirement[],
  bindings: readonly IntegrationBinding[],
  labels: ReadonlyMap<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    requirements.map(({ id }) => {
      const binding = bindings.find((candidate) => candidate.requirementId === id);
      return [
        id,
        binding === undefined
          ? NO_ACCOUNT_TEXT
          : accountText(binding, labels.get(binding.connectionId)),
      ];
    }),
  );
}

/** The account texts of a dispatch, with every label read in one query; undefined when the step declares no integration. */
export async function dispatchIntegrationAccounts(
  db: Database,
  requirements: readonly IntegrationRequirement[],
  bindings: readonly IntegrationBinding[],
): Promise<Record<string, string> | undefined> {
  if (requirements.length === 0) return undefined;
  const rows =
    bindings.length === 0
      ? []
      : await db
          .select({
            id: schema.integrationConnections.id,
            label: schema.integrationConnections.accountLabel,
          })
          .from(schema.integrationConnections)
          .where(
            inArray(
              schema.integrationConnections.id,
              bindings.map((binding) => binding.connectionId),
            ),
          );
  return integrationAccountTexts(
    requirements,
    bindings,
    new Map(rows.map((row) => [row.id, row.label])),
  );
}
