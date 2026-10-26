import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDatabase, schema } from '@haive/database';
import { sha256Hex } from '@haive/shared';
import {
  claimFileName,
  deriveRenderTargets,
  isImportMarker,
  isRenderContextSnapshot,
  type RenderContextColumn,
} from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { writeProjectStateColumn } from '../src/project-state/write.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import {
  expandCustomBundlesFor,
  expandManifestFor,
  REFERENCE_CONTEXT,
} from '../src/step-engine/template-manifest.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const url = process.env.T118_DATABASE_URL;
if (
  url &&
  (new URL(url).port !== '46537' || new URL(url).pathname !== '/codex_t118_cli_union_20261026')
)
  throw new Error('Use only the assigned T118 scratch database');
const db = url ? createDatabase(url) : null;
const users: string[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'gc.auto=0', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
const portable = {
  projectInfo: { ...REFERENCE_CONTEXT.projectInfo, name: 'Deferred cleanup' },
  framework: null,
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkEnabled: false,
};
// skillDirs is derived for planning only, not a valid stored column field.
function stored(names: string[]): RenderContextColumn {
  const { skillDirs: _dirs, ...targets } = deriveRenderTargets(names, []);
  return { ...portable, cliTargets: names, ...targets, rtkChoiceRecorded: true };
}
const skill = {
  id: 'reviewing',
  title: 'Reviewing',
  description: 'Review owned code',
  overview: 'Review the project.',
  subSkills: [
    {
      slug: 'inspect',
      name: 'reviewing-inspect',
      title: 'Inspect',
      description: 'Inspect ownership',
      summary: 'Inspect the code.',
      body: 'Read before changing.',
    },
  ],
};
const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop };

async function install(root: string, context: unknown) {
  const userId = randomUUID(),
    repositoryId = randomUUID(),
    bundleId = randomUUID(),
    itemId = randomUUID();
  users.push(userId);
  await db!.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'synthetic',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
    status: 'active',
  });
  await db!.insert(schema.repositories).values({
    id: repositoryId,
    userId,
    name: 'Deferred cleanup',
    source: 'git_https',
    storagePath: root,
    localPath: root,
    status: 'ready',
    renderContext: context,
    rtkEnabled: false,
  });
  await db!.insert(schema.customBundles).values({
    id: bundleId,
    userId,
    repositoryId,
    name: 'Portable reviewing',
    sourceType: 'zip',
    storageRoot: root,
    enabledKinds: ['skill'],
  });
  await db!.insert(schema.customBundleItems).values({
    id: itemId,
    bundleId,
    kind: 'skill',
    sourceFormat: 'claude-md',
    sourcePath: 'skills/reviewing/SKILL.md',
    normalizedSpec: skill,
    contentHash: sha256Hex(JSON.stringify(skill)),
    schemaVersion: 1,
  });
  return { userId, repositoryId, bundleId, itemId, root };
}

async function cloneAfterRemoval(reduced: string[]) {
  const root = await mkdtemp(join(tmpdir(), 't118-removed-target-clone-'));
  roots.push(root);
  const source = join(root, 'A'),
    clone = join(root, 'B');
  await mkdir(source);
  git(source, 'init', '-q', '-b', 'main');
  const a = await install(source, stored(['claude-code', 'codex', 'future-cli']));
  const taskId = randomUUID();
  await db!.insert(schema.tasks).values({
    id: taskId,
    userId: a.userId,
    repositoryId: a.repositoryId,
    type: 'onboarding',
    status: 'completed',
    completedAt: new Date(),
    title: 'Original installation',
  });
  const full = {
    ...portable,
    cliTargets: ['claude-code', 'codex', 'future-cli'],
    ...deriveRenderTargets(['claude-code', 'codex', 'future-cli'], []),
  };
  const agent = expandManifestFor(full).find(
    (r) => r.diskPath === '.codex/agents/code-reviewer.toml',
  )!;
  expect(agent).toBeDefined();
  const bundled = expandCustomBundlesFor(
    [
      {
        id: a.bundleId,
        items: [
          {
            id: a.itemId,
            kind: 'skill',
            schemaVersion: 1,
            contentHash: sha256Hex(JSON.stringify(skill)),
            spec: skill,
          },
        ],
      },
    ],
    [],
    ['.agents/skills'],
  );
  const artifacts = [agent, ...bundled];
  expect(artifacts).toHaveLength(3);
  for (const artifact of artifacts) {
    await mkdir(dirname(join(source, artifact.diskPath)), { recursive: true });
    await writeFile(join(source, artifact.diskPath), artifact.content);
    await db!.insert(schema.onboardingArtifacts).values({
      userId: a.userId,
      repositoryId: a.repositoryId,
      taskId,
      diskPath: artifact.diskPath,
      templateId: artifact.templateId,
      templateKind: artifact.templateKind,
      templateSchemaVersion: artifact.templateSchemaVersion,
      templateContentHash: artifact.templateContentHash,
      writtenHash: artifact.writtenHash,
      writtenContent: artifact.content,
      source: 'onboarding',
      sourceStepId: '07-generate-files',
      formValuesSnapshot: { ...portable, cliTargets: full.cliTargets },
      bundleItemId: artifact.templateKind === 'custom-skill' ? a.itemId : null,
    });
  }
  await writeProjectStateColumn(db!, {
    repositoryId: a.repositoryId,
    repoPath: source,
    column: stored(full.cliTargets),
  });
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'Maintain Claude and Codex');
  await db!.transaction(async (tx) => {
    await tx
      .update(schema.repositories)
      .set({ renderContext: stored(reduced) })
      .where(eq(schema.repositories.id, a.repositoryId));
    await markProjectStateDirty(tx, a.repositoryId);
  });
  await writeProjectStateColumn(db!, {
    repositoryId: a.repositoryId,
    repoPath: source,
    column: stored(reduced),
    expectedColumns: [stored(reduced)],
  });
  for (const artifact of artifacts) {
    expect(await readFile(join(source, artifact.diskPath), 'utf8')).toBe(artifact.content);
    expect(
      await readFile(join(source, '.haive-data/state', claimFileName(artifact.diskPath)), 'utf8'),
    ).toContain(artifact.writtenHash);
  }
  expect(await readFile(join(source, '.haive-data/state/cli/codex.json')).catch(() => null)).toBe(
    null,
  );
  git(source, 'add', '.haive-data/state');
  git(source, 'commit', '-qm', 'Remove Codex membership; defer cleanup');
  git(root, 'clone', '-q', '--no-hardlinks', source, clone);
  const b = await install(clone, null);
  const synced = await syncProjectStateFromCheckout(db!, {
    repositoryId: b.repositoryId,
    repoPath: clone,
  });
  expect(synced.outcome).toBe('applied');
  const imported = await db!
    .select()
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, b.repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );
  expect(imported).toHaveLength(3);
  for (const row of imported) {
    expect(isImportMarker(row)).toBe(true);
    expect(isRenderContextSnapshot(row.formValuesSnapshot)).toBe(true);
    expect(row.formValuesSnapshot).toMatchObject({ cliTargets: reduced });
    expect((row.formValuesSnapshot as { cliTargets: string[] }).cliTargets).not.toContain('codex');
    expect(await readFile(join(clone, row.diskPath), 'utf8')).toBe(row.writtenContent);
  }
  expect(
    imported.filter((r) => r.templateKind === 'custom-skill').map((r) => r.bundleItemId),
  ).toEqual([b.itemId, b.itemId]);
  expect(git(clone, 'status', '--porcelain')).toBe('');
  const upgradeId = randomUUID();
  const [provider] = await db!
    .insert(schema.cliProviders)
    .values({ userId: b.userId, name: 'codex', label: 'Locally enabled Codex', enabled: true })
    .returning();
  await db!.insert(schema.tasks).values({
    id: upgradeId,
    userId: b.userId,
    repositoryId: b.repositoryId,
    type: 'onboarding_upgrade',
    status: 'running',
    title: 'Clean up removed targets',
  });
  const ctx = {
    db: db!,
    taskId: upgradeId,
    userId: b.userId,
    cliProviderId: provider!.id,
    repoPath: clone,
    logger,
    throwIfCancelled: noop,
    emitProgress: async () => {},
  } as unknown as StepContext;
  const detected = await upgradePlanStep.detect!(ctx);
  expect(detected.cliAdditions).toEqual(['codex']);
  const plan = await upgradePlanStep.apply(ctx, {
    detected,
    formValues: { addCliTargets: [] },
    iteration: 0,
    previousIterations: [],
  });
  expect(plan.renderCtxSnapshot.cliTargets).toEqual(reduced);
  await db!.insert(schema.taskSteps).values({
    taskId: upgradeId,
    stepId: '01-upgrade-plan',
    stepIndex: 1,
    title: 'Plan cleanup',
    status: 'done',
    output: plan,
    detectOutput: detected,
  });
  return { ...b, ctx, artifacts, imported, plan };
}

describe.skipIf(!url)('deferred removed target cleanup after clone', () => {
  it.each([{ reduced: ['claude-code', 'future-cli'] }, { reduced: [] }])(
    'offers imported Codex agent and bundle main/subskills as obsolete with reduced $reduced',
    async ({ reduced }) => {
      const s = await cloneAfterRemoval(reduced);
      for (const artifact of s.artifacts) {
        const entry = s.plan.entries.find((e) => e.diskPath === artifact.diskPath);
        expect.soft(entry).toMatchObject({ bucket: 'obsolete', currentContent: artifact.content });
      }
      const [repo] = await db!
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, s.repositoryId));
      expect((repo!.renderContext as { cliTargets: string[] }).cliTargets).toEqual(reduced);
      expect(git(s.root, 'status', '--porcelain')).toBe('');
    },
  );
});

describe.skipIf(!url)('ordinary imported removed target apply guards', () => {
  async function apply(
    s: Awaited<ReturnType<typeof cloneAfterRemoval>>,
    formValues: Record<string, unknown>,
  ) {
    const detected = await upgradeApplyStep.detect!(s.ctx);
    const out = await upgradeApplyStep.apply(s.ctx, {
      detected,
      formValues,
      iteration: 0,
      previousIterations: [],
    });
    expect(out.recordWrite, out.warnings.join('\n')).toBe('written');
    return out;
  }
  async function members(s: Awaited<ReturnType<typeof cloneAfterRemoval>>) {
    const [repo] = await db!
      .select()
      .from(schema.repositories)
      .where(eq(schema.repositories.id, s.repositoryId));
    return (repo!.renderContext as { cliTargets: string[] }).cliTargets;
  }
  it.each([{ keep: true }, { keep: false }])(
    'honors agent Keep=$keep, existing bundle untrack, scoped record paths and exact retry',
    async ({ keep }) => {
      const reduced = ['claude-code', 'future-cli'];
      const s = await cloneAfterRemoval(reduced);
      const agent = s.plan.entries.find(
        (e) => e.templateKind === 'agent' && e.diskPath.startsWith('.codex/'),
      )!;
      expect(agent.bucket).toBe('obsolete');
      const picks = keep
        ? { selectedObsoleteUntracks: [agent.entryId] }
        : { selectedObsoleteRemovals: [agent.entryId] };
      for (let attempt = 0; attempt < 2; attempt++) {
        await apply(s, picks);
        for (const artifact of s.artifacts) {
          const bytes = await readFile(join(s.root, artifact.diskPath), 'utf8').catch(() => null);
          expect(bytes).toBe(artifact.templateKind === 'agent' && !keep ? null : artifact.content);
          const live = await db!
            .select()
            .from(schema.onboardingArtifacts)
            .where(
              and(
                eq(schema.onboardingArtifacts.repositoryId, s.repositoryId),
                eq(schema.onboardingArtifacts.diskPath, artifact.diskPath),
                isNull(schema.onboardingArtifacts.supersededAt),
              ),
            );
          expect(live).toEqual([]);
          expect(
            await readFile(
              join(s.root, '.haive-data/state', claimFileName(artifact.diskPath)),
            ).catch(() => null),
          ).toBe(null);
        }
        expect(await members(s)).toEqual(reduced);
      }
      const changed = git(s.root, 'diff', '--name-only').split('\n').filter(Boolean);
      expect(
        changed.every((p) => p.startsWith('.haive-data/state/') || (!keep && p === agent.diskPath)),
      ).toBe(true);
    },
  );
  it('keeps an imported obsolete file edited after planning and preserves its live claim', async () => {
    const s = await cloneAfterRemoval([]);
    const agent = s.plan.entries.find(
      (e) => e.templateKind === 'agent' && e.diskPath.startsWith('.codex/'),
    )!;
    expect(agent.bucket).toBe('obsolete');
    const edited = agent.currentContent + '\nA local user edit after planning.\n';
    await writeFile(join(s.root, agent.diskPath), edited);
    const out = await apply(s, { selectedObsoleteRemovals: [agent.entryId] });
    expect(await readFile(join(s.root, agent.diskPath), 'utf8')).toBe(edited);
    expect(out.warnings.join('\n')).toMatch(/kept|changed|edited/);
    const [live] = await db!
      .select()
      .from(schema.onboardingArtifacts)
      .where(eq(schema.onboardingArtifacts.id, agent.liveArtifactId!));
    expect(live!.supersededAt).toBe(null);
    expect(await members(s)).toEqual([]);
  });
});
