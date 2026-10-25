import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDirNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  changedFilesBlock,
  collectChangeSet,
  collectChangedLineMap,
  fileCoverage,
  isDocsOnlyChange,
} from './_impl-changes.js';
import { codeSimplifyStep } from './07a-code-simplify.js';
import { phase4ValidateStep } from './07b-phase-4-validate.js';
import { codeAuditStep } from './08c2-code-audit.js';
import {
  SCOPE_FENCE_INSIGHTS,
  SCOPE_FENCE_IN_SCOPE_FLAG,
  SCOPE_FENCE_REPORT_ONLY,
} from '../_scope-fence.js';
import { gateContext, git, repoFixture } from '../../../../test/support/nested-repo.js';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('impl-changes nested repository controls', () => {
  it.each([false, true])('names a nested repository (with commits: %s)', async (committed) => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    await ensureDirNoFollow(repo, 'nested');
    await git(path.join(repo, 'nested'), ['init', '-q', '-b', 'main']);
    await writeFileNoFollow(repo, 'nested/inside.txt', 'contents\n');
    if (committed) {
      await git(path.join(repo, 'nested'), ['add', '-A']);
      await git(path.join(repo, 'nested'), ['commit', '-q', '-m', 'nested seed']);
    }
    const set = await collectChangeSet(repo, 'main', new Set());
    expect(set.files).toEqual(['nested/']);
    expect(set.changedLines?.['nested/']).toBe(
      committed ? 'nested repository (with commits)' : 'nested repository (unborn)',
    );
    const block = changedFilesBlock(set, 'Changed files', '');
    expect(block).toContain('nested repository');
    expect(block).not.toContain('new file');
    expect(block).toContain('not a file');
    expect(set.nestedRepositories).toEqual({ 'nested/': committed ? 'with commits' : 'unborn' });
    expect(fileCoverage(set)).toEqual({ listed: 1, total: 1, truncated: false });
    expect(isDocsOnlyChange(set)).toBe(false);
    for (const step of [codeSimplifyStep, phase4ValidateStep, codeAuditStep]) {
      const prompt = step.llm!.buildPrompt({
        detected: {
          implementationFiles: JSON.parse(JSON.stringify(set)),
          spec: 'spec',
          sandboxWorktreePath: '/workspace',
        },
        formValues: {},
      } as never);
      expect(prompt).toContain('nested repository');
      expect(prompt).toContain('not a file');
      expect(prompt).not.toContain('new file');
    }
  });

  it.each([false, true])('recognizes a nested gitfile (with commits: %s)', async (committed) => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    await ensureDirNoFollow(repo, 'nested');
    await ensureDirNoFollow(repo, '.haive');
    await git(path.join(repo, 'nested'), [
      'init',
      '-q',
      '--separate-git-dir',
      path.join(repo, '.haive/nested-git'),
    ]);
    await writeFileNoFollow(repo, 'nested/inside.txt', 'contents\n');
    if (committed) {
      await git(path.join(repo, 'nested'), ['add', '-A']);
      await git(path.join(repo, 'nested'), ['commit', '-q', '-m', 'seed']);
    }
    const set = await collectChangeSet(repo, 'main', new Set());
    expect(set.nestedRepositories).toEqual({ 'nested/': committed ? 'with commits' : 'unborn' });
    expect(set.changedLines?.['nested/']).toBe(
      `nested repository (${committed ? 'with commits' : 'unborn'})`,
    );
  });

  it('keeps real file lines while giving a nested boundary no file or descendant lint lines', async () => {
    const { repo, cleanup } = await repoFixture();
    cleanups.push(cleanup);
    await ensureDirNoFollow(repo, 'nested');
    await git(path.join(repo, 'nested'), ['init', '-q']);
    await writeFileNoFollow(repo, 'nested/inside.txt', 'contents\n');
    const ctx = gateContext(repo);
    const chain = ctx.db.select() as unknown as Record<string, unknown>;
    chain.limit = async () => [{ output: { baseBranch: 'main' } }];
    const empty = await collectChangedLineMap(ctx, repo);
    expect(empty).toBeInstanceOf(Map);
    expect(empty?.size).toBe(0);
    await writeFileNoFollow(repo, 'a.txt', 'after\n');
    const lines = await collectChangedLineMap(ctx, repo);
    expect([...lines!.keys()]).toEqual(['a.txt']);
    expect(lines?.get('a.txt')).toEqual({ whole: false, ranges: [[1, 1]] });
    const set = await collectChangeSet(repo, 'main', new Set());
    expect(set.changedLines?.['a.txt']).toBe('lines 1');
    expect(set.changedLines?.['nested/']).toBe('nested repository (unborn)');
  });

  it('keeps nested repository contents outside every shared scope fence', () => {
    for (const fence of [
      SCOPE_FENCE_INSIGHTS,
      SCOPE_FENCE_IN_SCOPE_FLAG,
      SCOPE_FENCE_REPORT_ONLY,
    ]) {
      expect(fence.join('\n')).toContain('nested repository entry describes a checkout boundary');
      expect(fence.join('\n')).toContain(
        'separately listed as changed or reached by demonstrated blast radius',
      );
    }
  });
});
