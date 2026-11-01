import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { claimFileName, emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
import * as stateReads from './sync.js';
import { commitProjectStatePush } from './push.js';
const identity = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@local',
};
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function git(cwd: string, args: string[]) {
  const res = await gitRun(cwd, args, identity);
  if (res.code) throw new Error(res.stderr || res.stdout);
  return res.stdout.trim();
}
async function state(root: string, globs: string[]) {
  for (const [rel, text] of renderProjectState({
    ...emptyProjectState(),
    settings: { 'scope-exclude-globs': globs },
  })) {
    await mkdir(path.dirname(path.join(root, '.haive-data/state', rel)), { recursive: true });
    await writeFile(path.join(root, '.haive-data/state', rel), text);
  }
}
async function fixture(targetRel = 'feature') {
  const source = await mkdtemp(path.join(tmpdir(), 'project-state-push-'));
  dirs.push(source);
  await git(source, ['init', '-q', '-b', 'main']);
  await state(source, ['old/**']);
  await git(source, ['add', '.haive-data/state']);
  await git(source, ['commit', '-qm', 'base']);
  const target = path.join(source, targetRel);
  await mkdir(path.dirname(target), { recursive: true });
  await git(source, ['worktree', 'add', '-q', '-b', 'feature', target]);
  return { source, target };
}
const tx = {} as Parameters<Parameters<Database['transaction']>[0]>[0];
describe('project state push into a feature worktree', () => {
  it('keeps a legacy checkout with no state record unchanged', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'legacy-projection-push-'));
    dirs.push(root);
    await git(root, ['init', '-q', '-b', 'main']);
    await writeFile(path.join(root, 'code'), 'legacy\n');
    await git(root, ['add', 'code']);
    await git(root, ['commit', '-qm', 'legacy']);
    const head = await git(root, ['rev-parse', 'HEAD']);
    expect(
      await commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: root,
        targetPath: root,
        identity,
      }),
    ).toBeNull();
    expect(await git(root, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('copies dirty root projections to the feature commit, preserving unrelated staged bytes and unknown files', async () => {
    const { source, target } = await fixture();
    const base = await git(source, ['rev-parse', 'main']);
    await state(source, ['new/**']);
    await writeFile(path.join(target, '.haive-data/state/personal.txt'), 'personal\n');
    await writeFile(path.join(target, 'notes'), 'staged\n');
    await git(target, ['add', 'notes', '.haive-data/state/personal.txt']);
    const staged = await git(target, [
      'ls-files',
      '--stage',
      '--',
      'notes',
      '.haive-data/state/personal.txt',
    ]);
    await writeFile(path.join(target, 'notes'), 'unstaged\n');
    await commitProjectStatePush(tx, {
      repositoryId: null,
      sourcePath: source,
      targetPath: target,
      identity,
    });
    expect(await git(source, ['rev-parse', 'main'])).toBe(base);
    expect(
      await git(target, ['show', 'HEAD:.haive-data/state/settings/scope-exclude-globs.json']),
    ).toContain('new/**');
    expect(
      await git(target, ['ls-files', '--stage', '--', 'notes', '.haive-data/state/personal.txt']),
    ).toBe(staged);
    expect(
      await git(target, [
        'ls-tree',
        '--name-only',
        'HEAD',
        '--',
        'notes',
        '.haive-data/state/personal.txt',
      ]),
    ).toBe('');
    expect(await readFile(path.join(target, 'notes'), 'utf8')).toBe('unstaged\n');
  });
  it('refuses a feature file edited after put-back without overwriting it', async () => {
    const { source, target } = await fixture();
    await state(source, ['team/**']);
    await state(target, ['feature-edit/**']);
    const before = await readFile(
      path.join(target, '.haive-data/state/settings/scope-exclude-globs.json'),
      'utf8',
    );
    await expect(
      commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: source,
        targetPath: target,
        identity,
      }),
    ).rejects.toThrow('feature project state changed');
    expect(
      await readFile(
        path.join(target, '.haive-data/state/settings/scope-exclude-globs.json'),
        'utf8',
      ),
    ).toBe(before);
  });
});

describe('push target containment and three-way record ownership', () => {
  it.each(['target', 'ancestor'])(
    'refuses a substituted %s even when target bytes already equal desired',
    async (swap) => {
      const { source, target } = await fixture('trees/feature');
      await state(source, ['pending/**']);
      await state(target, ['pending/**']);
      const outer = await mkdtemp(path.join(tmpdir(), 'outside-push-'));
      dirs.push(outer);
      const moved = swap === 'target' ? target : path.dirname(target);
      const parked = path.join(outer, 'parked');
      await rename(moved, parked);
      await symlink(parked, moved);
      const outsideTarget = swap === 'target' ? parked : path.join(parked, 'feature');
      const before = await git(outsideTarget, ['rev-parse', 'HEAD']);
      await expect(
        commitProjectStatePush(tx, {
          repositoryId: null,
          sourcePath: source,
          targetPath: target,
          identity,
        }),
      ).rejects.toThrow();
      expect(await git(outsideTarget, ['rev-parse', 'HEAD'])).toBe(before);
    },
  );

  it('refuses an ancestor replaced after preflight before the scoped commit reads it', async () => {
    const { source, target } = await fixture('trees/feature');
    await state(source, ['pending/**']);
    await state(target, ['pending/**']);
    const outside = await mkdtemp(path.join(tmpdir(), 'late-outside-push-'));
    dirs.push(outside);
    const parked = path.join(outside, 'trees');
    const before = await git(target, ['rev-parse', 'HEAD']);
    const read = stateReads.readStateFiles;
    let sourceReads = 0;
    vi.spyOn(stateReads, 'readStateFiles').mockImplementation(async (root, opts) => {
      const result = await read(root, opts);
      if (root === source && ++sourceReads === 2) {
        await rename(path.dirname(target), parked);
        await symlink(parked, path.dirname(target));
      }
      return result;
    });
    await expect(
      commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: source,
        targetPath: target,
        identity,
      }),
    ).rejects.toThrow();
    expect(sourceReads).toBe(2);
    expect(await git(path.join(parked, 'feature'), ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('retains landed target-only settings and claims while carrying pending source changes', async () => {
    const { source, target } = await fixture();
    const claim = {
      path: 'AGENTS.md',
      templateId: 'cli-rules',
      kind: 'cli-rules',
      schemaVersion: 1,
      templateHash: 'a'.repeat(64),
      writtenHash: 'b'.repeat(64),
      haiveVersion: '0.1.0',
    };
    for (const [rel, text] of renderProjectState({
      ...emptyProjectState(),
      settings: { 'scope-exclude-globs': ['old/**'], 'rtk-version': 'target-only' },
      claims: [claim],
    })) {
      await mkdir(path.dirname(path.join(target, '.haive-data/state', rel)), { recursive: true });
      await writeFile(path.join(target, '.haive-data/state', rel), text);
    }
    await git(target, ['add', '.haive-data/state']);
    await git(target, ['commit', '-qm', 'target-only portable state']);
    await writeFile(path.join(source, 'code'), 'source code commit\n');
    await git(source, ['add', 'code']);
    await git(source, ['commit', '-qm', 'source code']);
    await git(target, ['merge', '--no-ff', '--no-edit', 'main']);
    await state(source, ['pending/**']);
    const rootHead = await git(source, ['rev-parse', 'HEAD']);
    await commitProjectStatePush(tx, {
      repositoryId: null,
      sourcePath: source,
      targetPath: target,
      identity,
    });
    expect(
      await readFile(path.join(target, '.haive-data/state/settings/rtk-version.json'), 'utf8'),
    ).toContain('target-only');
    expect(
      JSON.parse(
        await readFile(path.join(target, '.haive-data/state', claimFileName(claim.path)), 'utf8'),
      ),
    ).toEqual(claim);
    expect(
      await git(target, ['show', 'HEAD:.haive-data/state/settings/scope-exclude-globs.json']),
    ).toContain('pending/**');
    expect(await git(source, ['rev-parse', 'HEAD'])).toBe(rootHead);
    expect(
      await readFile(
        path.join(source, '.haive-data/state/settings/scope-exclude-globs.json'),
        'utf8',
      ),
    ).toContain('pending/**');
  });

  it('refuses divergent scalar state before changing either branch record or HEAD', async () => {
    const { source, target } = await fixture();
    const rel = '.haive-data/state/settings/agent-rules.md';
    await writeFile(path.join(source, rel), 'pending source rules\n');
    await writeFile(path.join(target, rel), 'committed target rules\n');
    await git(target, ['add', rel]);
    await git(target, ['commit', '-qm', 'target rules']);
    const before = await git(target, ['rev-parse', 'HEAD']);
    await expect(
      commitProjectStatePush(tx, {
        repositoryId: null,
        sourcePath: source,
        targetPath: target,
        identity,
      }),
    ).rejects.toThrow(/project state.*conflict/);
    expect(await git(target, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await readFile(path.join(target, rel), 'utf8')).toBe('committed target rules\n');
    expect(await readFile(path.join(source, rel), 'utf8')).toBe('pending source rules\n');
  });
});

it('merges a PR target and committed root state from their actual shared ancestor', async () => {
  const { source, target } = await fixture();
  await writeFile(
    path.join(source, '.haive-data/state/settings/rtk-version.json'),
    '"root-version"\n',
  );
  await git(source, ['add', '.haive-data/state']);
  await git(source, ['commit', '-qm', 'root state advanced']);
  await writeFile(
    path.join(target, '.haive-data/state/settings/agent-rules.md'),
    'target-only rules\n',
  );
  await git(target, ['add', '.haive-data/state']);
  await git(target, ['commit', '-qm', 'PR target state advanced']);
  await state(source, ['pending/**']);
  const before = await git(source, ['rev-parse', 'HEAD']);
  await commitProjectStatePush(tx, {
    repositoryId: null,
    sourcePath: source,
    targetPath: target,
    identity,
  });
  expect(
    await readFile(path.join(target, '.haive-data/state/settings/agent-rules.md'), 'utf8'),
  ).toBe('target-only rules\n');
  expect(
    await readFile(path.join(target, '.haive-data/state/settings/rtk-version.json'), 'utf8'),
  ).toContain('root-version');
  expect(
    await git(target, ['show', 'HEAD:.haive-data/state/settings/scope-exclude-globs.json']),
  ).toContain('pending/**');
  expect(await git(source, ['rev-parse', 'HEAD'])).toBe(before);
});

it('holds a target HEAD that changes after copy instead of committing against the new tip', async () => {
  const { source, target } = await fixture();
  await state(source, ['pending/**']);
  const read = stateReads.readStateFiles;
  let sourceReads = 0;
  let concurrent = '';
  vi.spyOn(stateReads, 'readStateFiles').mockImplementation(async (root, opts) => {
    const files = await read(root, opts);
    if (root === source && ++sourceReads === 2) {
      await writeFile(path.join(target, 'concurrent-code'), 'keep this commit\n');
      await git(target, ['add', 'concurrent-code']);
      await git(target, ['commit', '-qm', 'concurrent target commit']);
      concurrent = await git(target, ['rev-parse', 'HEAD']);
    }
    return files;
  });
  await expect(
    commitProjectStatePush(tx, {
      repositoryId: null,
      sourcePath: source,
      targetPath: target,
      identity,
    }),
  ).rejects.toThrow(/HEAD changed/);
  expect(await git(target, ['rev-parse', 'HEAD'])).toBe(concurrent);
  expect(
    await readFile(
      path.join(target, '.haive-data/state/settings/scope-exclude-globs.json'),
      'utf8',
    ),
  ).toContain('pending/**');
});
