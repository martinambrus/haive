import { writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
import { RULES_FILE_READ_CAP } from '@haive/shared/rules-files';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

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

describe('rolling back a file an upgrade rewrote', () => {
  const PRIOR = 'PRIOR\n';
  const NEW = 'NEW\n';
  const PRIOR_REGION = `${CLI_RULES_START}\nPRIOR RULES\n${CLI_RULES_END}`;
  const NEW_REGION = `${CLI_RULES_START}\nNEW RULES\n${CLI_RULES_END}`;
  const hashOf = (text: string) => sha256Hex(normalizeContent(text));

  /** What stood before and what the upgrade wrote; `observed` overrides what its row says it left. */
  async function rewrite(opts: { rules?: boolean; observed?: string } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-rollback-restore-'));
    dirs.push(root);
    const rel = opts.rules ? 'AGENTS.md' : REL;
    const prior = opts.rules ? PRIOR_REGION : PRIOR;
    const left = opts.rules ? NEW_REGION : NEW;
    if (opts.rules) {
      await writeFile(join(root, rel), `# Notes\n\n${NEW_REGION}\n`, 'utf8');
    } else {
      await mkdir(join(root, '.claude', 'agents'), { recursive: true });
      await writeFile(join(root, rel), NEW, 'utf8');
    }
    const fake = createFakeDb({
      onboardingArtifacts: schema.onboardingArtifacts,
      repositories: schema.repositories,
    });
    const kind = opts.rules ? CLI_RULES_TEMPLATE_KIND : 'agent';
    const templateId = opts.rules ? 'cli-rules' : 'agent.new';
    const priorRow = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: rel,
      templateId,
      templateKind: kind,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(prior),
      writtenHash: hashOf(prior),
      writtenContent: prior,
      source: 'onboarding',
      supersededAt: new Date(),
    });
    const upgradeRow = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: rel,
      templateId,
      templateKind: kind,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(left),
      writtenHash: opts.observed === undefined ? hashOf(left) : 'the-render-it-claims-none-of',
      lastObservedDiskHash: opts.observed === undefined ? hashOf(left) : hashOf(opts.observed),
      writtenContent: left,
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
      targets: [
        {
          diskPath: rel,
          templateId,
          templateKind: kind,
          templateSchemaVersion: 1,
          priorArtifactId: priorRow.id as string,
          upgradeArtifactId: upgradeRow.id as string,
          priorTemplateContentHash: hashOf(prior),
          priorWrittenHash: hashOf(prior),
          priorWrittenContent: prior,
          priorFormValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
        },
      ],
      newArtifactsToUndo: [],
      warnings: [],
    };
    const apply = () => upgradeRollbackStep.apply(ctx, { detected } as never);
    const live = () =>
      fake
        .rows(schema.onboardingArtifacts)
        .filter((r) => r.supersededAt == null && r.diskPath === rel);
    return { root, path: join(root, rel), fake, upgradeRow, apply, live };
  }

  it('puts back a file that still holds what the upgrade wrote', async () => {
    const { path, apply, live } = await rewrite();
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(PRIOR);
    expect(out.revertedCount).toBe(1);
    expect(live()).toEqual([
      expect.objectContaining({ source: 'rollback', writtenContent: PRIOR, userModified: false }),
    ]);
  });

  it('keeps a file edited after the upgrade, says so, and reverts its ledger all the same', async () => {
    const { path, fake, upgradeRow, apply, live } = await rewrite();
    await writeFile(path, 'MINE\n', 'utf8');
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe('MINE\n');
    expect(out.revertedCount).toBe(0);
    expect(out.warnings.join('\n')).toContain(`kept ${REL} as it is`);
    const upgrade = fake.rows(schema.onboardingArtifacts).find((r) => r.id === upgradeRow.id);
    expect(upgrade?.supersededAt).toBeInstanceOf(Date);
    expect(live()).toEqual([
      expect.objectContaining({
        source: 'rollback',
        writtenContent: PRIOR,
        userModified: true,
        lastObservedDiskHash: hashOf('MINE\n'),
      }),
    ]);
  });

  it('leaves a file removed after the upgrade removed', async () => {
    const { path, apply } = await rewrite();
    await rm(path);
    const out = await apply();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(out.revertedCount).toBe(0);
    expect(out.warnings.join('\n')).toContain(`did not put back ${REL}`);
  });

  it('counts a file an earlier attempt already put back', async () => {
    const { path, apply } = await rewrite();
    await writeFile(path, PRIOR, 'utf8');
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(PRIOR);
    expect(out.revertedCount).toBe(1);
  });

  it('judges by what the upgrade left there, not by what its row claims', async () => {
    const { path, apply } = await rewrite({ observed: NEW });
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(PRIOR);
    expect(out.revertedCount).toBe(1);
  });

  it('never overwrites a file saved while its bytes were being judged', async () => {
    const { root, path, apply } = await rewrite();
    h.swap = { when: normalizeContent(NEW), path, content: 'MINE\n' };
    const out = await apply();
    expect(h.swap).toBeNull();
    expect(await readFile(path, 'utf8')).toBe('MINE\n');
    expect(out.revertedCount).toBe(0);
    const parked = /what the rollback put back is at (\S+)$/m.exec(out.warnings.join('\n'))?.[1];
    expect(parked).toBeDefined();
    expect(await readFile(join(root, parked!), 'utf8')).toBe(PRIOR);
  });

  it('puts back the rules region, and only the region', async () => {
    const { path, apply } = await rewrite({ rules: true });
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(`# Notes\n\n${PRIOR_REGION}\n`);
    expect(out.revertedCount).toBe(1);
  });

  it('keeps a rules region edited after the upgrade', async () => {
    const { path, apply } = await rewrite({ rules: true });
    const mine = `# Notes\n\n${CLI_RULES_START}\nMY RULES\n${CLI_RULES_END}\n`;
    await writeFile(path, mine, 'utf8');
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(mine);
    expect(out.revertedCount).toBe(0);
    expect(out.warnings.join('\n')).toContain('kept the rules region in AGENTS.md as it is');
  });

  it('leaves AGENTS.md absent when it was removed after the upgrade', async () => {
    const { path, apply } = await rewrite({ rules: true });
    await rm(path);
    const out = await apply();
    await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(out.warnings.join('\n')).toContain('did not put back the rules region in AGENTS.md');
  });

  it('leaves AGENTS.md without the region when the region was removed after the upgrade', async () => {
    const { path, apply } = await rewrite({ rules: true });
    await writeFile(path, '# Notes\n', 'utf8');
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe('# Notes\n');
    expect(out.revertedCount).toBe(0);
  });
});

describe('rolling back what an upgrade removed', () => {
  const REGION = `${CLI_RULES_START}\nTHE RULES\n${CLI_RULES_END}`;
  const hashOf = (text: string) => sha256Hex(normalizeContent(text));

  /** An upgrade that removed `rel` (or the rules region in it), holding `prior` before. */
  async function removed(rel: string, prior: string) {
    const root = await mkdtemp(join(tmpdir(), 'upgrade-rollback-removed-'));
    dirs.push(root);
    const rules = rel === 'AGENTS.md';
    const fake = createFakeDb({
      onboardingArtifacts: schema.onboardingArtifacts,
      repositories: schema.repositories,
    });
    const templateId = rules ? 'cli-rules' : 'agent.gone';
    const kind = rules ? CLI_RULES_TEMPLATE_KIND : 'agent';
    const baseline = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: rel,
      templateId,
      templateKind: kind,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(prior),
      writtenHash: hashOf(prior),
      writtenContent: prior,
      source: 'backfill',
      supersededAt: new Date(),
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
      targets: [
        {
          diskPath: rel,
          templateId,
          templateKind: kind,
          templateSchemaVersion: 1,
          priorArtifactId: baseline.id as string,
          upgradeArtifactId: null,
          removed: true,
          priorTemplateContentHash: hashOf(prior),
          priorWrittenHash: hashOf(prior),
          priorWrittenContent: prior,
          priorFormValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
        },
      ],
      newArtifactsToUndo: [],
      warnings: [],
    };
    const apply = () => upgradeRollbackStep.apply(ctx, { detected } as never);
    return { root, path: join(root, rel), apply };
  }

  it('puts the rules region back into an AGENTS.md within the read cap', async () => {
    const { path, apply } = await removed('AGENTS.md', REGION);
    await writeFile(path, '# Notes\n', 'utf8');
    const out = await apply();
    expect(extractRegion(await readFile(path, 'utf8'), CLI_RULES_START, CLI_RULES_END)).toBe(
      REGION,
    );
    expect(out.revertedCount).toBe(1);
  });

  it('leaves an AGENTS.md past the read cap as it is, and says why', async () => {
    const { path, apply } = await removed('AGENTS.md', REGION);
    const big = `# Notes\n${'x'.repeat(RULES_FILE_READ_CAP)}\n`;
    await writeFile(path, big, 'utf8');
    const out = await apply();
    expect(await readFile(path, 'utf8')).toBe(big);
    expect(out.revertedCount).toBe(0);
    expect(out.warnings).toContain(
      `did not put back AGENTS.md: it could not be compared with what the upgrade removed (a link, not a regular file, or larger than ${RULES_FILE_READ_CAP} bytes)`,
    );
  });

  it('leaves a path reached through a link as it is, without failing the rollback', async () => {
    const { root, apply } = await removed(REL, 'HAIVE\n');
    await mkdir(join(root, '.claude', 'elsewhere'), { recursive: true });
    await symlink('elsewhere', join(root, '.claude', 'agents'));
    const out = await apply();
    expect(await readlink(join(root, '.claude', 'agents'))).toBe('elsewhere');
    await expect(lstat(join(root, '.claude', 'elsewhere', 'new.md'))).rejects.toThrow();
    expect(out.warnings).toContain(
      `did not put back ${REL}: it could not be compared with what the upgrade removed (a link, not a regular file, or larger than ${RULES_FILE_READ_CAP} bytes)`,
    );
  });
});
