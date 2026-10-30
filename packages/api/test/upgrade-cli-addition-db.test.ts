import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  buildRepoCliRulesBlock,
  CLI_RULES_TEMPLATE_ID,
  CLI_RULES_SCHEMA_VERSION,
  normalizeContent,
  secretsService,
  sha256Hex,
  userSecretsService,
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
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// Cross-package integration is test-only: runtime loading keeps API production/types independent
// of the worker. Both consumers run against this test's actual owned PostgreSQL repository.
const plannerModule = new URL(
  '../../worker/src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.ts',
  import.meta.url,
).pathname;

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
  const rules = buildRepoCliRulesBlock(null)!;
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
  app.route('/repositories', toolingUpgradeRoutes);
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
    vi.spyOn(userSecretsService, 'listForUser').mockResolvedValue([]);
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

  it('offers cleanup for a reduced imported Codex claim with no local Codex addition or other pending reason', async () => {
    expect(await status()).toMatchObject({ hasUpgradeAvailable: false, changedTemplateIds: [] });
    const reduced = ['claude-code', 'future-cli'];
    await db
      .update(schema.repositories)
      .set({ renderContext: context(reduced) })
      .where(eq(schema.repositories.id, repositoryId));
    expect(await status()).toMatchObject({ hasUpgradeAvailable: false, changedTemplateIds: [] });
    const removedPath = `.codex/agents/${templateId.slice('agent.'.length)}.toml`;
    const removedBytes = 'name = "removed-agent"\n';
    await mkdir(path.dirname(path.join(root, removedPath)), { recursive: true });
    await writeFile(path.join(root, removedPath), removedBytes);
    const { rtkChoiceRecorded: _recorded, ...snapshot } = context(reduced);
    await db.insert(schema.onboardingArtifacts).values({
      userId,
      repositoryId,
      taskId: null,
      templateId,
      templateKind: 'agent',
      diskPath: removedPath,
      templateSchemaVersion: 1,
      templateContentHash: hash,
      writtenHash: sha256Hex(removedBytes),
      writtenContent: removedBytes,
      source: 'backfill',
      sourceStepId: 'project-state-import',
      haiveVersion: '0.0.0',
      importedAt: new Date(),
      lastObservedDiskHash: sha256Hex(removedBytes),
      formValuesSnapshot: snapshot,
    });
    const before = await persisted();
    const body = await status();
    expect(await persisted()).toEqual(before);
    expect(body.cliAdditions ?? []).toEqual([]);
    expect(body.changedTemplateIds).toEqual([templateId]);
    expect(body.obsoleteTemplateIds).toEqual([templateId]);
    expect(body.missingRulesImports).toBeUndefined();
    expect(body.hasUpgradeAvailable).toBe(true);
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
    await writeFile(path.join(root, 'GEMINI.md'), '@AGENTS.md\n');
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

  describe('status and actual01 agree on completed recorded target membership', () => {
    const providers = (names: string[]) =>
      names.map((name) => ({
        name,
        rulesFile: name === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
        rulesFileMode: name === 'claude-code' ? 'import' : 'native',
      }));
    const legacyContext = (names: string[]) => {
      const { cliTargets: _targets, ...portable } = context(names);
      return {
        ...portable,
        enabledCliProviders: providers(names),
        agentTargets: names.includes('claude-code')
          ? [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }]
          : [],
      };
    };
    const snapshot = (names: string[]) => {
      const { rtkChoiceRecorded: _choice, ...value } = context(names);
      return value;
    };
    const prepare = async (column: unknown, value: unknown) => {
      await db
        .update(schema.cliProviders)
        .set({ enabled: false })
        .where(eq(schema.cliProviders.userId, userId));
      await db
        .delete(schema.onboardingArtifacts)
        .where(eq(schema.onboardingArtifacts.repositoryId, repositoryId));
      await db
        .update(schema.repositories)
        .set({ renderContext: column, applicableTemplateIds: [] })
        .where(eq(schema.repositories.id, repositoryId));
      // A real live row supplies strict snapshot provenance. Its non-applicable proof path holds
      // a person's changed bytes, so it is not an obsolete removal or template drift reason.
      await mkdir(path.join(root, '.haive'), { recursive: true });
      await writeFile(
        path.join(root, '.haive/historical-proof.json'),
        'person keeps this edited proof\n',
      );
      await db.insert(schema.onboardingArtifacts).values({
        userId,
        repositoryId,
        taskId,
        templateId: 'historical.proof',
        templateKind: 'workflow-config',
        diskPath: '.haive/historical-proof.json',
        templateSchemaVersion: 1,
        templateContentHash: hash,
        writtenHash: hash,
        source: 'onboarding',
        sourceStepId: '12-post-onboarding',
        generatedAt: new Date(1),
        formValuesSnapshot: value as Record<string, unknown>,
      });
    };
    const plan = async () => {
      const { buildUpgradePlan } = await import(plannerModule);
      const noop = () => undefined;
      return buildUpgradePlan({
        db,
        userId,
        taskId,
        repoPath: root,
        logger: { info: noop, warn: noop, error: noop, debug: noop },
      });
    };

    it.each(['agent', 'skill'] as const)(
      'uses completed membership for %s destinations and stranded-file comparisons',
      async (kind) => {
        await prepare(legacyContext(['claude-code']), snapshot(['codex', 'future-cli']));
        const bundleId = randomUUID(),
          itemId = randomUUID();
        const spec =
          kind === 'skill'
            ? { id: 'shared-skill', title: 'Shared skill', description: 'Recorded target control' }
            : {
                id: 'shared-agent',
                title: 'Shared agent',
                description: 'Recorded target control',
                color: 'blue',
                field: 'Testing',
                tools: [],
                coreMission: 'Check targets',
                responsibilities: [],
                whenInvoked: [],
                executionSteps: [],
                outputFormat: 'Report',
                qualityCriteria: [],
                antiPatterns: [],
              };
        await db.insert(schema.customBundles).values({
          id: bundleId,
          userId,
          repositoryId,
          name: 'Recorded target control',
          sourceType: 'zip',
          storageRoot: root,
        });
        await db.insert(schema.customBundleItems).values({
          id: itemId,
          bundleId,
          kind,
          sourceFormat: 'claude-md',
          sourcePath: `${kind}.md`,
          normalizedSpec: spec,
          contentHash: sha256Hex(JSON.stringify(spec)),
        });
        const templateId = `custom.${bundleId}.${itemId}`;
        const first = await plan();
        const entry = first.entries.find(
          (e: { templateId: string }) => e.templateId === templateId,
        )!;
        expect(entry.diskPath).toBe(
          kind === 'skill'
            ? '.agents/skills/shared-skill/SKILL.md'
            : '.codex/agents/shared-agent.toml',
        );
        await mkdir(path.dirname(path.join(root, entry.diskPath)), { recursive: true });
        await writeFile(path.join(root, entry.diskPath), entry.newContent);
        await db.insert(schema.onboardingArtifacts).values({
          userId,
          repositoryId,
          taskId,
          templateId,
          templateKind: kind === 'skill' ? 'custom-skill' : 'custom-agent',
          bundleItemId: itemId,
          diskPath: entry.diskPath,
          templateSchemaVersion: 1,
          templateContentHash: entry.currentTemplateContentHash,
          writtenHash: sha256Hex(normalizeContent(entry.newContent)),
          writtenContent: entry.newContent,
          source: 'onboarding',
          sourceStepId: '06_3-custom-bundles',
          formValuesSnapshot: snapshot(['codex', 'future-cli']),
        });
        const planned = await plan();
        expect(
          planned.entries.find((e: { templateId: string }) => e.templateId === templateId).bucket,
        ).toBe('unchanged');
        const before = await persisted();
        const body = await status();
        expect(await persisted()).toEqual(before);
        expect(body).toMatchObject({ hasUpgradeAvailable: false, changedTemplateIds: [] });
        expect(body.obsoleteTemplateIds).toBeUndefined();
        expect(body.missingRulesImports).toBeUndefined();
      },
    );

    describe('canonical removal retains the observed-set fence', () => {
      const config = async () => {
        const res = await app.request(`/repositories/${repositoryId}/tooling-config`, {
          headers: { cookie },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as { cliTargets: string[]; cliTargetsEditable: boolean };
      };
      const remove = (expectedTargets: string[], providers: string[]) =>
        app.request(`/repositories/${repositoryId}/cli-targets/remove`, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ expectedTargets, providers }),
        });
      it('refuses an old column-only client without silently discarding unobserved snapshot members', async () => {
        await prepare(legacyContext(['claude-code']), snapshot(['gemini', 'future-cli']));
        const before = await persisted();
        const response = await remove(['claude-code'], ['claude-code']);
        expect.soft(response.status).toBe(409);
        expect.soft(await persisted()).toEqual(before);
      });
      it('lets a canonical observed client remove only Gemini, preserving unknown membership and column origin', async () => {
        const column = legacyContext(['claude-code']);
        await prepare(column, snapshot(['gemini', 'future-cli']));
        const observed = await config();
        expect
          .soft(observed)
          .toMatchObject({ cliTargets: ['gemini', 'future-cli'], cliTargetsEditable: true });
        const before = await persisted();
        const response = await remove(['gemini', 'future-cli'], ['gemini']);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ cliTargets: ['future-cli'] });
        const after = await persisted();
        expect(after.files).toEqual(before.files);
        expect(after.artifacts).toEqual(before.artifacts);
        expect(after.repository!.renderContext).toMatchObject({
          projectInfo: column.projectInfo,
          framework: column.framework,
          rtkChoiceRecorded: column.rtkChoiceRecorded,
          cliTargets: ['future-cli'],
          agentTargets: [],
          enabledCliProviders: [],
        });
        const moved = await persisted();
        expect((await remove(['gemini', 'future-cli'], ['future-cli'])).status).toBe(409);
        expect(await persisted()).toEqual(moved);
      });
      it('shows NULL-column recovered membership read-only and retains valid-column mutation admission', async () => {
        await prepare(null, snapshot(['gemini', 'future-cli']));
        const before = await persisted();
        const observed = await config();
        expect
          .soft(observed)
          .toMatchObject({ cliTargets: ['gemini', 'future-cli'], cliTargetsEditable: false });
        expect((await remove(['gemini', 'future-cli'], ['gemini'])).status).toBe(409);
        expect(await persisted()).toEqual(before);
      });
      it('keeps current explicit [] authoritative and editable even with a different live snapshot', async () => {
        await prepare(context([]), snapshot(['gemini']));
        expect(await config()).toMatchObject({ cliTargets: [], cliTargetsEditable: true });
      });

      it.each(['holder', 'journal', 'root-claim'])(
        'keeps %s refusal without changing recovered membership',
        async (guard) => {
          await prepare(legacyContext(['claude-code']), snapshot(['gemini', 'future-cli']));
          if (guard === 'holder')
            await db.insert(schema.tasks).values({
              userId,
              repositoryId,
              type: 'onboarding_upgrade',
              title: 'Holding checkout',
              status: 'running',
            });
          if (guard === 'journal')
            await db
              .insert(schema.projectStateOutbox)
              .values({ repositoryId, writeIntent: { fixture: 'held' } });
          if (guard === 'root-claim')
            await db
              .update(schema.repositories)
              .set({ rootClaimedAt: new Date(), rootClaimKind: 'reset' })
              .where(eq(schema.repositories.id, repositoryId));
          const before = await persisted();
          expect((await remove(['gemini', 'future-cli'], ['gemini'])).status).toBe(409);
          expect(await persisted()).toEqual(before);
        },
      );

      it('keeps unauthenticated and other-owner clients out of the canonical removal transaction', async () => {
        await prepare(legacyContext(['claude-code']), snapshot(['gemini', 'future-cli']));
        const request = (session: string) =>
          app.request(`/repositories/${repositoryId}/cli-targets/remove`, {
            method: 'POST',
            headers: { cookie: session, 'content-type': 'application/json' },
            body: JSON.stringify({
              expectedTargets: ['gemini', 'future-cli'],
              providers: ['gemini'],
            }),
          });
        const before = await persisted();
        expect((await request('')).status).toBe(401);
        const otherId = randomUUID();
        await db.insert(schema.users).values({
          id: otherId,
          emailEncrypted: 'synthetic',
          emailBlindIndex: otherId,
          passwordHash: 'fixture',
          role: 'user',
          status: 'active',
        });
        try {
          const session = `${ACCESS_COOKIE}=${await signAccessToken({ sub: otherId, role: 'user', tv: 0 })}`;
          expect((await request(session)).status).toBe(404);
        } finally {
          await db.delete(schema.users).where(eq(schema.users.id, otherId));
        }
        expect(await persisted()).toEqual(before);
      });
    });

    it('does not restore Claude imports suppressed by newer strict explicit []', async () => {
      await prepare(context([]), snapshot([]));
      await rm(path.join(root, 'CLAUDE.md'));
      const baseline = await status();
      expect(baseline).toMatchObject({
        isOnboarded: true,
        hasUpgradeAvailable: false,
        changedTemplateIds: [],
      });
      expect(baseline.missingRulesImports).toBeUndefined();
      await db
        .update(schema.repositories)
        .set({ renderContext: legacyContext(['claude-code']) })
        .where(eq(schema.repositories.id, repositoryId));
      const before = await persisted();
      const planned = await plan();
      expect(planned.repositoryCliTargets).toEqual([]);
      expect(planned.renderCtxSnapshot.agentTargets).toEqual([]);
      expect(planned.missingRulesImports ?? []).toEqual([]);
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body.changedTemplateIds).toEqual([]);
      expect(body.cliAdditions).toBeUndefined();
      expect.soft(body.missingRulesImports).toBeUndefined();
      expect.soft(body.hasUpgradeAvailable).toBe(false);
    });

    it('offers actual01 Claude restoration recovered ahead of legacy recorded empty providers', async () => {
      await prepare(legacyContext([]), snapshot(['claude-code', 'future-cli']));
      await rm(path.join(root, 'CLAUDE.md'));
      const before = await persisted();
      const planned = await plan();
      expect(planned.repositoryCliTargets).toEqual(['claude-code', 'future-cli']);
      expect(planned.missingRulesImports).toEqual(['CLAUDE.md']);
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body.changedTemplateIds).toEqual([]);
      expect.soft(body.missingRulesImports).toEqual(['CLAUDE.md']);
      expect.soft(body.hasUpgradeAvailable).toBe(true);
    });

    it('uses recovered mixed membership without reviving the legacy Claude import', async () => {
      await prepare(legacyContext(['claude-code']), snapshot(['gemini', 'future-cli']));
      await rm(path.join(root, 'CLAUDE.md'));
      const before = await persisted();
      const planned = await plan();
      expect(planned.repositoryCliTargets).toEqual(['gemini', 'future-cli']);
      expect(planned.missingRulesImports).toEqual(['GEMINI.md']);
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body.changedTemplateIds).toEqual([]);
      expect(body.missingRulesImports).toEqual(['GEMINI.md']);
    });

    it('keeps authoritative current [] before a different strict snapshot for both consumers', async () => {
      await prepare(context([]), snapshot(['claude-code']));
      await rm(path.join(root, 'CLAUDE.md'));
      const before = await persisted();
      expect((await plan()).repositoryCliTargets).toEqual([]);
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body).toMatchObject({ hasUpgradeAvailable: false, changedTemplateIds: [] });
      expect(body.missingRulesImports).toBeUndefined();
    });

    it('skips a malformed newer snapshot rather than treating it as explicit removal', async () => {
      await prepare(legacyContext(['claude-code']), snapshot(['gemini']));
      await writeFile(
        path.join(root, '.haive/malformed-proof.json'),
        'person keeps this edited proof\n',
      );
      await db.insert(schema.onboardingArtifacts).values({
        userId,
        repositoryId,
        taskId,
        templateId: 'historical.malformed',
        templateKind: 'workflow-config',
        diskPath: '.haive/malformed-proof.json',
        templateSchemaVersion: 1,
        templateContentHash: hash,
        writtenHash: hash,
        source: 'onboarding',
        sourceStepId: '12-post-onboarding',
        generatedAt: new Date(2),
        formValuesSnapshot: { ...snapshot([]), unrecognized: true },
      });
      expect((await plan()).repositoryCliTargets).toEqual(['gemini']);
      expect((await status()).missingRulesImports).toEqual(['GEMINI.md']);
    });

    it('recovers newest membership without replacing the older RTK-recorded context origin', async () => {
      await prepare(null, {
        ...snapshot(['claude-code']),
        framework: 'drupal',
        projectInfo: { name: 'Older chosen context' },
        rtkEnabled: true,
      });
      const { rtkEnabled: _rtk, ...newer } = snapshot(['gemini', 'future-cli']);
      await writeFile(
        path.join(root, '.haive/newer-proof.json'),
        'person keeps this edited proof\n',
      );
      await db.insert(schema.onboardingArtifacts).values({
        userId,
        repositoryId,
        taskId,
        templateId: 'historical.newer',
        templateKind: 'workflow-config',
        diskPath: '.haive/newer-proof.json',
        templateSchemaVersion: 1,
        templateContentHash: hash,
        writtenHash: hash,
        source: 'onboarding',
        sourceStepId: '12-post-onboarding',
        generatedAt: new Date(2),
        formValuesSnapshot: {
          ...newer,
          framework: 'generic',
          projectInfo: { name: 'Newest membership only' },
        },
      });
      const before = await persisted();
      const planned = await plan();
      expect(planned.repositoryCliTargets).toEqual(['gemini', 'future-cli']);
      expect(planned.renderCtxSnapshot).toMatchObject({
        framework: 'drupal',
        projectInfo: { name: 'Older chosen context' },
        rtkEnabled: false,
      });
      expect(planned.rtkFollowsLive).toBe(true);
      expect(planned.missingRulesImports).toEqual(['GEMINI.md']);
      const body = await status();
      expect(await persisted()).toEqual(before);
      expect(body.changedTemplateIds).toEqual([]);
      expect(body.missingRulesImports).toEqual(['GEMINI.md']);
    });
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
