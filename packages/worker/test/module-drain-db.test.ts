import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { beginModuleDrain, cancelModuleDrain } from '@haive/shared/modularity-server';
import { insertFixedStampedRun } from '../src/step-engine/step-integrations.js';

const url = process.env.MODULE_DEACTIVATION_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_deactivation_api_test_330_'))
  throw new Error('Use a dedicated T330 database for the module drain dispatch fixture');

describe.skipIf(!url)('a later fixed fan-out stamp during a module drain, on Postgres', () => {
  let db: Database;
  const userId = randomUUID();
  const moduleId = 'drain-dispatch';
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'fixture',
      emailBlindIndex: userId,
      passwordHash: 'fixture',
      status: 'active',
    });
    await db.insert(schema.modules).values({
      moduleId,
      packageName: `@haive/module-${moduleId}`,
      name: moduleId,
      installedVersion: '1.0.0',
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, moduleId));
    await db.$client.end({ timeout: 5 });
  });
  const bindings = [
    {
      requirementId: 'docs',
      categoryId: 'mail',
      providerId: `module.${moduleId}.docs`,
      connectionId: userId,
      access: 'read' as const,
    },
  ];
  async function task(uses: boolean) {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'Drain fixture',
        status: 'running',
        runListSnapshot: uses ? [`module.${moduleId}.step`] : ['01-worktree-setup'],
      })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '01-worktree-setup',
        title: 'Fan-out',
        stepIndex: 0,
        status: 'waiting_cli',
      })
      .returning();
    return { taskId: task!.id, stepId: step!.id };
  }
  it('preserves a cohort member stamp, parks a new dependency with no invocation, and retries after explicit cancel', async () => {
    const member = await task(true);
    const outsider = await task(false);
    await beginModuleDrain(db, moduleId, userId);
    const record = ({ taskId, stepId }: typeof member) =>
      insertFixedStampedRun(
        db,
        taskId,
        stepId,
        { taskId, taskStepId: stepId, mode: 'agent_mining', prompt: 'fixture' },
        bindings,
      );
    const accepted = await record(member);
    expect(accepted).toHaveProperty('integrations', bindings);
    const refused = await record(outsider);
    expect(refused).toMatchObject({
      blocked: { kind: 'wait', wait: { causes: [{ reason: 'module-draining' }] } },
    });
    expect(
      await db
        .select()
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.taskId, outsider.taskId)),
    ).toEqual([]);
    await cancelModuleDrain(db, moduleId, userId);
    expect(await record(outsider)).toHaveProperty('integrations', bindings);
  });
});
