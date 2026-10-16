import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  getIntegrationProvider,
  integrationTools,
  resolveStepIntegrations,
} from '@haive/shared/integrations';
import type { IntegrationRequirement } from '@haive/shared/modularity';
import { stepIntegrationsUnderTest } from './support/step-integrations-contract.js';
import {
  FORGE_OPTIONAL,
  FORGE_READ,
  PINNED_GITHUB,
  SIGNING_KEY,
  advisoryWaiters,
  bindingsOf,
  deleteUsers,
  grantsOf,
  runValues,
  runsOf,
  seedBareWorld,
  seedConnection,
  seedStepRow,
  seedTask,
  seedWorld,
  sleep,
  stampIsSqlNull,
} from './support/step-integrations-db.js';

const url = process.env.STEP_INTEGRATIONS_STAMP_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_stamp_test'))
  throw new Error('Use a dedicated step_integrations_stamp_test database for the stamp tests');

const lockSql = (taskId: string) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`task-integrations:${taskId}`}, 0))`;
const ISSUES_REQUIRED: IntegrationRequirement = {
  id: 'tracker',
  category: 'issues',
  access: 'read',
};
const ISSUES_OPTIONAL: IntegrationRequirement = { ...ISSUES_REQUIRED, optional: true };

async function rejection(pending: PromiseLike<unknown>): Promise<unknown> {
  try {
    await pending;
    return null;
  } catch (err) {
    return err;
  }
}

describe.skipIf(!url)('the dispatch-time integrations of a step, on Postgres', () => {
  let db: Database;
  const users: string[] = [];
  let savedKey: string | undefined;

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    await deleteUsers(db, users);
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(() => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = SIGNING_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  async function world() {
    const w = await seedWorld(db);
    users.push(w.userId);
    return w;
  }

  async function bareWorld() {
    const w = await seedBareWorld(db);
    users.push(w.userId);
    return w;
  }

  /** Two accounts, a task choice on the first and the owner's preference on the second. */
  async function twoAccountWorld() {
    const w = await world();
    const second = await seedConnection(db, w.userId, { label: 'second-account' });
    await db.insert(schema.taskIntegrationChoices).values({
      taskId: w.taskId,
      categoryId: 'forge',
      providerId: 'github',
      connectionId: w.connectionId,
    });
    await db.insert(schema.integrationCategoryPreferences).values({
      userId: w.userId,
      categoryId: 'forge',
      providerId: 'github',
      connectionId: second,
    });
    return { ...w, first: w.connectionId, second };
  }

  const dropChoice = (taskId: string) =>
    db.transaction(async (tx) => {
      await tx.execute(lockSql(taskId));
      await tx
        .delete(schema.taskIntegrationChoices)
        .where(
          and(
            eq(schema.taskIntegrationChoices.taskId, taskId),
            eq(schema.taskIntegrationChoices.categoryId, 'forge'),
          ),
        );
      await tx
        .delete(schema.integrationGrants)
        .where(
          and(
            eq(schema.integrationGrants.targetKind, 'task'),
            eq(schema.integrationGrants.taskId, taskId),
            eq(schema.integrationGrants.categoryId, 'forge'),
          ),
        );
    });

  describe('[D3] insertStampedRun: the grant and the stamped row, in one transaction', () => {
    it('[D3] the fixture: the resolver resolves the required requirement for this task today', async () => {
      const w = await world();

      const resolutions = await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]);

      expect(resolutions).toMatchObject([
        {
          status: 'resolved',
          categoryId: 'forge',
          providerId: 'github',
          connectionId: w.connectionId,
        },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });

    it('[D3] writes the task grant and the stamped row, the stamp being the resolution', async () => {
      const w = await world();
      const step = await seedStepRow(db, w.taskId);
      const expected = bindingsOf(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]),
      );
      expect(expected).toHaveLength(1);
      const mod = await stepIntegrationsUnderTest();

      await mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [FORGE_READ]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ taskStepId: step.id, mode: 'cli', prompt: 'a prompt' });
      expect(runs[0]!.integrations).toEqual(expected);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
      ]);
    });

    it('[D3] writes no grant and no row when insertOwnedRun throws StepSupersededError', async () => {
      const w = await world();
      const lost = await seedStepRow(db, w.taskId, { status: 'failed' });
      const mod = await stepIntegrationsUnderTest();

      const err = await rejection(
        mod.insertStampedRun(db, w.taskId, lost.id, runValues(w.taskId, lost.id), [FORGE_READ]),
      );

      expect(err, 'the superseded pass was not refused').toBeInstanceOf(Error);
      expect((err as Error).name).toBe('StepSupersededError');
      expect(await grantsOf(db, w.taskId)).toEqual([]);
      expect(await runsOf(db, w.taskId)).toEqual([]);
    });

    it('[D3] stamps SQL NULL, not an empty list, and writes no grant, when nothing is bound', async () => {
      const w = await bareWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();

      await mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
        FORGE_OPTIONAL,
      ]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });

    it('[D3+] stamps SQL NULL for an empty requirement list', async () => {
      const w = await world();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();

      await mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), []);

      const runs = await runsOf(db, w.taskId);
      expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });

    it('[D3+] gives every row of a fan-out the same stamp and the task one grant', async () => {
      const w = await world();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      const expected = bindingsOf(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]),
      );

      for (const agent of ['a', 'b', 'c']) {
        await mod.insertStampedRun(
          db,
          w.taskId,
          step.id,
          runValues(w.taskId, step.id, { mode: 'agent_mining', prompt: agent }),
          [FORGE_READ],
        );
      }

      const runs = await runsOf(db, w.taskId);
      expect(runs.map((run) => run.prompt)).toEqual(['a', 'b', 'c']);
      for (const run of runs) expect(run.integrations).toEqual(expected);
      expect(await grantsOf(db, w.taskId)).toHaveLength(1);
    });
  });

  describe('[D4] [D5] [D13] resolveDispatchIntegrations: what a dispatch may carry, or why it may not', () => {
    it('[D4] returns the bindings and the resolutions when every requirement resolves', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();
      const resolutions = await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]);

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bindings).toEqual(bindingsOf(resolutions));
      expect(result.resolutions).toEqual(resolutions);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });

    it('[D4] fails a required requirement that does not resolve, naming it, its category and why', async () => {
      const w = await bareWorld();
      const mod = await stepIntegrationsUnderTest();

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith(`${mod.INTEGRATION_UNRESOLVED_REASON}: `)).toBe(true);
      expect(result.failure).toContain(FORGE_READ.id);
      expect(result.failure).toContain('forge');
      expect(result.failure).toMatch(/no[- ]connection/);
    });

    it('[D4] names the requirement that failed, not one that resolved', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [
        FORGE_READ,
        ISSUES_REQUIRED,
      ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integration-unresolved: ')).toBe(true);
      expect(result.failure).toContain('tracker');
      expect(result.failure).toContain('issues');
    });

    it('[D4] drops an optional requirement that does not resolve and goes on with the rest', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [
        FORGE_READ,
        ISSUES_OPTIONAL,
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bindings.map((binding) => binding.requirementId)).toEqual([FORGE_READ.id]);
      expect(result.resolutions.map((resolution) => resolution.status)).toEqual([
        'resolved',
        'unresolved',
      ]);
    });

    it('[D4] carries nothing, and does not fail, when the only requirement is optional and unresolved', async () => {
      const w = await bareWorld();
      const mod = await stepIntegrationsUnderTest();

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_OPTIONAL]);

      expect(result).toMatchObject({ ok: true, bindings: [] });
    });

    it('[D5] refuses a requirement that pins a provider, though an account would resolve it', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();
      expect(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [PINNED_GITHUB]),
        'the fixture: the pin resolves',
      ).toMatchObject([{ status: 'resolved', providerId: 'github', connectionId: w.connectionId }]);

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [PINNED_GITHUB]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith(`${mod.INTEGRATION_PROVIDER_PINNED_REASON}: `)).toBe(true);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });

    it('[D5+] names the requirement that pins the provider', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [PINNED_GITHUB]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toContain(PINNED_GITHUB.id);
    });

    it('[D13] fails with the signing-key reason when CONFIG_ENCRYPTION_KEY is not set', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();
      delete process.env.CONFIG_ENCRYPTION_KEY;

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith(`${mod.INTEGRATIONS_NO_SIGNING_KEY_REASON}: `)).toBe(true);
    });

    it('[D13] fails with the unlistable reason when the tool names of the bindings break the grammar', async () => {
      const w = await world();
      const mod = await stepIntegrationsUnderTest();
      const digitFirst: IntegrationRequirement[] = [
        { id: '1st-forge', category: 'forge', access: 'read' },
        { id: '2nd-forge', category: 'forge', access: 'read' },
      ];
      const bindings = bindingsOf(
        await resolveStepIntegrations(db, { taskId: w.taskId }, digitFirst),
      );
      expect(
        () => integrationTools(bindings, getIntegrationProvider, { writeAllowed: () => true }),
        'the fixture: these names are not listable',
      ).toThrow(/tool name must match/);

      const result = await mod.resolveDispatchIntegrations(db, w.taskId, digitFirst);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith(`${mod.INTEGRATION_TOOLS_UNLISTABLE_REASON}: `)).toBe(true);
      expect(await grantsOf(db, w.taskId)).toEqual([]);
    });
  });

  describe('[D9] a change of the task choice that lands before the stamp', () => {
    it('[D9] the fixture: the choice makes the first account win and its deletion the second', async () => {
      const w = await twoAccountWorld();
      const asked = { taskId: w.taskId };

      const before = await resolveStepIntegrations(db, asked, [FORGE_READ]);
      await dropChoice(w.taskId);
      const after = await resolveStepIntegrations(db, asked, [FORGE_READ]);

      expect(before).toMatchObject([{ status: 'resolved', connectionId: w.first, source: 'task' }]);
      expect(after).toMatchObject([{ status: 'resolved', connectionId: w.second, source: 'user' }]);
    });

    it('[D9] stamps what the deletion left, not what the dispatch saw before it', async () => {
      const w = await twoAccountWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      const early = await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);
      expect(early).toMatchObject({ ok: true, bindings: [{ connectionId: w.first }] });
      await dropChoice(w.taskId);

      await mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [FORGE_READ]);

      const [run] = await runsOf(db, w.taskId);
      expect(run!.integrations).toEqual([
        {
          requirementId: FORGE_READ.id,
          categoryId: 'forge',
          providerId: 'github',
          connectionId: w.second,
          access: 'read',
        },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.second },
      ]);
    });

    it('[D9] waits while a choice change holds the task lock, then stamps what the change left', async () => {
      const w = await twoAccountWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const change = db.transaction(async (tx) => {
        await tx.execute(lockSql(w.taskId));
        held.resolve();
        await release.promise;
        await tx
          .delete(schema.taskIntegrationChoices)
          .where(eq(schema.taskIntegrationChoices.taskId, w.taskId));
      });
      await held.promise;

      try {
        const stamp = mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
          FORGE_READ,
        ]);

        expect(await Promise.race([stamp, sleep(700).then(() => 'waiting')])).toBe('waiting');
        expect(await advisoryWaiters(db), 'it waits on the advisory lock').toBeGreaterThanOrEqual(
          1,
        );
        expect(await runsOf(db, w.taskId)).toEqual([]);
        release.resolve();
        await change;
        await stamp;

        const [run] = await runsOf(db, w.taskId);
        expect(run!.integrations).toMatchObject([{ connectionId: w.second }]);
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: 'forge', connectionId: w.second },
        ]);
      } finally {
        release.resolve();
        await change.catch(() => undefined);
      }
    });

    it('[D9+] is not delayed by the lock of another task', async () => {
      const w = await world();
      const other = await seedTask(db, w.userId, w.repositoryId);
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const holder = db.transaction(async (tx) => {
        await tx.execute(lockSql(other));
        held.resolve();
        await release.promise;
      });
      await held.promise;

      try {
        const stamp = mod.insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
          FORGE_READ,
        ]);

        expect(
          await Promise.race([stamp.then(() => 'done'), sleep(3000).then(() => 'waiting')]),
        ).toBe('done');
      } finally {
        release.resolve();
        await holder;
      }
    });
  });

  describe('[A] the account a prompt names is the account the run is stamped with', () => {
    const named = (id: string, connectionId: string | null) => new Map([[id, connectionId]]);

    const loseAccount = (connectionId: string) =>
      db
        .delete(schema.integrationConnections)
        .where(eq(schema.integrationConnections.id, connectionId));

    /** The failure text, after checking that the dispatch was refused and wrote nothing. */
    async function refusedText(result: unknown, reason: string, taskId: string): Promise<string> {
      expect(result, 'the run was stamped with an account the prompt does not name').toHaveProperty(
        'failure',
      );
      const { failure } = result as { failure: string };
      expect(reason).toBe('integration-account-changed');
      expect(failure.startsWith(`${reason}: `)).toBe(true);
      expect(await runsOf(db, taskId), 'cli_invocations rows').toEqual([]);
      expect(await grantsOf(db, taskId), 'task grants').toEqual([]);
      return failure;
    }

    it('[A1] refuses to stamp, naming the requirement, when the choice moved to another account since the first resolution', async () => {
      const w = await twoAccountWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      expect(await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_READ])).toMatchObject({
        ok: true,
        bindings: [{ connectionId: w.first }],
      });
      await dropChoice(w.taskId);

      const result = await mod.insertStampedRun(
        db,
        w.taskId,
        step.id,
        runValues(w.taskId, step.id),
        [FORGE_READ],
        named(FORGE_READ.id, w.first),
      );

      const failure = await refusedText(result, mod.INTEGRATION_ACCOUNT_CHANGED_REASON, w.taskId);
      expect(failure).toContain(FORGE_READ.id);
    });

    it('[A1] refuses to stamp when an account was connected after the prompt was told there was none', async () => {
      const w = await bareWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      expect(await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_OPTIONAL])).toMatchObject({
        ok: true,
        bindings: [],
      });
      await seedConnection(db, w.userId);
      expect(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_OPTIONAL]),
        'the fixture: an account resolves now',
      ).toMatchObject([{ status: 'resolved' }]);

      const result = await mod.insertStampedRun(
        db,
        w.taskId,
        step.id,
        runValues(w.taskId, step.id),
        [FORGE_OPTIONAL],
        named(FORGE_OPTIONAL.id, null),
      );

      const failure = await refusedText(result, mod.INTEGRATION_ACCOUNT_CHANGED_REASON, w.taskId);
      expect(failure).toContain(FORGE_OPTIONAL.id);
    });

    it('[A1] refuses to stamp when the account the prompt named is gone and the requirement is optional', async () => {
      const w = await world();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      expect(await mod.resolveDispatchIntegrations(db, w.taskId, [FORGE_OPTIONAL])).toMatchObject({
        ok: true,
        bindings: [{ connectionId: w.connectionId }],
      });
      await loseAccount(w.connectionId);
      expect(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_OPTIONAL]),
        'the fixture: no account resolves now',
      ).toMatchObject([{ status: 'unresolved' }]);

      const result = await mod.insertStampedRun(
        db,
        w.taskId,
        step.id,
        runValues(w.taskId, step.id),
        [FORGE_OPTIONAL],
        named(FORGE_OPTIONAL.id, w.connectionId),
      );

      const failure = await refusedText(result, mod.INTEGRATION_ACCOUNT_CHANGED_REASON, w.taskId);
      expect(failure).toContain(FORGE_OPTIONAL.id);
    });

    it('[A0] stamps the account the prompt named while the choice is still the one it named', async () => {
      const w = await twoAccountWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();

      await mod.insertStampedRun(
        db,
        w.taskId,
        step.id,
        runValues(w.taskId, step.id),
        [FORGE_READ],
        named(FORGE_READ.id, w.first),
      );

      const [run] = await runsOf(db, w.taskId);
      expect(run!.integrations).toMatchObject([
        { requirementId: FORGE_READ.id, connectionId: w.first },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.first },
      ]);
    });

    it('[A0] stamps the new account of a requirement the prompt does not name', async () => {
      const w = await twoAccountWorld();
      const step = await seedStepRow(db, w.taskId);
      const mod = await stepIntegrationsUnderTest();
      await dropChoice(w.taskId);

      await mod.insertStampedRun(
        db,
        w.taskId,
        step.id,
        runValues(w.taskId, step.id),
        [FORGE_READ, ISSUES_OPTIONAL],
        named(ISSUES_OPTIONAL.id, null),
      );

      const [run] = await runsOf(db, w.taskId);
      expect(run!.integrations).toMatchObject([
        { requirementId: FORGE_READ.id, connectionId: w.second },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.second },
      ]);
    });
  });
});
