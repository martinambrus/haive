import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  ACCOUNT_LABEL,
  SIGNING_KEY,
  deleteUsers,
  grantsOf,
  runsOf,
  seedBareWorld,
  seedProvider,
  seedTask,
  seedWorld,
  stampIsSqlNull,
} from './support/step-integrations-db.js';
import {
  BAD_REQUIREMENTS,
  FORGE_READ,
  FORGE_WRITE,
  pinnedPromptStep,
} from './support/prompt-step-integrations.js';

// Controls of J6a (task #185), worker side, on Postgres. Tags: [C3] is inside the brief, [C3+] is a pin the
// brief does not state (listed in the harness README), [C0] passes before and after.

const url = process.env.PROMPT_STEP_INTEGRATIONS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/prompt_step_integrations_test'))
  throw new Error(
    'Use a dedicated prompt_step_integrations_test database for the prompt step integration tests',
  );

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getNumber: async (_key: string, fallback = 0) => fallback,
    getBoolean: async (_key: string, fallback = false) => fallback,
  },
}));
vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));

import { advanceStep } from '../src/step-engine/step-runner.js';

const READ_TOOL = 'get_pull_request_state';
const WRITE_TOOL = 'open_pull_request';

describe.skipIf(!url)(
  'a pinned prompt step that declares integrations is dispatched with them',
  () => {
    let db: Database;
    const users: string[] = [];
    const enqueued: CliExecJobPayload[] = [];
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
      enqueued.length = 0;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
      else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
    });

    /** A user, a repository with a GitHub remote and a task, one GitHub account unless `connected` is false, and a CLI. */
    async function world(connected = true) {
      const w = connected
        ? await seedWorld(db)
        : { ...(await seedBareWorld(db)), connectionId: null };
      users.push(w.userId);
      const claude = await seedProvider(db, w.userId, 'claude-code');
      return { ...w, claude };
    }

    /** The task pins the prompt step at create (tasks.custom_steps); the worker reads it back and builds the step from it. */
    async function advance(
      w: { userId: string; taskId: string; claude: CliProviderRecord },
      integrations: unknown[] | undefined,
    ) {
      const { stepDef, stored } = pinnedPromptStep(integrations);
      await db
        .update(schema.tasks)
        .set({ customSteps: stored })
        .where(eq(schema.tasks.id, w.taskId));
      return advanceStep({
        db,
        taskId: w.taskId,
        userId: w.userId,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: w.claude.id,
        stepDef: stepDef as StepDefinition,
        providers: [w.claude],
        deps: { enqueueCliInvocation: async (payload) => void enqueued.push(payload) },
        runSeq: 0,
        epoch: 0,
        moduleDeactivation: null,
      });
    }

    const stepRow = async (taskId: string) => {
      const [row] = await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId));
      return row!;
    };

    async function expectNothingWritten(taskId: string) {
      expect(await runsOf(db, taskId), 'cli_invocations rows').toEqual([]);
      expect(await grantsOf(db, taskId), 'task grants').toEqual([]);
      expect(enqueued, 'enqueues').toEqual([]);
    }

    const stampOf = (connectionId: string | null, access: 'read' | 'write') => [
      {
        requirementId: 'forge',
        categoryId: 'forge',
        providerId: 'github',
        connectionId,
        access,
      },
    ];

    describe('[C3] a requirement that resolves', () => {
      it('[C3] queues one run stamped with the binding, records the grant, and names the read tool only', async () => {
        const w = await world();

        const result = await advance(w, [FORGE_READ]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.integrations).toEqual(stampOf(w.connectionId, 'read'));
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: 'forge', connectionId: w.connectionId },
        ]);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ invocationId: runs[0]!.id });
        expect(runs[0]!.prompt).toContain('haive-integrations');
        expect(runs[0]!.prompt).toContain('GitHub');
        expect(runs[0]!.prompt).toContain(READ_TOOL);
        expect(runs[0]!.prompt).not.toContain(WRITE_TOOL);
        expect(runs[0]!.prompt).not.toContain(ACCOUNT_LABEL);
      }, 60_000);

      it('[C3] adds the write tool for a write requirement once the owner switched writes on for the provider', async () => {
        const w = await world();
        await db
          .insert(schema.integrationUserSettings)
          .values({ userId: w.userId, providerId: 'github', writeEnabled: true });

        const result = await advance(w, [FORGE_WRITE]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.integrations).toEqual(stampOf(w.connectionId, 'write'));
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: 'forge', connectionId: w.connectionId },
        ]);
        expect(runs[0]!.prompt).toContain(READ_TOOL);
        expect(runs[0]!.prompt).toContain(WRITE_TOOL);
        expect(runs[0]!.prompt).not.toContain(ACCOUNT_LABEL);
      }, 60_000);

      it('[C3+] names the read tool only for a write requirement while the owner has writes off', async () => {
        const w = await world();

        const result = await advance(w, [FORGE_WRITE]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.integrations).toEqual(stampOf(w.connectionId, 'write'));
        expect(runs[0]!.prompt).toContain(READ_TOOL);
        expect(runs[0]!.prompt).not.toContain(WRITE_TOOL);
      }, 60_000);
    });

    describe('[C3+] a requirement that does not resolve', () => {
      it('[C3+] fails the step integration-unresolved naming the requirement, and writes nothing', async () => {
        const w = await world(false);

        const result = await advance(w, [FORGE_READ]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.status).toBe('failed');
        expect(row.errorMessage?.startsWith('integration-unresolved: ')).toBe(true);
        expect(row.errorMessage).toContain('forge');
        expect(row.errorMessage).toMatch(/no[- ]connection/);
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[C3+] lets the step run, unstamped, when the requirement is marked optional, while a required one still fails', async () => {
        const w = await world(false);

        const result = await advance(w, [{ ...FORGE_READ, optional: true }]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
        expect(await grantsOf(db, w.taskId)).toEqual([]);
        expect(enqueued).toHaveLength(1);
        const other = { ...w, taskId: await seedTask(db, w.userId, w.repositoryId) };
        expect(
          (await advance(other, [FORGE_READ])).status,
          'a required requirement was let through',
        ).toBe('failed');
      }, 60_000);
    });

    describe('[C3+] a requirement that no longer parses', () => {
      it.each(BAD_REQUIREMENTS)(
        '[C3+] fails the step integration-requirement-invalid and writes no row, though an account would resolve the valid one (%s)',
        async (_label, bad, id) => {
          const w = await world();

          const result = await advance(w, [FORGE_READ, bad]);

          expect(result.status).toBe('failed');
          const row = await stepRow(w.taskId);
          expect(row.status).toBe('failed');
          expect(row.errorMessage).toMatch(/^integration-requirement-invalid\b/);
          expect(row.errorMessage).toContain(id);
          await expectNothingWritten(w.taskId);
        },
        60_000,
      );
    });

    describe('[C0] a pinned prompt step that declares nothing (passes before and after)', () => {
      it('[C0] queues one run with no stamp and no grant', async () => {
        const w = await world();

        const result = await advance(w, undefined);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
        expect(runs[0]!.prompt).not.toContain('haive-integrations');
        expect(await grantsOf(db, w.taskId)).toEqual([]);
        expect(enqueued).toHaveLength(1);
      }, 60_000);
    });
  },
);
