import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CLI_PROVIDER_CATALOG, type CliProviderName } from '@haive/shared';
import { HttpError } from '../context.js';

/** Validate a requested per-step effort against the resolved provider's effortScale.
 *  Returns the level only when the CLI has an effort knob and the value is in-scale;
 *  otherwise null (so a knob-less CLI, or a stale level such as claude 'max' on codex,
 *  is simply not stored). */
function clampEffort(name: CliProviderName, level: string | null | undefined): string | null {
  if (!level) return null;
  const scale = CLI_PROVIDER_CATALOG[name].effortScale;
  return scale && scale.values.includes(level) ? level : null;
}

/** The user's provider, refused with 404 when it is not theirs and 409 when it is disabled. */
export async function loadUsableProvider(
  db: Pick<Database, 'query'>,
  userId: string,
  cliProviderId: string,
): Promise<{ name: CliProviderName }> {
  const provider = await db.query.cliProviders.findFirst({
    where: and(eq(schema.cliProviders.id, cliProviderId), eq(schema.cliProviders.userId, userId)),
  });
  if (!provider) throw new HttpError(404, 'CLI provider not found');
  if (!provider.enabled) throw new HttpError(409, 'CLI provider is disabled');
  return provider;
}

/** Record one (step, role) CLI choice for THIS task, and, when `remember` is set, as the user's
 *  saved (user, step, role) preference too, which every later task of theirs reads. A pick on a
 *  step card is about the task in front of the person, so it stays there unless they ask for
 *  more. `role: 'default'` targets the single-CLI saved table; any other role the per-role
 *  table, which loop roles and fan-out seats share. Three callers must write it IDENTICALLY: a
 *  change on a step card, and the same change made from the CLIs tab before the step has a row.
 *
 *  Validates the provider first and throws the same 404/409 the card path has always thrown, so
 *  an unknown or disabled provider is rejected before anything is written. A null provider
 *  clears the slot: for this task, and from the saved preferences when remembered. */
export async function writeStepCliChoice(
  db: Database,
  params: {
    userId: string;
    taskId: string;
    stepId: string;
    role: string;
    cliProviderId: string | null;
    requestedEffort: string | null | undefined;
    remember: boolean;
  },
): Promise<void> {
  const { userId, taskId, stepId, role, cliProviderId, remember } = params;
  let effortLevel: string | null = null;
  if (cliProviderId) {
    const provider = await loadUsableProvider(db, userId, cliProviderId);
    effortLevel = clampEffort(provider.name, params.requestedEffort);
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.taskStepCliChoices)
      .values({ taskId, stepId, role, cliProviderId, effortLevel })
      .onConflictDoUpdate({
        target: [
          schema.taskStepCliChoices.taskId,
          schema.taskStepCliChoices.stepId,
          schema.taskStepCliChoices.role,
        ],
        set: { cliProviderId, effortLevel, updatedAt: new Date() },
      });
    if (!remember) return;
    if (!cliProviderId) {
      if (role === 'default') {
        await tx
          .delete(schema.userStepCliPreferences)
          .where(
            and(
              eq(schema.userStepCliPreferences.userId, userId),
              eq(schema.userStepCliPreferences.stepId, stepId),
            ),
          );
        return;
      }
      await tx
        .delete(schema.userStepCliRolePreferences)
        .where(
          and(
            eq(schema.userStepCliRolePreferences.userId, userId),
            eq(schema.userStepCliRolePreferences.stepId, stepId),
            eq(schema.userStepCliRolePreferences.role, role),
          ),
        );
      return;
    }
    if (role === 'default') {
      await tx
        .insert(schema.userStepCliPreferences)
        .values({ userId, stepId, cliProviderId, effortLevel, explicit: true })
        .onConflictDoUpdate({
          target: [schema.userStepCliPreferences.userId, schema.userStepCliPreferences.stepId],
          set: { cliProviderId, effortLevel, explicit: true, updatedAt: new Date() },
        });
      return;
    }
    await tx
      .insert(schema.userStepCliRolePreferences)
      .values({ userId, stepId, role, cliProviderId, effortLevel, explicit: true })
      .onConflictDoUpdate({
        target: [
          schema.userStepCliRolePreferences.userId,
          schema.userStepCliRolePreferences.stepId,
          schema.userStepCliRolePreferences.role,
        ],
        set: { cliProviderId, effortLevel, explicit: true, updatedAt: new Date() },
      });
  });
}
