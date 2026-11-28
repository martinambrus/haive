import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  emptyProjectState,
  renderProjectState,
  type ProjectStateRecord,
} from '@haive/shared/project-state';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  probe: undefined as undefined | (() => Promise<never>),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<typeof import('../src/plan/mirror.js')>()),
  flushPlanMirrorForRepository: async () => h.probe!(),
  recordPlanMirrorError: async () => {},
}));

import { planCheckoutDatabase } from '../src/repo/checkout-access-scope.js';
import { prepareProjectStatePush } from '../src/project-state/push.js';
import { resyncWithKeptMetadata } from '../src/project-state/set-aside.js';
import { writeProjectStateRecord } from '../src/project-state/write.js';
import { save } from '../src/queues/plan-mirror-queue.js';
import { gitTemplate } from './support/git-template.js';

const STATE_DIR = '.haive-data/state';
const SENTINEL = 'probe done';

const emptyRepository = gitTemplate(async (dir) => {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});

const context = (name: string): Record<string, unknown> => ({
  projectInfo: { name },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  lspLanguages: [],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});

async function setup() {
  const { dir: root } = await emptyRepository.copy();
  const id = randomUUID();
  const userId = randomUUID();
  const fake = createFakeDb({
    auditEvents: schema.auditEvents,
    repositories: schema.repositories,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeCodeLinks: schema.planNodeCodeLinks,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.repositories, {
    id,
    userId,
    name: 'acme',
    source: 'blank',
    status: 'ready',
    storagePath: root,
    rtkEnabled: null,
    updatedAt: new Date(1000),
  });
  h.db = fake.db;
  const db = fake.db as unknown as Database;
  const repoRow = () => fake.rows(schema.repositories)[0]!;
  const saveWith = async (probe: (scoped: Database) => Promise<void>) => {
    h.probe = async () => {
      await probe(planCheckoutDatabase(db));
      throw new Error(SENTINEL);
    };
    await expect(save({ repositoryId: id, userId, push: false })).rejects.toThrow(SENTINEL);
  };
  return { root, id, fake, db, repoRow, saveWith };
}

describe('the plan Save lease passes the project state writer and the sync', () => {
  it('lets the writer rewrite a dirty record inside the Save lease', async () => {
    const s = await setup();
    await writeProjectStateRecord(s.db, {
      repositoryId: s.id,
      repoPath: s.root,
      context: context('acme') as never,
      rtkChoiceRecorded: true,
    });
    const before = readFileSync(join(s.root, STATE_DIR, 'project/render.json'), 'utf8');
    const changed = structuredClone(s.repoRow().renderContext) as Record<string, unknown>;
    changed.projectInfo = { ...(changed.projectInfo as object), name: 'acme-renamed' };
    await s.fake.db
      .update(schema.repositories)
      .set({ renderContext: changed })
      .where(eq(schema.repositories.id, s.id));
    await s.fake.db
      .update(schema.projectStateOutbox)
      .set({ revision: 2, writtenRevision: 1, lastError: null, writeIntent: null })
      .where(eq(schema.projectStateOutbox.repositoryId, s.id));

    await s.saveWith((scoped) =>
      prepareProjectStatePush(scoped, { repositoryId: s.id, sourcePath: s.root }),
    );

    const after = readFileSync(join(s.root, STATE_DIR, 'project/render.json'), 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('acme-renamed');
    const outbox = s.fake.rows(schema.projectStateOutbox)[0]!;
    expect(outbox.writeIntent).toBeNull();
    expect(outbox.lastError).toBeNull();
  });

  it('lets the re-sync import a pending record inside the Save lease', async () => {
    const s = await setup();
    const record: ProjectStateRecord = {
      ...emptyProjectState(),
      render: {
        projectInfo: { name: 'acme' },
        framework: 'drupal',
        acceptedAgentIds: ['code-reviewer'],
        customAgentSpecs: [],
        lspLanguages: [],
      },
    };
    for (const [rel, text] of renderProjectState(record)) {
      const abs = join(s.root, STATE_DIR, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    }
    expect(s.repoRow().renderContext ?? null).toBeNull();
    let result: boolean | null = null;

    await s.saveWith(async (scoped) => {
      result = await resyncWithKeptMetadata(scoped, s.id, s.root, new Map());
    });

    expect(result).toBe(true);
    expect(s.repoRow().renderContext).toMatchObject({ framework: 'drupal' });
  });
});
