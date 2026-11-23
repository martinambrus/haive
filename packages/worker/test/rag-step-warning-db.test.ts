import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { seedBareWorld, seedStepRow, deleteUsers } from './support/step-integrations-db.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { StepSupersededError } from '../src/step-engine/step-ownership.js';

const seam = vi.hoisted(() => ({
  outcome: 'hashed' as 'hashed' | 'failed',
  closed: vi.fn(),
  released: vi.fn(),
}));
vi.mock('../src/step-engine/steps/_rag-sync-lock.js', () => ({
  acquireRepoRagSyncLock: async () => ({ assertHeld() {}, release: seam.released }),
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: async () => null,
  listFilesMatching: async () => [],
}));
vi.mock('../src/step-engine/steps/onboarding/_scope.js', () => ({
  loadScopeExcludeGlobs: async () => [],
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async (original) => ({
  ...(await original<object>()),
  taskSecretMaskPolicy: async () => ({ globs: { deny: [], ignore: [] } }),
  listTrackedFiles: async () => new Set(['sample.md']),
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-collect.js', async (original) => ({
  ...(await original<object>()),
  collectCodeFiles: async () => [],
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-connection.js', async (original) => ({
  ...(await original<object>()),
  resolveRagConnection: async () => ({
    close: seam.closed,
    pg: { unsafe: async () => Object.assign([], { count: 0 }) },
  }),
  ensureRagSchema: async () => ({ usedPgvector: false }),
}));
vi.mock('../src/step-engine/steps/onboarding/_rag-embed.js', async (original) => ({
  ...(await original<object>()),
  warmOllamaModel: async () => false,
}));
vi.mock('../src/step-engine/steps/_rag-embed-health.js', async (original) => ({
  ...(await original<object>()),
  loadRagEmbedHealth: async () => ({ degradedAt: null, degradedReason: null, lexicalOnly: false }),
  startBannerAwaitsReembed: async () => false,
  resolveEmbedBatchSize: async () => 8,
  recordRagEmbedDegraded: async () => {},
  requireRagEmbedDegraded: async () => {},
  embedBatch: async ({ texts }: { texts: string[] }) =>
    seam.outcome === 'failed'
      ? { kind: 'failed', reason: 'fixture endpoint failure' }
      : { kind: 'hashed', embeddings: texts.map(() => [0.1, 0.2]) },
}));

import { runRagIndexSync } from '../src/step-engine/steps/workflow/_rag-index.js';
import { ragPopulateStep } from '../src/step-engine/steps/onboarding/10-rag-populate.js';
import { RagEmbedFailureError } from '../src/step-engine/steps/_rag-embed-health.js';

const url = process.env.RAG_STEP_WARNING_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/rag_step_warning_test'))
  throw new Error('Use a dedicated rag_step_warning_test database');

// Isolate source discovery, policy, repository health, embedding and RAG/Redis I/O.
// Both real entry points and all task_steps I/O use Postgres, including Retry's reset.
describe.skipIf(!url)('RAG pass warning ownership on Postgres', () => {
  let db: Database;
  let root: string;
  let world: Awaited<ReturnType<typeof seedBareWorld>>;
  beforeAll(async () => {
    db = createDatabase(url!);
    world = await seedBareWorld(db);
    root = await mkdtemp(join(tmpdir(), 'rag-step-warning-'));
    await writeFile(join(root, 'sample.md'), '# Sample\n\nA document about storage.\n');
  });
  afterAll(async () => {
    await deleteUsers(db, [world.userId]);
    await db.$client.end({ timeout: 5 });
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(() => vi.clearAllMocks());
  const read = async (id: string) =>
    (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id)))[0]!;
  const sites = [
    { name: 'workflow initial', workflow: true, write: 1, outcome: 'hashed' },
    { name: 'workflow final', workflow: true, write: 2, outcome: 'hashed' },
    { name: 'onboarding initial', workflow: false, write: 1, outcome: 'hashed' },
    { name: 'onboarding strict failure', workflow: false, write: 2, outcome: 'failed' },
    { name: 'onboarding fallback result', workflow: false, write: 2, outcome: 'hashed' },
  ] as const;
  async function run(site: (typeof sites)[number], handle: Database, id: string) {
    seam.outcome = site.outcome;
    const ctx = {
      db: handle,
      taskId: world.taskId,
      taskStepId: id,
      repoPath: root,
      workspacePath: root,
      emitProgress: async () => {},
      throwIfCancelled() {},
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as StepContext;
    const prefs = {
      ragMode: 'internal' as const,
      ragConnectionString: null,
      ollamaUrl: 'http://fixture.invalid',
      embeddingModel: 'fixture',
      embeddingDimensions: 2,
    };
    if (site.workflow)
      return runRagIndexSync(ctx, {
        repoPath: root,
        prefs,
        projectName: 'fixture',
        ollamaReachable: false,
        codeCollect: {},
      });
    return ragPopulateStep.apply(ctx, {
      detected: {
        ...prefs,
        kbFiles:
          site.name === 'onboarding initial' ? [] : [{ relPath: 'sample.md', sizeBytes: 40 }],
        codeFiles: [],
        ollamaReachable: false,
        projectName: 'fixture',
      },
      formValues: { populateMode: 'full' },
      iteration: 0,
      previousIterations: [],
    });
  }
  for (const site of sites) {
    it(`${site.name} preserves whole-column replacement and clear on an owned row`, async () => {
      const row = await seedStepRow(db, world.taskId, {
        stepId: randomUUID(),
        warningMessage: 'old banner',
      });
      const result = run(site, db, row.id);
      if (site.outcome === 'failed')
        await expect(result).rejects.toBeInstanceOf(RagEmbedFailureError);
      else await result;
      const saved = await read(row.id);
      if (site.workflow || site.name === 'onboarding initial')
        expect(saved.warningMessage).toBeNull();
      else
        expect(saved.warningMessage).toContain(
          site.outcome === 'failed' ? 'unindexed' : 'fallback vectors',
        );
    });
    for (const action of ['Retry', 'Stop', 'Skip'] as const) {
      it(`${site.name} refuses a superseded pass after ${action}`, async () => {
        const row = await seedStepRow(db, world.taskId, {
          stepId: randomUUID(),
          warningMessage: 'retained note',
        });
        let writes = 0;
        let cut: typeof row | undefined;
        const handle = new Proxy(db, {
          get(target, prop) {
            if (prop !== 'update') return Reflect.get(target, prop);
            return (table: typeof schema.taskSteps) => ({
              set: (patch: Record<string, unknown>) => ({
                where: (condition: SQL | undefined) => {
                  const query = target.update(table).set(patch).where(condition);
                  const before = async () => {
                    if (table !== schema.taskSteps || ++writes !== site.write) return;
                    if (action === 'Retry') {
                      expect(
                        await resetStepAndDownstream(db, world.taskId, row.stepId, row.round),
                      ).not.toBeNull();
                    } else {
                      await db
                        .update(schema.taskSteps)
                        .set({ status: action === 'Stop' ? 'failed' : 'skipped' })
                        .where(eq(schema.taskSteps.id, row.id));
                    }
                    // A new note belongs to the replacement attempt/action, never this pass.
                    await db
                      .update(schema.taskSteps)
                      .set({ warningMessage: 'replacement note' })
                      .where(eq(schema.taskSteps.id, row.id));
                    cut = await read(row.id);
                  };
                  return {
                    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                      before()
                        .then(() => query)
                        .then(resolve, reject),
                    returning: async () => {
                      await before();
                      return query.returning();
                    },
                  };
                },
              }),
            });
          },
        });
        const result = await run(site, handle, row.id).then(
          () => null,
          (error: unknown) => error,
        );
        expect(cut).toBeDefined();
        expect(await read(row.id)).toEqual(cut);
        expect(result).toBeInstanceOf(StepSupersededError);
        expect(seam.closed).toHaveBeenCalled();
        expect(seam.released).toHaveBeenCalled();
      });
    }
  }
});
