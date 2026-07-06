import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { skillSyncStep } from './11d-skill-sync.js';

const execFileP = promisify(execFile);
const DIRS = ['.claude/skills', '.gemini/skills'];

/** A valid skill JSON payload (fenced, as a CLI would emit) with 3 sub-skills whose
 *  bodies clear the verification body floor. */
function skillJson(id: string, title = `${id} Synced`): string {
  const sub = (slug: string) => ({
    slug,
    name: `${id}-${slug}`,
    title: `Title ${slug}`,
    description: `activation description for ${slug}`,
    summary: `summary for ${slug}`,
    body: `## Purpose\n\nThe ${slug} leaf explains one facet in enough prose to clear the body floor and then some, citing lib/x.ts:1-9.`,
  });
  const obj = {
    skills: [
      {
        id,
        title,
        description: `A synced ${id} skill.`,
        overview: 'What this domain covers and when an agent invokes it.',
        subSkills: [sub('alpha'), sub('beta'), sub('gamma')],
      },
    ],
  };
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeSkillDir(
  repo: string,
  dir: string,
  id: string,
  skillMd: string,
): Promise<void> {
  const base = path.join(repo, ...dir.split('/'), id);
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'SKILL.md'), skillMd, 'utf8');
}

const miningResult = (agentId: string, output: unknown): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'done',
  output,
  rawOutput: typeof output === 'string' ? output : null,
  errorMessage: null,
});

interface Target {
  kind: 'new' | 'update';
  skillId: string;
  capability: string;
  rationale: string;
  skillMdExcerpt: string | null;
}

function detectStub(over: {
  worktreePath: string;
  targets?: Target[];
  removals?: string[];
  skillTargetDirs?: string[];
}): unknown {
  return {
    targets: over.targets ?? [],
    removals: over.removals ?? [],
    skillTargetDirs: over.skillTargetDirs ?? DIRS,
    worktreePath: over.worktreePath,
    framework: 'general',
    language: 'php',
    kbFiles: [],
    __fileTree: '(tree)',
    __scopeExclude: [],
  };
}

const ctxFor = (over: Partial<StepContext> = {}): StepContext =>
  ({ logger: { info: () => {} }, ...over }) as unknown as StepContext;

const newTarget = (skillId: string, capability: string): Target => ({
  kind: 'new',
  skillId,
  capability,
  rationale: 'what it does',
  skillMdExcerpt: null,
});
const updateTarget = (skillId: string, excerpt: string | null = '# old\n\nold body'): Target => ({
  kind: 'update',
  skillId,
  capability: '',
  rationale: 'what changed',
  skillMdExcerpt: excerpt,
});

function withBypass<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.HAIVE_TEST_BYPASS_LLM;
  if (value === undefined) delete process.env.HAIVE_TEST_BYPASS_LLM;
  else process.env.HAIVE_TEST_BYPASS_LLM = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.HAIVE_TEST_BYPASS_LLM;
    else process.env.HAIVE_TEST_BYPASS_LLM = prev;
  }
}

describe('skillSyncStep.agentMining.selectAgents', () => {
  it('dispatches one agent per new/update target with the id pinned and kind-specific framing', async () => {
    const dispatches = await withBypass(undefined, () =>
      skillSyncStep.agentMining!.selectAgents({
        ctx: ctxFor(),
        detected: detectStub({
          worktreePath: '/tmp/x',
          targets: [newTarget('boat-sync', 'Boat Catalogue Sync'), updateTarget('fleet-search')],
        }),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(dispatches).toHaveLength(2);
    expect(new Set(dispatches.map((d) => d.agentId))).toEqual(
      new Set(['boat-sync', 'fleet-search']),
    );
    const byId = (id: string) => dispatches.find((d) => d.agentId === id)!.prompt;
    expect(byId('boat-sync')).toContain('Skill to create: `boat-sync`');
    expect(byId('boat-sync')).toContain('Boat Catalogue Sync');
    expect(byId('fleet-search')).toContain('Skill to update: `fleet-search`');
    // The current SKILL.md excerpt is inlined for an update.
    expect(byId('fleet-search')).toContain('Current SKILL.md');
  });

  it('dispatches nothing under test bypass or for a removals-only run', async () => {
    const bypassed = await withBypass('1', () =>
      skillSyncStep.agentMining!.selectAgents({
        ctx: ctxFor(),
        detected: detectStub({ worktreePath: '/tmp/x', targets: [newTarget('a', 'A')] }),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(bypassed).toEqual([]);
    const removalsOnly = await withBypass(undefined, () =>
      skillSyncStep.agentMining!.selectAgents({
        ctx: ctxFor(),
        detected: detectStub({ worktreePath: '/tmp/x', removals: ['gone'] }),
        formValues: {},
        llmOutput: undefined,
      }),
    );
    expect(removalsOnly).toEqual([]);
  });
});

describe('skillSyncStep.apply', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), 'skill-sync-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const apply = (detected: unknown, results: AgentMiningResult[]) =>
    skillSyncStep.apply(ctxFor(), {
      detected,
      formValues: {},
      agentMiningResults: results,
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillSyncStep.apply>[1]) as Promise<{
      generated: string[];
      removed: string[];
      skipped: string[];
      committed: boolean;
    }>;

  it('materialises a NEW skill across every mirror dir and rebuilds the README', async () => {
    const out = await apply(
      detectStub({ worktreePath: repo, targets: [newTarget('boat-sync', 'Boat Catalogue Sync')] }),
      [miningResult('boat-sync', skillJson('boat-sync'))],
    );
    expect(out.generated).toEqual(['boat-sync']);
    expect(out.committed).toBe(false); // no .git in the temp repo
    for (const dir of DIRS) {
      const base = path.join(repo, ...dir.split('/'), 'boat-sync');
      expect(await readFile(path.join(base, 'SKILL.md'), 'utf8')).toContain('boat-sync Synced');
      expect(await exists(path.join(base, 'sub-skills', 'alpha.md'))).toBe(true);
      expect(await readFile(path.join(repo, ...dir.split('/'), 'README.md'), 'utf8')).toContain(
        'boat-sync',
      );
    }
  });

  it('forces the on-disk id for an UPDATE even when the agent renames the skill', async () => {
    const out = await apply(
      detectStub({ worktreePath: repo, targets: [updateTarget('fleet-search')] }),
      [miningResult('fleet-search', skillJson('some-other-id'))],
    );
    expect(out.generated).toEqual(['fleet-search']);
    for (const dir of DIRS) {
      expect(await exists(path.join(repo, ...dir.split('/'), 'fleet-search', 'SKILL.md'))).toBe(
        true,
      );
      expect(await exists(path.join(repo, ...dir.split('/'), 'some-other-id'))).toBe(false);
    }
  });

  it('skips an unparseable result, leaving a prior skill untouched', async () => {
    // Prior fleet-search on disk (the update baseline).
    for (const dir of DIRS)
      await writeSkillDir(repo, dir, 'fleet-search', '# Fleet\n\noriginal content\n');
    const out = await apply(
      detectStub({ worktreePath: repo, targets: [updateTarget('fleet-search')] }),
      [miningResult('fleet-search', 'sorry, no JSON')],
    );
    expect(out.generated).toEqual([]);
    expect(out.skipped).toEqual(['fleet-search']);
    for (const dir of DIRS) {
      const smd = await readFile(
        path.join(repo, ...dir.split('/'), 'fleet-search', 'SKILL.md'),
        'utf8',
      );
      expect(smd).toContain('original content');
    }
  });

  it('deletes a removed skill across mirror dirs and rebuilds the README from the survivors', async () => {
    for (const dir of DIRS) {
      await writeSkillDir(repo, dir, 'gone', '# Gone\n\nremoved capability\n');
      await writeSkillDir(
        repo,
        dir,
        'kept',
        '---\nname: kept\ndescription: kept\n---\n\n# Kept\n\n## Overview\n\nx\n',
      );
    }
    const out = await apply(detectStub({ worktreePath: repo, removals: ['gone'] }), []);
    expect(out.removed).toEqual(['gone']);
    for (const dir of DIRS) {
      expect(await exists(path.join(repo, ...dir.split('/'), 'gone'))).toBe(false);
      expect(await exists(path.join(repo, ...dir.split('/'), 'kept'))).toBe(true);
      const readme = await readFile(path.join(repo, ...dir.split('/'), 'README.md'), 'utf8');
      expect(readme).toContain('kept');
      expect(readme).not.toContain('gone');
    }
  });

  it('self-commits the skill dirs when the worktree is a git repo', async () => {
    await execFileP('git', ['-C', repo, 'init', '-q']);
    const ctx = ctxFor({
      userId: 'u',
      db: { query: { users: { findFirst: async () => null } } } as unknown as StepContext['db'],
    });
    const out = (await skillSyncStep.apply(ctx, {
      detected: detectStub({
        worktreePath: repo,
        targets: [newTarget('boat-sync', 'Boat Catalogue Sync')],
      }),
      formValues: {},
      agentMiningResults: [miningResult('boat-sync', skillJson('boat-sync'))],
      iteration: 0,
      previousIterations: [],
    } as unknown as Parameters<typeof skillSyncStep.apply>[1])) as {
      generated: string[];
      committed: boolean;
      commitSha: string | null;
    };
    expect(out.generated).toEqual(['boat-sync']);
    expect(out.committed).toBe(true);
    expect(out.commitSha).toBeTruthy();
    // The skill files are committed (clean tree under the skills dir).
    const status = await execFileP('git', [
      '-C',
      repo,
      'status',
      '--porcelain',
      '--',
      '.claude/skills',
    ]);
    expect(status.stdout.trim()).toBe('');
  });
});

describe('skillSyncStep.shouldRun', () => {
  const dbForLearning = (output: unknown): StepContext['db'] =>
    ({
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () =>
                Promise.resolve(
                  output === undefined ? [] : [{ detectOutput: null, output, iterations: [] }],
                ),
            }),
          }),
        }),
      }),
    }) as unknown as StepContext['db'];

  const ctx = (output: unknown): StepContext =>
    ({ taskId: 't', db: dbForLearning(output) }) as unknown as StepContext;

  it('runs when the learning output carries new/update or removal ops', async () => {
    expect(
      await skillSyncStep.shouldRun!(
        ctx({ skillSync: { newUpdate: [{ op: 'new_feature', capability: 'X' }], remove: [] } }),
      ),
    ).toBe(true);
    expect(
      await skillSyncStep.shouldRun!(
        ctx({ skillSync: { newUpdate: [], remove: [{ op: 'feature_removal', skillId: 'y' }] } }),
      ),
    ).toBe(true);
  });

  it('does not run with an empty, null, or absent skillSync', async () => {
    expect(await skillSyncStep.shouldRun!(ctx({ skillSync: { newUpdate: [], remove: [] } }))).toBe(
      false,
    );
    expect(await skillSyncStep.shouldRun!(ctx({ skillSync: null }))).toBe(false);
    expect(await skillSyncStep.shouldRun!(ctx({}))).toBe(false);
    expect(await skillSyncStep.shouldRun!(ctx(undefined))).toBe(false);
  });
});
