import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  buildCliRulesBlockFromProviders,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_SCHEMA_VERSION,
  normalizeContent,
  secretsService,
  sha256Hex,
} from '@haive/shared';

const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (new URL(url).port !== '46537' || new URL(url).pathname !== '/codex_t118_cli_union_20261026')
)
  throw new Error('Use only the assigned T118 scratch database for CLI-addition controls');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({}) }));

import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { upgradeRoutes } from '../src/routes/upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe.skipIf(!url)('CLI addition availability through authenticated status', () => {
  let db: Database;
  let root: string;
  let userId: string;
  let repositoryId: string;
  let taskId: string;
  let cookie: string;
  // A unique current template avoids editing the worker's existing global manifest entries.
  const templateId = `agent.t118-availability-${randomUUID()}`;
  const bytes = '# Current agent\n';
  const hash = sha256Hex(bytes);
  const agentPath = `.claude/agents/${templateId.slice('agent.'.length)}.md`;
  const rules = buildCliRulesBlockFromProviders([
    { name: 'claude-code', enabled: true, rulesContent: '' },
  ])!;
  const context = (cliTargets: string[]) => ({
    projectInfo: { name: 'Current repository' },
    framework: 'generic',
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    cliTargets,
    rtkEnabled: false,
    rtkChoiceRecorded: true,
  });
  const app = new Hono<AppEnv>();
  app.route('/repositories', upgradeRoutes);
  app.onError(errorHandler);
  const send = (session = cookie) =>
    app.request(`/repositories/${repositoryId}/upgrade-status`, {
      headers: session ? { cookie: session } : {},
    });
  const status = async () => {
    const res = await send();
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  // Exact persistent state and recursive file bytes prove GET does not adopt membership or write.
  const tree = async (rel = ''): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) Object.assign(result, await tree(next));
      else result[next] = (await readFile(path.join(root, next))).toString('base64');
    }
    return result;
  };
  const persisted = async () => ({
    repository: await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
    }),
    artifacts: await db
      .select()
      .from(schema.onboardingArtifacts)
      .where(eq(schema.onboardingArtifacts.repositoryId, repositoryId)),
    outbox: await db
      .select()
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, repositoryId)),
    tasks: await db.select().from(schema.tasks).where(eq(schema.tasks.repositoryId, repositoryId)),
    files: await tree(),
  });
  const enableGemini = async () =>
    db.insert(schema.cliProviders).values({
      userId,
      name: 'gemini',
      label: 'Synthetic Gemini',
      enabled: true,
      rulesContent: '',
    });

  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    await db.insert(schema.templateManifestCache).values({
      templateId,
      templateKind: 'agent',
      schemaVersion: 1,
      contentHash: hash,
      setHash: hash,
    });
  });
  afterAll(async () => {
    await db
      .delete(schema.templateManifestCache)
      .where(eq(schema.templateManifestCache.templateId, templateId));
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    userId = randomUUID();
    repositoryId = randomUUID();
    taskId = randomUUID();
    root = await mkdtemp(path.join(tmpdir(), 't118-cli-addition-'));
    await mkdir(path.join(root, '.claude/agents'), { recursive: true });
    await writeFile(path.join(root, agentPath), bytes);
    await writeFile(path.join(root, 'AGENTS.md'), rules);
    await writeFile(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n');
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'synthetic@test.invalid',
      emailBlindIndex: userId,
      passwordHash: 'not-a-real-password',
      role: 'user',
      status: 'active',
    });
    cookie = `${ACCESS_COOKIE}=${await signAccessToken({ sub: userId, role: 'user', tv: 0 })}`;
    await db.insert(schema.repositories).values({
      id: repositoryId,
      userId,
      name: 'Already current',
      source: 'git_https',
      status: 'ready',
      storagePath: root,
      onboardedAt: new Date(),
      rtkEnabled: false,
      renderContext: context(['claude-code']),
      applicableTemplateIds: [templateId],
    });
    await db.insert(schema.tasks).values({
      id: taskId,
      userId,
      repositoryId,
      type: 'onboarding',
      title: 'Completed onboarding',
      status: 'completed',
      completedAt: new Date(),
    });
    await db.insert(schema.cliProviders).values({
      userId,
      name: 'claude-code',
      label: 'Synthetic Claude',
      enabled: true,
      rulesContent: '',
    });
    await db.insert(schema.onboardingArtifacts).values({
      userId,
      repositoryId,
      taskId,
      templateId,
      templateKind: 'agent',
      diskPath: agentPath,
      templateSchemaVersion: 1,
      templateContentHash: hash,
      writtenHash: hash,
      writtenContent: bytes,
      sourceStepId: '07-generate-files',
      source: 'onboarding',
    });
    await db.insert(schema.onboardingArtifacts).values({
      userId,
      repositoryId,
      taskId,
      templateId: CLI_RULES_TEMPLATE_ID,
      templateKind: 'cli-rules-block',
      diskPath: 'AGENTS.md',
      templateSchemaVersion: CLI_RULES_SCHEMA_VERSION,
      templateContentHash: sha256Hex(normalizeContent(rules)),
      writtenHash: sha256Hex(rules),
      writtenContent: rules,
      sourceStepId: '07-generate-files',
      source: 'onboarding',
    });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('offers the existing upgrade entry only after a new enabled CLI, without adopting it', async () => {
    const baseline = await status();
    expect(baseline).toMatchObject({
      isOnboarded: true,
      hasUpgradeAvailable: false,
      changedTemplateIds: [],
    });
    expect(baseline.installedTemplateSetHash).toBe(baseline.currentTemplateSetHash);
    expect(baseline.missingRulesImports).toBeUndefined();
    await enableGemini();
    const before = await persisted();
    const offered = await status();
    expect(await persisted()).toEqual(before);
    expect(offered.changedTemplateIds).toEqual([]);
    expect(offered.missingRulesImports).toBeUndefined();
    expect(offered.hasUpgradeAvailable).toBe(true);
    expect(offered.cliAdditions).toEqual(['gemini']);
  });

  it('does not offer disabled or already maintained CLIs', async () => {
    await enableGemini();
    await db
      .update(schema.cliProviders)
      .set({ enabled: false })
      .where(and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.name, 'gemini')));
    expect((await status()).hasUpgradeAvailable).toBe(false);
    await db
      .update(schema.cliProviders)
      .set({ enabled: true })
      .where(and(eq(schema.cliProviders.userId, userId), eq(schema.cliProviders.name, 'gemini')));
    await db
      .update(schema.repositories)
      .set({ renderContext: context(['claude-code', 'gemini']) })
      .where(eq(schema.repositories.id, repositoryId));
    await writeFile(path.join(root, 'GEMINI.md'), '@AGENTS.md\n');
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.cliAdditions ?? []).toEqual([]);
  });

  it.each([[[]], [['claude-code', 'future-cli']]])(
    'preserves recorded membership %j while offering choices',
    async (members) => {
      await db
        .update(schema.repositories)
        .set({ renderContext: context(members) })
        .where(eq(schema.repositories.id, repositoryId));
      // No artifacts remain applicable for an empty target set: this is a completed no-target upgrade.
      if (members.length === 0) {
        await db
          .delete(schema.onboardingArtifacts)
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, repositoryId),
              eq(schema.onboardingArtifacts.templateId, templateId),
            ),
          );
        await db
          .update(schema.repositories)
          .set({ applicableTemplateIds: [] })
          .where(eq(schema.repositories.id, repositoryId));
      }
      await enableGemini();
      const before = await persisted();
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body.hasUpgradeAvailable).toBe(true);
      expect(body.cliAdditions).toEqual(members.length ? ['gemini'] : ['claude-code', 'gemini']);
    },
  );

  it('uses recovered strict membership for a deferred legacy column, as the planner does', async () => {
    await enableGemini();
    const { cliTargets: _targets, ...legacy } = context(['claude-code']);
    await db
      .update(schema.repositories)
      .set({
        renderContext: {
          ...legacy,
          enabledCliProviders: [
            { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
          ],
        },
      })
      .where(eq(schema.repositories.id, repositoryId));
    const { rtkChoiceRecorded: _recorded, ...snapshot } = context(['claude-code', 'gemini']);
    await db
      .update(schema.onboardingArtifacts)
      .set({ formValuesSnapshot: snapshot })
      .where(eq(schema.onboardingArtifacts.repositoryId, repositoryId));
    const before = await persisted();
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.cliAdditions).toBeUndefined();
    expect(await persisted()).toEqual(before);
  });

  it('respects explicit empty membership recovered from the completed onboarding detect output', async () => {
    await enableGemini();
    await db
      .update(schema.repositories)
      .set({ renderContext: null })
      .where(eq(schema.repositories.id, repositoryId));
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: '07-generate-files',
      stepIndex: 7,
      title: 'Generate',
      status: 'done',
      detectOutput: {
        ...context([]),
        enabledCliProviders: [
          { name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' },
        ],
      },
    });
    const before = await persisted();
    const body = await status();
    expect(body.cliAdditions).toEqual(['claude-code', 'gemini']);
    expect(await persisted()).toEqual(before);
  });

  it('offers no additions when no render context resolves for the planner', async () => {
    await enableGemini();
    await db
      .update(schema.repositories)
      .set({ renderContext: null })
      .where(eq(schema.repositories.id, repositoryId));
    const before = await persisted();
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.cliAdditions).toBeUndefined();
    expect(await persisted()).toEqual(before);
  });

  it('offers no additions for a present step-07 row with NULL detect output', async () => {
    await enableGemini();
    await db
      .update(schema.repositories)
      .set({ renderContext: null })
      .where(eq(schema.repositories.id, repositoryId));
    const baseline = await status();
    expect(baseline).toMatchObject({
      isOnboarded: true,
      hasUpgradeAvailable: false,
      changedTemplateIds: [],
    });
    expect(baseline.installedTemplateSetHash).toBe(baseline.currentTemplateSetHash);
    expect(baseline.cliAdditions).toBeUndefined();
    await db.insert(schema.taskSteps).values({
      taskId,
      stepId: '07-generate-files',
      stepIndex: 7,
      title: 'Legacy generation without recorded detect output',
      status: 'done',
      detectOutput: null,
    });
    const before = await persisted();
    const body = await status();
    expect(await persisted()).toEqual(before);
    expect(body.isOnboarded).toBe(true);
    expect(body.changedTemplateIds).toEqual([]);
    expect(body.installedTemplateSetHash).toBe(body.currentTemplateSetHash);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.rtkBlockLeftovers).toBeUndefined();
    expect(body.rtkSettingsLeftovers).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.cliAdditions).toBeUndefined();
  });

  it.each(['reset', 'live-onboarding'])(
    'keeps %s admission refusal despite additions',
    async (reason) => {
      await enableGemini();
      if (reason === 'reset') {
        await db
          .update(schema.repositories)
          .set({ onboardingResetAt: new Date(Date.now() + 1000) })
          .where(eq(schema.repositories.id, repositoryId));
      } else {
        await db.insert(schema.tasks).values({
          userId,
          repositoryId,
          type: 'onboarding',
          title: 'Live onboarding',
          status: 'running',
        });
      }
      const body = await status();
      expect(body.isOnboarded).toBe(false);
      expect(body.hasUpgradeAvailable).toBe(false);
      expect(body.cliAdditions).toBeUndefined();
    },
  );

  it('keeps authentication, ownership, and contested-state refusals despite additions', async () => {
    await enableGemini();
    expect((await send('')).status).toBe(401);
    const otherId = randomUUID();
    await db.insert(schema.users).values({
      id: otherId,
      emailEncrypted: 'other@test.invalid',
      emailBlindIndex: otherId,
      passwordHash: 'not-a-real-password',
      role: 'user',
      status: 'active',
    });
    try {
      const other = `${ACCESS_COOKIE}=${await signAccessToken({ sub: otherId, role: 'user', tv: 0 })}`;
      expect((await send(other)).status).toBe(404);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, otherId));
    }
    await db
      .insert(schema.projectStateConflicts)
      .values({ repositoryId, unit: 'project/render.json#framework' });
    const body = await status();
    expect(body.hasUpgradeAvailable).toBe(false);
    expect(body.cliAdditions).toBeUndefined();
    expect(body.contestedUnits).toEqual(['project/render.json#framework']);
  });
});
