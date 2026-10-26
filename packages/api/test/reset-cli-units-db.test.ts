import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { secretsService } from '@haive/shared';
import { deriveRenderTargets, type RenderContextColumn } from '@haive/shared/project-state';

const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (new URL(url).port !== '46537' || new URL(url).pathname !== '/codex_t118_cli_union_20261026')
)
  throw new Error('Use only the assigned T118 scratch database');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  failRemoveRel: null as string | null,
  failed: false,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getRepoQueue: () => ({}) }));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    removeNoFollow: async (...args: Parameters<typeof real.removeNoFollow>) => {
      if (args[1] === h.failRemoveRel) {
        h.failed = true;
        throw Object.assign(new Error('fixture CLI removal I/O failure'), { code: 'EIO' });
      }
      return real.removeNoFollow(...args);
    },
  };
});
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const names = ['claude-code', 'codex', 'future-cli'];
function context(cliTargets: string[]): RenderContextColumn {
  const { skillDirs: _dirs, ...targets } = deriveRenderTargets(cliTargets, []);
  return {
    projectInfo: { name: 'Reset membership' },
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkEnabled: false,
    rtkChoiceRecorded: true,
    cliTargets,
    ...targets,
  };
}
const workerWrite = new URL('../../worker/src/project-state/write.ts', import.meta.url).pathname;
const workerRead = new URL('../../worker/src/project-state/sync.ts', import.meta.url).pathname;

describe.skipIf(!url)('recorded CLI units through actual reset route', () => {
  let db: Database, root: string, userId: string, repositoryId: string, cookie: string;
  let write: (
    db: Database,
    args: { repositoryId: string; repoPath: string; column: RenderContextColumn },
  ) => Promise<unknown>;
  let read: (root: string) => Promise<{ kind: string }>;
  const app = new Hono<AppEnv>();
  app.route('/repositories', repoRoutes);
  app.onError(errorHandler);
  const reset = () =>
    app.request(`/repositories/${repositoryId}/onboarding-artifacts`, {
      method: 'DELETE',
      headers: { cookie },
    });
  const cliPath = (name: string) => path.join(root, '.haive-data/state/cli', `${name}.json`);
  const exists = async (file: string) =>
    stat(file).then(
      () => true,
      () => false,
    );
  const writeContext = async (members: string[]) => {
    await db
      .update(schema.repositories)
      .set({ renderContext: context(members) })
      .where(eq(schema.repositories.id, repositoryId));
    await write(db, { repositoryId, repoPath: root, column: context(members) });
  };
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    write = (await import(workerWrite)).writeProjectStateColumn;
    read = (await import(workerRead)).readCheckout;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.failRemoveRel = null;
    h.failed = false;
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('ab'.repeat(32));
    userId = randomUUID();
    repositoryId = randomUUID();
    root = await mkdtemp(path.join(tmpdir(), 't118-reset-cli-'));
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'synthetic',
      emailBlindIndex: userId,
      passwordHash: 'fixture',
      status: 'active',
      role: 'user',
    });
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'Reset membership',
      source: 'upload',
      status: 'ready',
      storagePath: root,
      onboardedAt: new Date(),
      renderContext: context(names),
      rtkEnabled: false,
    });
    await writeContext(names);
    expect((await read(root)).kind).toBe('record');
    for (const name of names)
      expect(JSON.parse(await readFile(cliPath(name), 'utf8'))).toEqual({ provider: name });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  async function resetAndRewrite() {
    const response = await reset();
    expect(response.status, await response.clone().text()).toBe(200);
    for (const name of names) expect.soft(await exists(cliPath(name)), name).toBe(false);
    expect.soft(await exists(path.join(root, '.haive-data/state/cli'))).toBe(false);
    expect.soft(await exists(path.join(root, '.haive-data/state'))).toBe(false);
    expect.soft((await read(root)).kind).toBe('absent');
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect(repo!.renderContext).toBe(null);
    expect(repo!.onboardedAt).toBe(null);
    expect(repo!.onboardingResetAt).toBeInstanceOf(Date);
    expect(
      await db
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, repositoryId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.projectStateOutbox)
        .where(eq(schema.projectStateOutbox.repositoryId, repositoryId)),
    ).toEqual([]);
    let failure: unknown = null;
    try {
      await writeContext([]);
    } catch (error) {
      failure = error;
    }
    expect
      .soft(failure, 'ordinary new writer must recover after reset without manual cleanup')
      .toBe(null);
    expect.soft((await read(root)).kind).toBe('record');
    const rewritten = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect
      .soft((rewritten!.renderContext as { cliTargets?: string[] } | null)?.cliTargets)
      .toEqual([]);
  }
  it('takes writer-recorded known and future names before clearing their column/base, then permits rewriting', async () => {
    await resetAndRewrite();
  });
  it('uses the recorded sync base when the current column is NULL', async () => {
    await db
      .update(schema.repositories)
      .set({ renderContext: null })
      .where(eq(schema.repositories.id, repositoryId));
    await resetAndRewrite();
  });
  it('uses the valid current explicit names when no sync base remains', async () => {
    await db
      .delete(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, repositoryId));
    await resetAndRewrite();
  });
  it('retains base ownership of units pending removal when the authoritative current membership is []', async () => {
    await db
      .update(schema.repositories)
      .set({ renderContext: context([]) })
      .where(eq(schema.repositories.id, repositoryId));
    await resetAndRewrite();
  });
  it('sweeps the empty CLI directory left after the actual writer removes the last member', async () => {
    await writeContext([]);
    for (const name of names) expect(await exists(cliPath(name))).toBe(false);
    expect(await exists(path.join(root, '.haive-data/state/cli'))).toBe(true);
    await resetAndRewrite();
  });
  it('preserves an unproven CLI neighbor and reports its format-less residue as refused', async () => {
    await writeFile(cliPath('unproven-user'), 'user-owned metadata\n');
    expect((await reset()).status).toBe(200);
    expect(await readFile(cliPath('unproven-user'), 'utf8')).toBe('user-owned metadata\n');
    expect(await exists(path.join(root, '.haive-data/state/cli'))).toBe(true);
    expect((await read(root)).kind).toBe('refused');
  });
  it('does not infer member ownership from malformed context/base or locally enabled providers', async () => {
    await writeFile(cliPath('gemini'), '{"provider":"gemini"}\n');
    await db
      .update(schema.repositories)
      .set({ renderContext: { cliTargets: ['gemini'] } })
      .where(eq(schema.repositories.id, repositoryId));
    const [base] = await db
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, repositoryId));
    await db
      .update(schema.projectStateSync)
      .set({
        baseSnapshot: { ...(base!.baseSnapshot as Record<string, unknown>), cli: { gemini: true } },
      })
      .where(eq(schema.projectStateSync.repositoryId, repositoryId));
    await db
      .insert(schema.cliProviders)
      .values({ userId, name: 'gemini', label: 'Not repository ownership', enabled: true });
    expect((await reset()).status).toBe(200);
    expect(await readFile(cliPath('gemini'), 'utf8')).toBe('{"provider":"gemini"}\n');
    for (const name of names) expect(await exists(cliPath(name))).toBe(true);
    expect((await read(root)).kind).toBe('refused');
  });
  it('reports a partial named CLI I/O failure while advancing the epoch and retaining the refused residue', async () => {
    h.failRemoveRel = '.haive-data/state/cli/future-cli.json';
    const response = await reset();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skipped: Array<{ path: string; reason: string }> };
    expect(h.failed).toBe(true);
    expect(body.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: h.failRemoveRel })]),
    );
    expect(await exists(cliPath('claude-code'))).toBe(false);
    expect(await exists(cliPath('codex'))).toBe(false);
    expect(await exists(cliPath('future-cli'))).toBe(true);
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect(repo!.onboardingResetAt).toBeInstanceOf(Date);
    expect(repo!.renderContext).toBe(null);
    expect(
      await db
        .select()
        .from(schema.projectStateSync)
        .where(eq(schema.projectStateSync.repositoryId, repositoryId)),
    ).toEqual([]);
    expect((await read(root)).kind).toBe('refused');
  });
  it('refuses a live root claim without deleting any recorded member or advancing the epoch', async () => {
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: new Date(), rootClaimKind: 'rebuild' })
      .where(eq(schema.repositories.id, repositoryId));
    expect((await reset()).status).toBe(409);
    for (const name of names) expect(await exists(cliPath(name))).toBe(true);
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    });
    expect(repo!.onboardingResetAt).toBe(null);
    expect((await read(root)).kind).toBe('record');
  });
});
