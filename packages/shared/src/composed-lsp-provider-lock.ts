import { and, eq, is } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import { logger } from './logger/index.js';
import { hasPgCode, schema, type Database, type DbTx } from '@haive/database';
import { resolveTaskCliProviderId } from './cli-providers/default-provider.js';

import {
  composedLspAllowedSet,
  COMPOSED_LSP_VERIFIED_PROVIDER_NAMES,
} from './cli-providers/preferred-provider.js';
import { parseImageReferences } from './cli-providers/composed-image-references.js';
export { COMPOSED_LSP_VERIFIED_PROVIDER_NAMES } from './cli-providers/preferred-provider.js';

/** The API error code of a refused switch. */
export const COMPOSED_LSP_PROVIDER_LOCKED = 'composed_lsp_provider_locked';

/** The provider facts the lock decision reads. */
export interface ComposedLspLockProvider {
  id: string;
  name: string;
  enabled: boolean;
}

/** Why a set of effective providers cannot run a composed-LSP task. */
export type ComposedLspLockViolation =
  | { code: 'no_provider' }
  | { code: 'multiple_providers'; providerIds: string[] }
  | { code: 'unverified_provider'; providerId: string; providerName: string | null }
  | { code: 'disabled_provider'; providerId: string };

/** The lock verdict; `message` is display copy, callers key on `violation.code`. */
export type ComposedLspLockDecision =
  | { ok: true; providerId: string }
  | { ok: false; violation: ComposedLspLockViolation; message: string };

const REMEDY =
  'Start a new task and tick the opt-out for installing language servers in the environment image to use another CLI.';

function refuse(violation: ComposedLspLockViolation, reason: string): ComposedLspLockDecision {
  return { ok: false, violation, message: `${reason} ${REMEDY}` };
}

/** Decide whether the providers a composed-LSP task would run on are the one verified provider. */
export function decideComposedLspProviderLock(args: {
  effectiveProviderIds: readonly (string | null | undefined)[];
  providers: readonly ComposedLspLockProvider[];
}): ComposedLspLockDecision {
  const ids = [
    ...new Set(args.effectiveProviderIds.filter((id): id is string => typeof id === 'string')),
  ];
  if (ids.length === 0) {
    return refuse(
      { code: 'no_provider' },
      'This task has no CLI provider to run language servers.',
    );
  }
  for (const id of ids) {
    const provider = args.providers.find((p) => p.id === id);
    if (!provider) {
      return refuse(
        { code: 'unverified_provider', providerId: id, providerName: null },
        'This task installs its language servers in a composed image, and that CLI provider is not available to you.',
      );
    }
    if (!provider.enabled) {
      return refuse(
        { code: 'disabled_provider', providerId: id },
        `This task installs its language servers in a composed image, and the CLI provider "${provider.name}" is disabled.`,
      );
    }
    if (!COMPOSED_LSP_VERIFIED_PROVIDER_NAMES.includes(provider.name)) {
      return refuse(
        { code: 'unverified_provider', providerId: id, providerName: provider.name },
        `This task installs its language servers in a composed image that only Claude Code can launch, so "${provider.name}" cannot run it.`,
      );
    }
  }
  if (ids.length > 1) {
    return refuse(
      { code: 'multiple_providers', providerIds: ids },
      'This task installs its language servers in a composed image that one Claude Code provider row runs, and a second row was chosen.',
    );
  }
  return { ok: true, providerId: ids[0]! };
}

/** Explicit choices use dispatch's effective-image set. Before the first image, retain the
 * task's one verified provider row; after a build the retained image determines that row. */
export function decideTaskComposedLspProvider(args: {
  taskCliProviderId: string | null;
  providerId: string;
  providers: readonly (ComposedLspLockProvider & { createdAt: Date })[];
  composedProviderIds: readonly string[];
}): ComposedLspLockDecision {
  const allowed = composedLspAllowedSet(args.providers, args.composedProviderIds)!;
  const baseline =
    args.composedProviderIds.length > 0
      ? [...allowed]
      : [resolveTaskCliProviderId(args.taskCliProviderId, args.providers)];
  return decideComposedLspProviderLock({
    providers: args.providers,
    effectiveProviderIds: [...baseline, args.providerId],
  });
}

export type ComposedLspProviderRestriction = {
  code: ComposedLspLockViolation['code'];
  message: string;
};

/** Server-side picker projection of the same decision the locked writer makes. */
export function composedLspProviderRestrictions(args: {
  taskCliProviderId: string | null;
  providers: readonly (ComposedLspLockProvider & { createdAt: Date })[];
  composedProviderIds: readonly string[] | undefined;
}): Record<string, ComposedLspProviderRestriction> | undefined {
  if (args.composedProviderIds === undefined) return undefined;
  const composedProviderIds = args.composedProviderIds;
  return Object.fromEntries(
    args.providers.flatMap((p) => {
      const decision = decideTaskComposedLspProvider({
        ...args,
        composedProviderIds,
        providerId: p.id,
      });
      return decision.ok
        ? []
        : [[p.id, { code: decision.violation.code, message: decision.message }]];
    }),
  );
}

/** The lock verdict for putting `providerId` on a task, or null when the task has no composed-LSP contract. */
export async function checkTaskComposedLspProvider(
  db: Pick<Database, 'query'>,
  params: { userId: string; taskId: string; providerId: string },
): Promise<ComposedLspLockDecision | null> {
  const { userId, taskId, providerId } = params;
  const task = await db.query.tasks.findFirst({
    where: and(eq(schema.tasks.id, taskId), eq(schema.tasks.userId, userId)),
    columns: { cliProviderId: true, envTemplateId: true, metadata: true },
  });
  if (!task?.envTemplateId) return null;
  const template = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
    columns: { declaredDeps: true },
  });
  if (template?.declaredDeps?.lspInstallContractVersion !== 2) return null;
  const providers = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { id: true, name: true, enabled: true, createdAt: true },
  });
  // Unreadable pins cannot expand eligibility beyond the verified, pre-image rule.
  let composedProviderIds: string[] = [];
  try {
    composedProviderIds = parseImageReferences(task.metadata)
      .entries.filter((entry) => entry.effective)
      .map((entry) => entry.providerId);
  } catch {
    /* The dispatcher refuses malformed pins; writes retain the conservative lock. */
  }
  return decideTaskComposedLspProvider({
    taskCliProviderId: task.cliProviderId,
    providerId,
    providers,
    composedProviderIds,
  });
}

/**
 * Lock the task row (`FOR NO KEY UPDATE`, so child inserts that take KEY SHARE on the task do not
 * block) and return its provider choice, or null when the task is not the user's.
 *
 * Taken by every writer of a provider choice (step CLI choice, CLIs-tab write, summary CLI, the
 * model-health default rewrite on the step-CLI route, fix-round choice) and by every writer that
 * newly links a task to a contract-2 template (step 01 replacement, step 01 new-environment
 * adoption). Each decides inside it, reading what it needs again after the lock is held.
 *
 * Order, outermost first: 1 repository (its task key `lockRepositoryTasksKey`, then its row FOR
 * UPDATE: repository delete and task revival); 2 the task's step rows, one id-ordered batch
 * (`lockStepRows`); 3 this lock, the task row; 4 leaf rows (provider rows and step rows through
 * foreign keys as KEY SHARE, saved preference rows, the template row, task events). Step 01
 * inserts its template row (KEY SHARE on the repository row), then fences its step row
 * FOR NO KEY UPDATE, before taking this task lock, so it never
 * asks for the repository after the task row. The provider-row writers (`lockLoginSet`,
 * `markProvidersReady`) never take a task or step row. One inversion: DELETE of a provider holds
 * the provider row and then needs the task rows its SET NULL rewrites, while a holder of this lock
 * needs that provider's KEY SHARE (the choice inserts through their foreign key, the summary
 * route's update); Postgres aborts one of the two (40P01) and the state stays consistent.
 *
 * Step 02's relink onto a row with the same Dockerfile hash takes no lock: the hash covers the
 * declared deps, and so the contract key, so it moves a task only between rows of one contract.
 * Its fork of a row other tasks link (a changed body) takes none either: one transaction inserts
 * the row and then links the task, as step 01 orders its inserts, and the fork carries the row's
 * declared deps, so the task stays on one contract. Saved preferences are user-wide, so a
 * remembered pick made on another task is not ordered against this task's decision.
 */
export async function lockTaskForComposedLsp(
  tx: Pick<Database, 'select'>,
  params: { userId: string; taskId: string },
): Promise<{ cliProviderId: string | null } | null> {
  const [row] = await tx
    .select({ cliProviderId: schema.tasks.cliProviderId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, params.taskId), eq(schema.tasks.userId, params.userId)))
    .for('no key update');
  return row ?? null;
}

/** Stable retry guidance after a deadlock or a provider deleted since admission. */
export class ComposedLspWriteBusyError extends Error {
  readonly code = 'composed_lsp_write_busy';
  readonly retryable = true;
  constructor(cause?: unknown) {
    super('The CLI provider changed concurrently. Retry this action.', { cause });
    this.name = 'ComposedLspWriteBusyError';
  }
}

/** Retry one completed top-level transaction. A savepoint cannot release outer task locks,
 * so a transaction handle reports busy immediately instead of recreating the same cycle. */
export async function withComposedLspTransaction<T>(
  db: Database | DbTx,
  work: (tx: DbTx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(work);
    } catch (error) {
      if (!hasPgCode(error, '40P01')) throw error;
      const busy = new ComposedLspWriteBusyError(error);
      if (attempt > 0 || is(db, PgTransaction)) throw busy;
      logger.warn(
        { err: busy, attempt: attempt + 1 },
        'retrying composed LSP provider transaction',
      );
    }
  }
}

export class ComposedLspProviderLockedError extends Error {
  readonly code = COMPOSED_LSP_PROVIDER_LOCKED;
  constructor(message: string) {
    super(message);
    this.name = 'ComposedLspProviderLockedError';
  }
}

/** Common task-local choice writer. Call inside the caller's transaction so the lock
 * covers its associated preference/transition writes too. Null clears the choice. */
export async function writeLockedStepCliChoice(
  tx: DbTx,
  params: {
    userId: string;
    taskId: string;
    stepId: string;
    role: string;
    cliProviderId: string | null;
    effortLevel: string | null;
  },
): Promise<void> {
  const { userId, ...choice } = params;
  if (choice.cliProviderId) {
    await lockTaskForComposedLsp(tx, { userId, taskId: choice.taskId });
    await assertComposedLspWriteProviderAvailable(tx, userId, choice.cliProviderId);
    const decision = await checkTaskComposedLspProvider(tx, {
      userId,
      taskId: choice.taskId,
      providerId: choice.cliProviderId,
    });
    if (decision && !decision.ok) throw new ComposedLspProviderLockedError(decision.message);
  }
  await tx
    .insert(schema.taskStepCliChoices)
    .values(choice)
    .onConflictDoUpdate({
      target: [
        schema.taskStepCliChoices.taskId,
        schema.taskStepCliChoices.stepId,
        schema.taskStepCliChoices.role,
      ],
      set: {
        cliProviderId: choice.cliProviderId,
        effortLevel: choice.effortLevel,
        updatedAt: new Date(),
      },
    });
}

export class ComposedLspProviderDisabledError extends Error {
  readonly code = 'cli_provider_disabled';
  constructor() {
    super('The selected CLI provider is disabled. Enable it again or choose another CLI.');
    this.name = 'ComposedLspProviderDisabledError';
  }
}

/** A deleted provider is a concurrent loss; a disabled provider needs a person's action. */
export async function assertComposedLspWriteProviderAvailable(
  tx: Pick<Database, 'query'>,
  userId: string,
  providerId: string,
): Promise<void> {
  const provider = await tx.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, providerId), eq(schema.cliProviders.userId, userId)),
    columns: { enabled: true },
  });
  if (!provider) throw new ComposedLspWriteBusyError();
  if (!provider.enabled) throw new ComposedLspProviderDisabledError();
}
