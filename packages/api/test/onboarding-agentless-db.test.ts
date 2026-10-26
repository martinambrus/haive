import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, secretsService, sha256Hex } from '@haive/shared';
import { deriveRenderTargets, isRenderContextSnapshot } from '@haive/shared/project-state';
import { renderContextAdmitsUpgrade } from '@haive/shared/onboarding-admission';
import { KB_DIR } from '@haive/shared/knowledge-paths';

const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (new URL(url).port !== '46537' || new URL(url).pathname !== '/codex_t118_cli_union_20261026')
)
  throw new Error('Use only the assigned T118 scratch database for agent-less completion');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({}) }));

import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const column = () => {
  const derived = deriveRenderTargets(['amp'], []);
  return {
    projectInfo: { name: 'Amp repository' },
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    cliTargets: ['amp'],
    agentTargets: derived.agentTargets,
    enabledCliProviders: derived.enabledCliProviders,
    rtkEnabled: false,
    rtkChoiceRecorded: true,
  };
};

describe.skipIf(!url)('agent-less completion through repository routes', () => {
  let db: Database,
    userId: string,
    repositoryId: string,
    taskId: string,
    root: string,
    cookie: string;
  const app = new Hono<AppEnv>();
  app.route('/repos', repoRoutes);
  app.onError(errorHandler);
  const send = (suffix: string, method = 'GET', session = cookie) =>
    app.request(`/repos${suffix}`, { method, headers: session ? { cookie: session } : {} });
  const repo = () =>
    db.query.repositories.findFirst({ where: eq(schema.repositories.id, repositoryId) });
  const noAgents = async () =>
    expect(await lstat(join(root, '.claude/agents')).catch(() => null)).toBeNull();
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
    userId = randomUUID();
    repositoryId = randomUUID();
    taskId = randomUUID();
    root = await mkdtemp(join(tmpdir(), 't118-agentless-api-'));
    await mkdir(join(root, KB_DIR), { recursive: true });
    await mkdir(join(root, '.claude/skills'), { recursive: true });
    await writeFile(join(root, '.claude/workflow-config.json'), '{}\n');
    await writeFile(join(root, 'index.ts'), 'export const ready = true;\n');
    expect(deriveRenderTargets(['amp'], []).agentTargets).toEqual([]);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'synthetic@test.invalid',
      emailBlindIndex: userId,
      passwordHash: 'not-a-password',
      role: 'user',
      status: 'active',
    });
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'Agent-less Amp',
      source: 'git_https',
      status: 'ready',
      storagePath: root,
      renderContext: column(),
      onboardedAt: new Date(2000),
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      userId,
      repositoryId,
      type: 'onboarding',
      title: 'Completed Amp onboarding',
      status: 'completed',
      completedAt: new Date(2000),
    });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lists a successfully completed Amp repository as onboarded without writing agents', async () => {
    const before = await repo();
    const res = await send('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repositories: Record<string, unknown>[] };
    expect(await repo()).toEqual(before);
    await noAgents();
    expect(body.repositories.find((r) => r.id === repositoryId)?.onboarded).toBe(true);
  });

  it('reports applicable markers and completed status for Amp', async () => {
    const before = await repo();
    const res = await send(`/${repositoryId}/onboarding-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(await repo()).toEqual(before);
    await noAgents();
    expect.soft(body.missing).toEqual([]);
    expect(body.onboarded).toBe(true);
  });

  it('marks a late-failed Amp run without inventing an agent directory or changing membership', async () => {
    await db
      .update(schema.tasks)
      .set({ status: 'failed', completedAt: null })
      .where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.repositories)
      .set({ onboardedAt: null })
      .where(eq(schema.repositories.id, repositoryId));
    const res = await send(`/${repositoryId}/mark-onboarded`, 'POST');
    expect(res.status).toBe(200);
    expect((await repo())?.renderContext).toEqual(column());
    expect((await repo())?.onboardedAt).toBeInstanceOf(Date);
    await noAgents();
  });

  it('admits an Amp clone on the same marker verdict', async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.repositories)
      .set({ onboardedAt: null })
      .where(eq(schema.repositories.id, repositoryId));
    const stored = await repo();
    expect(await renderContextAdmitsUpgrade(db, userId, stored!)).toBe(true);
    await noAgents();
  });

  it('recovers valid recorded Amp snapshot membership when the current column is NULL', async () => {
    const { rtkChoiceRecorded: _flag, ...snapshot } = column();
    expect(isRenderContextSnapshot(snapshot)).toBe(true);
    await db
      .update(schema.repositories)
      .set({ renderContext: null })
      .where(eq(schema.repositories.id, repositoryId));
    await db.insert(schema.onboardingArtifacts).values({
      userId,
      repositoryId,
      taskId,
      diskPath: '.claude/workflow-config.json',
      templateId: 'workflow-config',
      templateKind: 'workflow-config',
      templateSchemaVersion: 1,
      templateContentHash: sha256Hex('{}\n'),
      writtenHash: sha256Hex('{}\n'),
      formValuesSnapshot: snapshot,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
    });
    const before = await repo();
    const res = await send(`/${repositoryId}/onboarding-status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(await repo()).toEqual(before);
    expect(body.onboarded).toBe(true);
    const list = await send('');
    expect(list.status).toBe(200);
    expect(
      ((await list.json()) as { repositories: Record<string, unknown>[] }).repositories.find(
        (row) => row.id === repositoryId,
      )?.onboarded,
    ).toBe(true);
    await db
      .update(schema.tasks)
      .set({ status: 'failed', completedAt: null })
      .where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.repositories)
      .set({ onboardedAt: null })
      .where(eq(schema.repositories.id, repositoryId));
    const marked = await send(`/${repositoryId}/mark-onboarded`, 'POST');
    expect(marked.status).toBe(200);
    expect((await repo())?.renderContext).toBeNull();
    expect((await repo())?.onboardedAt).toBeInstanceOf(Date);
    await noAgents();
  });
  it('preserves auth, live-run, root-claim and reset refusals with agent-less markers', async () => {
    expect((await send(`/${repositoryId}/mark-onboarded`, 'POST', '')).status).toBe(401);
    await db
      .update(schema.tasks)
      .set({ status: 'running', completedAt: null })
      .where(eq(schema.tasks.id, taskId));
    const live = await send(`/${repositoryId}/mark-onboarded`, 'POST');
    expect(live.status).toBe(409);
    expect(((await live.json()) as { error: string }).error).toContain('in progress');
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: new Date(), rootClaimKind: 'reset', rootClaimOwner: 'other-fixture' })
      .where(eq(schema.repositories.id, repositoryId));
    const held = await send(`/${repositoryId}/mark-onboarded`, 'POST');
    expect(held.status).toBe(409);
    expect(((await held.json()) as { error: string }).error).toContain('reset');
    await db
      .update(schema.repositories)
      .set({
        rootClaimedAt: null,
        rootClaimKind: null,
        rootClaimOwner: null,
        onboardingResetAt: new Date(),
        onboardedAt: null,
      })
      .where(eq(schema.repositories.id, repositoryId));
    const reset = await send(`/${repositoryId}/mark-onboarded`, 'POST');
    expect(reset.status).toBe(409);
    expect(((await reset.json()) as { error: string }).error).toContain('reset');
    await noAgents();
  });
});
