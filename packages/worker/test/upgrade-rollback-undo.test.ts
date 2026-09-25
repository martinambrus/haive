import { writeFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  swap: null as null | { when: string; path: string; content: string },
}));

vi.mock('@haive/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...real,
    // A person saving the file at the moment the rollback hashes what it is about to delete.
    sha256Hex: (input: string) => {
      const swap = h.swap;
      if (swap && input === swap.when) {
        h.swap = null;
        writeFileSync(swap.path, swap.content);
      }
      return real.sha256Hex(input);
    },
  };
});

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const PRIOR_TASK = '00000000-0000-4000-8000-0000000000c2';
const REL = '.claude/agents/new.md';

const dirs: string[] = [];
afterEach(async () => {
  h.swap = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-rollback-undo-'));
  dirs.push(root);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await writeFile(join(root, REL), 'HAIVE\n', 'utf8');
  const fake = createFakeDb({ onboardingArtifacts: schema.onboardingArtifacts });
  const row = fake.insert(schema.onboardingArtifacts, {
    userId: USER,
    repositoryId: REPO,
    taskId: PRIOR_TASK,
    diskPath: REL,
    templateId: 'agent.new',
    templateKind: 'agent',
    templateSchemaVersion: 1,
    templateContentHash: sha256Hex(normalizeContent('HAIVE\n')),
    writtenHash: sha256Hex(normalizeContent('HAIVE\n')),
    source: 'upgrade',
  });
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const detected = {
    repositoryId: REPO,
    rolledBackFromTaskId: PRIOR_TASK,
    targets: [],
    newArtifactsToUndo: [
      {
        diskPath: REL,
        templateKind: 'agent',
        upgradeArtifactId: row.id as string,
        writtenHash: sha256Hex(normalizeContent('HAIVE\n')),
      },
    ],
    warnings: [],
  };
  return { root, fake, ctx, detected };
}

describe('rolling back a file an upgrade introduced', () => {
  it('deletes it while it holds what the upgrade wrote', async () => {
    const { root, fake, ctx, detected } = await setup();
    const out = await upgradeRollbackStep.apply(ctx, { detected } as never);
    expect(out.revertedCount).toBe(1);
    await expect(lstat(join(root, REL))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.rows(schema.onboardingArtifacts)[0]!.supersededAt).toBeInstanceOf(Date);
  });

  it('leaves an absent AGENTS.md absent when it undoes the rules region', async () => {
    const { root, ctx, detected } = await setup();
    const undo = detected.newArtifactsToUndo[0]!;
    detected.newArtifactsToUndo = [
      { ...undo, diskPath: 'AGENTS.md', templateKind: CLI_RULES_TEMPLATE_KIND },
    ];
    await upgradeRollbackStep.apply(ctx, { detected } as never);
    await expect(lstat(join(root, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('puts back live the row the upgrade retired where the file was missing', async () => {
    const { root, fake, ctx, detected } = await setup();
    const retired = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: REL,
      templateId: 'agent.new',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'older-template',
      writtenHash: 'older-bytes',
      writtenContent: 'OLDER\n',
      source: 'onboarding',
      supersededAt: new Date(),
    });
    const undo = { ...detected.newArtifactsToUndo[0]!, retiredRowId: retired.id };
    await upgradeRollbackStep.apply(ctx, {
      detected: { ...detected, newArtifactsToUndo: [undo] },
    } as never);
    await expect(lstat(join(root, REL))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fake.rows(schema.onboardingArtifacts).filter((r) => r.supersededAt == null)).toEqual([
      expect.objectContaining({
        diskPath: REL,
        source: 'rollback',
        templateContentHash: 'older-template',
        writtenHash: 'older-bytes',
        writtenContent: 'OLDER\n',
      }),
    ]);
  });

  const createdAgents = async (agents: string) => {
    const { root, ctx, detected } = await setup();
    await writeFile(join(root, 'AGENTS.md'), agents, 'utf8');
    const region = normalizeContent(extractRegion(agents, CLI_RULES_START, CLI_RULES_END)!);
    const undo = {
      ...detected.newArtifactsToUndo[0]!,
      diskPath: 'AGENTS.md',
      templateKind: CLI_RULES_TEMPLATE_KIND,
      writtenHash: sha256Hex(region),
      fileCreated: true,
    };
    await upgradeRollbackStep.apply(ctx, {
      detected: { ...detected, newArtifactsToUndo: [undo] },
    } as never);
    return join(root, 'AGENTS.md');
  };

  it('takes away an AGENTS.md the upgrade created for the rules region', async () => {
    const path = await createdAgents(`${CLI_RULES_START}\nRULES\n${CLI_RULES_END}\n`);
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('but only the region once something else was written to that AGENTS.md', async () => {
    const path = await createdAgents(`${CLI_RULES_START}\nRULES\n${CLI_RULES_END}\n\n# Added\n`);
    expect(await readFile(path, 'utf8')).toBe('\n\n# Added\n');
  });

  it('never takes a file a person saved while its bytes were being judged', async () => {
    const { root, ctx, detected } = await setup();
    h.swap = { when: normalizeContent('HAIVE\n'), path: join(root, REL), content: 'MINE\n' };
    await upgradeRollbackStep.apply(ctx, { detected } as never);
    expect(h.swap).toBeNull();
    expect(await readFile(join(root, REL), 'utf8')).toBe('MINE\n');
  });

  it('never overwrites an AGENTS.md saved while its rules region was being judged', async () => {
    const { root, ctx, detected } = await setup();
    const agents = `# Notes\n\n${CLI_RULES_START}\nRULES\n${CLI_RULES_END}\n`;
    await writeFile(join(root, 'AGENTS.md'), agents, 'utf8');
    const region = normalizeContent(extractRegion(agents, CLI_RULES_START, CLI_RULES_END)!);
    const undo = detected.newArtifactsToUndo[0]!;
    detected.newArtifactsToUndo = [
      {
        ...undo,
        diskPath: 'AGENTS.md',
        templateKind: CLI_RULES_TEMPLATE_KIND,
        writtenHash: sha256Hex(region),
      },
    ];
    h.swap = { when: region, path: join(root, 'AGENTS.md'), content: 'MINE\n' };
    await upgradeRollbackStep.apply(ctx, { detected } as never);
    expect(h.swap).toBeNull();
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe('MINE\n');
  });
});
