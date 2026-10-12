import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import {
  ProjectStateUnreadableError,
  ProjectStateWriteError,
  writeProjectStateRecord,
} from '../src/project-state/write.js';

// 4,094 files through the descriptor-held write take half a minute on a busy host; this test is
// about how many files the writer plans, not how it writes each one.
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    writeFileNoFollow: async (anchor: string, rel: string, text: string) => {
      await mkdir(dirname(join(anchor, rel)), { recursive: true });
      await writeFile(join(anchor, rel), text);
    },
  };
});

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const STATE = '.haive-data/state';
// format.json, project/, project/render.json and artifacts/ stand besides the claim files.
const AT_LIMIT = 4096 - 4;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const context = () => ({
  projectInfo: { name: 'acme', framework: 'drupal' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  lspLanguages: ['php-extended'],
  rtkEnabled: true,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
});

async function setup(claims: number) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-write-bounds-'));
  dirs.push(root);
  const fake = createFakeDb({
    repositories: schema.repositories,
    projectStateSync: schema.projectStateSync,
    projectStateConflicts: schema.projectStateConflicts,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    tasks: schema.tasks,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
  for (let i = 0; i < claims; i++) {
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: TASK,
      diskPath: `.claude/agents/agent-${i}.md`,
      templateId: `agent.agent-${i}`,
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'a'.repeat(64),
      writtenHash: 'b'.repeat(64),
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      haiveVersion: '1.2.3',
      supersededAt: null,
    });
  }
  const db = fake.db as unknown as Database;
  return {
    root,
    fake,
    db,
    write: () =>
      writeProjectStateRecord(db, {
        repositoryId: REPO,
        repoPath: root,
        context: context() as never,
        rtkChoiceRecorded: true,
      }),
  };
}

const LONG = { timeout: 120_000 };

describe('writeProjectStateRecord: a record the reader would refuse', () => {
  it('refuses a ledger of 4,093 claims and writes no file', LONG, async () => {
    const s = await setup(AT_LIMIT + 1);

    const err = await s.write().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ProjectStateWriteError);
    expect((err as ProjectStateWriteError).cause).toBeInstanceOf(ProjectStateUnreadableError);
    expect((err as Error).message).toMatch(/more than 4096 entries/);
    expect((err as ProjectStateWriteError).written).toEqual([]);
    expect(await readdir(s.root)).toEqual([]);
    expect(s.fake.rows(schema.repositories)[0]?.renderContext ?? null).toBeNull();
    expect(s.fake.rows(schema.projectStateSync)).toEqual([]);
  });

  it('writes a ledger of 4,092 claims, which the reader takes in whole', LONG, async () => {
    const s = await setup(AT_LIMIT);

    const { written } = await s.write();

    expect(written).toHaveLength(AT_LIMIT + 2);
    expect((await readdir(join(s.root, STATE), { recursive: true })).length).toBe(4096);
    const synced = await syncProjectStateFromCheckout(s.db, {
      repositoryId: REPO,
      repoPath: s.root,
    });
    expect(synced.outcome).toBe('unchanged');
  });
});
