import {
  guardModuleAdmission,
  integrationModuleIds,
  moduleAdmissionFailures,
} from '@haive/shared/modularity-server';
import { and, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { schema, type Database, type DbTx } from '@haive/database';
import type {
  TaskIntegrationAccount,
  TaskIntegrationChoice,
  TaskIntegrationPreview,
} from '@haive/shared';
import {
  loadResolverContext,
  resolveTarget,
  listIntegrationCategories,
  getIntegrationProvider,
} from '@haive/shared/integrations';
import {
  integrationRequirementSchema,
  type IntegrationRequirement,
} from '@haive/shared/modularity';
import type { TaskTypeDefinitionForCreate } from './task-type-definition.js';
import {
  requireAllowedByRepository,
  requireFitsRepository,
  requireValidChoice,
} from './integration-choice.js';
import { HttpError } from '../context.js';

type Handle = Database | DbTx;
type Requirement = { stepId: string; title: string; requirement: IntegrationRequirement };

/** Static lists are exact; dynamic built-ins still assemble their paths in the worker. */
async function requirementsForCreate(db: Handle, definition: TaskTypeDefinitionForCreate) {
  const requirements: Requirement[] = [];
  const issues: TaskIntegrationPreview['issues'] = [];
  const ids = definition.runListSnapshot;
  if (ids === null || ids === undefined) return { requirements, issues };
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            stepId: schema.stepCatalog.stepId,
            title: schema.stepCatalog.title,
            entry: schema.stepCatalog.entry,
          })
          .from(schema.stepCatalog)
          .where(inArray(schema.stepCatalog.stepId, ids))
          .for('share');
  const byId = new Map(rows.map((row) => [row.stepId, row]));
  for (const stepId of ids) {
    const pinned = definition.customSteps?.[stepId];
    const catalog = byId.get(stepId);
    const entry = pinned ?? catalog?.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as { title?: unknown; integrations?: unknown };
    if (raw.integrations === undefined) continue;
    if (!Array.isArray(raw.integrations)) {
      issues.push({ stepId, reason: 'integration-requirement-invalid' });
      continue;
    }
    const title = typeof raw.title === 'string' ? raw.title : (catalog?.title ?? stepId);
    for (const value of raw.integrations) {
      const parsed = integrationRequirementSchema.safeParse(value);
      if (!parsed.success) issues.push({ stepId, reason: 'integration-requirement-invalid' });
      else if (parsed.data.provider !== undefined)
        issues.push({ stepId, reason: 'integration-provider-pinned' });
      else requirements.push({ stepId, title, requirement: parsed.data });
    }
  }
  return { requirements, issues };
}

export async function taskIntegrationPreview(
  db: Handle,
  input: {
    userId: string;
    repositoryId: string | null;
    definition: TaskTypeDefinitionForCreate;
    choices: readonly TaskIntegrationChoice[];
  },
  opts: { lockRequiredModules?: boolean } = {},
): Promise<TaskIntegrationPreview> {
  const { requirements, issues } = await requirementsForCreate(db, input.definition);
  const result: TaskIntegrationPreview = {
    admitted: issues.length === 0,
    scope: input.definition.runListSnapshot == null ? 'dispatch-time' : 'static',
    categories: [],
    issues,
  };
  if (requirements.length === 0 && input.choices.length === 0) return result;
  const context = await loadResolverContext(db, {
    draft: {
      userId: input.userId,
      repositoryId: input.repositoryId,
      choices: new Map(input.choices.map((pick) => [pick.categoryId, pick.connectionId])),
    },
  });
  // Explicit fields only; neither a connection row nor its settings leave this helper.
  const summaries =
    context.connections.length === 0
      ? []
      : await db
          .select({
            id: schema.integrationConnections.id,
            accountLabel: schema.integrationConnections.accountLabel,
          })
          .from(schema.integrationConnections)
          .where(
            and(
              eq(schema.integrationConnections.ownerUserId, input.userId),
              eq(schema.integrationConnections.scope, 'user'),
            ),
          );
  const labels = new Map(summaries.map((row) => [row.id, row.accountLabel]));
  const account = (id: string | null): TaskIntegrationAccount | null => {
    const connection = context.connections.find((candidate) => candidate.id === id);
    if (!connection) return null;
    return {
      connectionId: connection.id,
      providerId: connection.providerId,
      providerLabel:
        getIntegrationProvider(connection.providerId)?.displayName ?? connection.providerId,
      accountLabel: labels.get(connection.id) ?? null,
      status: connection.status,
    };
  };
  const categories = listIntegrationCategories();
  for (const { stepId, title, requirement } of requirements) {
    const categoryId = requirement.category!;
    let category = result.categories.find((item) => item.categoryId === categoryId);
    if (!category) {
      const resolution = resolveTarget(context, { category: categoryId });
      // Ask the same resolver without soft/explicit tiers for its complete candidate set.
      const candidates = resolveTarget(
        {
          ...context,
          choices: new Map(),
          grants: new Map(),
          preferences: new Map(),
          defaults: new Map(),
        },
        { category: categoryId },
      );
      const ids =
        candidates.status === 'resolved' ? [candidates.connectionId] : candidates.candidates;
      category = {
        categoryId,
        label: categories.find((item) => item.id === categoryId)?.label ?? categoryId,
        required: false,
        steps: [],
        status: resolution.status,
        reason: resolution.status === 'unresolved' ? resolution.reason : null,
        selected: account(resolution.connectionId),
        candidates: ids.flatMap((id) => {
          const summary = account(id);
          return summary ? [summary] : [];
        }),
      };
      result.categories.push(category);
    }
    category.required ||= requirement.optional !== true;
    category.steps.push({
      stepId,
      title,
      requirementId: requirement.id,
      access: requirement.access,
      optional: requirement.optional === true,
    });
  }
  // Static automatic selections are known dependencies too. A create holds their module
  // leases before writing its task; the read-only preview reports the same fresh drain state.
  const required = result.categories.filter(
    (category) => category.required && category.status === 'resolved' && category.selected,
  );
  const failures = await moduleAdmissionFailures(
    db,
    integrationModuleIds(
      required.map((category) => ({
        categoryId: category.categoryId,
        providerId: category.selected!.providerId,
      })),
    ),
    { lock: opts.lockRequiredModules, checkOff: true },
  );
  for (const category of required) {
    const blocked = integrationModuleIds([
      { categoryId: category.categoryId, providerId: category.selected!.providerId },
    ])
      .map((id) => failures.get(id))
      .find(Boolean);
    if (blocked) {
      category.status = 'unresolved';
      category.reason = blocked === 'module-deactivated' ? 'provider-deactivated' : blocked;
    }
  }
  result.admitted &&= result.categories.every(
    (category) => !category.required || category.status === 'resolved',
  );
  return result;
}

/** Called only inside the task's insert transaction, after its locked definition read. */
export async function admitTaskIntegrations(
  db: Handle,
  input: Parameters<typeof taskIntegrationPreview>[1],
) {
  const picks: { categoryId: string; providerId: string; connectionId: string }[] = [];
  for (const pick of input.choices) {
    const [row] = await db
      .select({
        providerId: schema.integrationConnections.providerId,
        status: schema.integrationConnections.status,
      })
      .from(schema.integrationConnections)
      .where(
        and(
          eq(schema.integrationConnections.id, pick.connectionId),
          eq(schema.integrationConnections.ownerUserId, input.userId),
          eq(schema.integrationConnections.scope, 'user'),
        ),
      )
      .for('share');
    if (!row) throw new HttpError(404, 'Connection not found');
    const connection = await requireValidChoice(db, input.userId, {
      ...pick,
      providerId: row.providerId,
    });
    await requireFitsRepository(db, pick.categoryId, connection, input.repositoryId);
    await requireAllowedByRepository(db, connection, input.repositoryId);
    if (row.status !== 'connected')
      throw new HttpError(409, 'Reconnect the selected integration account in Settings');
    picks.push({ ...pick, providerId: row.providerId });
  }
  await guardModuleAdmission(db, integrationModuleIds(picks), undefined, true);
  const preview = await taskIntegrationPreview(db, input, { lockRequiredModules: true });
  if (!preview.admitted)
    throw new HTTPException(409, {
      res: Response.json(
        {
          error:
            'Choose an available account for each required integration before creating this task',
          code: 'integration-admission-required',
          integrationPreview: preview,
        },
        { status: 409 },
      ),
    });
  return {
    picks,
    moduleIds: integrationModuleIds(
      preview.categories
        .filter(
          (category) => category.required && category.status === 'resolved' && category.selected,
        )
        .map((category) => ({
          categoryId: category.categoryId,
          providerId: category.selected!.providerId,
        })),
    ),
  };
}
