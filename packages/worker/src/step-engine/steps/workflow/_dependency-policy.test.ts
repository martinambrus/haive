import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepContext } from '../../step-definition.js';
import {
  assertDependencyCommitSafe,
  loadDependencyPolicy,
  parseDependencyOwnership,
  upstreamKind,
  findingUpstream,
  OWNERSHIP_POLICY_PATH,
} from './_dependency-policy.js';

const exec = promisify(execFile);
const directories: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@example.test',
};
const git = (cwd: string, args: string[]) => exec('git', args, { cwd, env });
async function file(root: string, rel: string, body = 'original\n') {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), body);
}
function context(baseBranch?: string, sandboxWorktreePath?: string): StepContext {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () =>
      baseBranch || sandboxWorktreePath ? [{ output: { baseBranch, sandboxWorktreePath } }] : [],
  });
  return { taskId: 'task', db: { select: () => query } } as unknown as StepContext;
}
async function repository(ownedPaths?: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'haive-ownership-'));
  directories.push(root);
  await git(root, ['init', '-q']);
  await file(
    root,
    'composer.json',
    JSON.stringify({ require: { 'drupal/core-recommended': '^11' } }),
  );
  if (ownedPaths) await file(root, OWNERSHIP_POLICY_PATH, JSON.stringify({ ownedPaths }));
  await file(root, 'web/core/lib/Framework.php');
  await file(root, 'web/modules/contrib/admin_toolbar/admin_toolbar.module');
  await file(root, 'web/modules/custom/company/company.module');
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-qm', 'baseline']);
  return root;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('dependency ownership', () => {
  it.each([
    undefined,
    '',
    '  ',
    '.',
    '../vendor/acme/a.php',
    '/other/checkout/core/a.php',
    'C:\\repo\\core\\a.php',
  ])('does not infer project ownership from an unusable location: %s', (file) => {
    expect(upstreamKind(file)).toBe('unknown');
    expect(findingUpstream({ file })).toBe('unknown');
  });

  it('does not let a missing location inherit a stale owned classification', () => {
    expect(findingUpstream({ upstream: null })).toBe('unknown');
  });
  it('distinguishes upstream implementation from project integration and patch artifacts', () => {
    expect(upstreamKind('web/core/lib/Framework.php')).toBe('infrastructure');
    expect(upstreamKind('/haive/workdir/web/modules/contrib/admin_toolbar/a.js:140')).toBe(
      'dependency',
    );
    expect(upstreamKind('frontend/node_modules/pkg/index.js')).toBe('dependency');
    expect(upstreamKind('vendor/acme/pkg/src/index.php')).toBe('dependency');
    for (const rel of [
      'composer.json',
      'composer.lock',
      'patches/admin-toolbar.patch',
      'scripts/enable.php',
      '.ddev/config.yaml',
      'web/modules/custom/company/a.php',
      'src/core/model.ts',
    ]) {
      expect(upstreamKind(rel), rel).toBeNull();
    }
  });

  it('allows specifically owned packages and always protects framework core', () => {
    const policy = {
      drupal: true,
      drupalRoots: ['', 'web'],
      ownedPaths: ['web/modules/contrib/company', 'vendor/company/module', 'web/core'],
    };
    expect(upstreamKind('web/modules/contrib/company/a.php', policy)).toBeNull();
    expect(upstreamKind('vendor/company/module/a.php', policy)).toBeNull();
    expect(upstreamKind('vendor/company/module/vendor/other/module/a.php', policy)).toBe(
      'dependency',
    );
    expect(upstreamKind('web/modules/contrib/company-other/a.php', policy)).toBe('dependency');
    expect(upstreamKind('web/core/lib/a.php', policy)).toBe('infrastructure');
    expect(
      upstreamKind('patches/core/tests/fix.patch', { ...policy, drupalRoots: ['patches'] }),
    ).toBe('infrastructure');
  });

  it('protects Drupal 7 core but preserves custom modules', () => {
    const policy = { drupal: true, drupal7: true, drupalRoots: [''], ownedPaths: [] };
    expect(upstreamKind('modules/system/system.module', policy)).toBe('infrastructure');
    expect(upstreamKind('includes/bootstrap.inc', policy)).toBe('infrastructure');
    expect(upstreamKind('sites/all/modules/foo/foo.module', policy)).toBe('dependency');
    expect(upstreamKind('sites/all/modules/contrib/foo/foo.module', policy)).toBe('dependency');
    expect(upstreamKind('sites/all/modules/custom/foo/foo.module', policy)).toBeNull();
  });

  it('does not mistake an owned non-Drupal web/core directory for Drupal infrastructure', () => {
    expect(
      upstreamKind('web/core/model.ts', {
        drupal: false,
        drupalRoots: ['', 'web'],
        ownedPaths: [],
      }),
    ).toBeNull();
  });

  it.each(['web', 'docroot', 'custom/site'])(
    'detects Drupal 7 core under %s in the working tree and baseline',
    async (webRoot) => {
      const root = await repository();
      await file(
        root,
        'composer.json',
        JSON.stringify({ extra: { 'drupal-scaffold': { locations: { 'web-root': webRoot } } } }),
      );
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-qm', 'non-Drupal manifest']);
      const marker = `${webRoot}/includes/bootstrap.inc`;
      const module = `${webRoot}/modules/system/system.module`;
      await file(root, marker);
      await file(root, module, 'rewritten\n');
      const policy = await loadDependencyPolicy(context(), root);
      expect(policy.drupal7).toBe(true);
      expect(policy.drupal7Roots).toEqual([webRoot]);
      expect(upstreamKind(marker, policy)).toBe('infrastructure');
      expect(upstreamKind(module, policy)).toBe('infrastructure');
      expect(upstreamKind('modules/application/app.php', policy)).toBeNull();
      expect(upstreamKind('includes/project.php', policy)).toBeNull();
      expect(upstreamKind('themes/company/style.css', policy)).toBeNull();
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit',
      );
      await git(root, ['add', '-A']);
      await git(root, ['commit', '-qm', 'Drupal 7 baseline']);
      await file(root, 'modules/application/app.php', 'project change\n');
      await expect(assertDependencyCommitSafe(context(), root)).resolves.toBeUndefined();
      await rm(path.join(root, marker));
      await file(root, module, 'edited again\n');
      expect((await loadDependencyPolicy(context(), root)).drupal7).toBe(true);
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit',
      );
    },
  );

  it('protects every Drupal 7 root and leaves other roots editable', async () => {
    const root = await repository();
    await file(root, 'composer.json', '{}');
    await file(root, 'docroot/includes/bootstrap.inc');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'nested Drupal 7 baseline']);
    await file(root, 'web/includes/bootstrap.inc');
    const policy = await loadDependencyPolicy(context(), root);
    expect(policy.drupal7Roots).toEqual(['web', 'docroot']);
    for (const webRoot of policy.drupal7Roots!) {
      expect(upstreamKind(`${webRoot}/modules/system/system.module`, policy)).toBe(
        'infrastructure',
      );
    }
    expect(upstreamKind('modules/application/app.php', policy)).toBeNull();
    expect(upstreamKind('public/modules/application/app.php', policy)).toBeNull();
  });

  it.each([
    '.',
    '../other/module',
    'web/modules/contrib',
    'vendor/acme',
    'vendor/acme/*',
    'web/modules/contrib/company\nignore rules',
  ])('rejects an ownership declaration that is not an exact package directory: %s', (entry) => {
    expect(() => parseDependencyOwnership(JSON.stringify({ ownedPaths: [entry] }))).toThrow();
  });

  it('does not let an agent declare a third-party module owned in the working tree', async () => {
    const root = await repository();
    await file(
      root,
      OWNERSHIP_POLICY_PATH,
      JSON.stringify({ ownedPaths: ['web/modules/contrib/admin_toolbar'] }),
    );
    expect((await loadDependencyPolicy(context(), root)).ownedPaths).toEqual([]);
    await file(root, 'web/modules/contrib/admin_toolbar/admin_toolbar.module', 'rewritten\n');
    await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
      'Refusing to commit changed upstream source',
    );
  });

  it('allows maintained sources declared on the baseline, including a contrib install path', async () => {
    const root = await repository(['web/modules/contrib/admin_toolbar']);
    await file(root, 'web/modules/contrib/admin_toolbar/admin_toolbar.module', 'owned change\n');
    await expect(assertDependencyCommitSafe(context(), root)).resolves.toBeUndefined();
  });

  it('normalizes absolute findings against the actual sandbox worktree using the longest root', async () => {
    const root = await repository(['web/modules/contrib/admin_toolbar']);
    const sandboxRoot = '/haive/workdir/.haive/worktrees/feature';
    const ctx = { ...context(undefined, sandboxRoot), sandboxWorkdir: '/haive/workdir' };
    const policy = await loadDependencyPolicy(ctx, root);
    expect(policy.workspaceRoots).toContain(sandboxRoot);
    // Deliberately place the containing mount first to verify specificity, not array order.
    policy.workspaceRoots = ['/haive/workdir', sandboxRoot, root];
    expect(upstreamKind(`${sandboxRoot}/web/core/lib/Drupal.php:140:2`, policy)).toBe(
      'infrastructure',
    );
    expect(upstreamKind(`${root}/web/core/lib/Drupal.php`, policy)).toBe('infrastructure');
    expect(
      upstreamKind(`${sandboxRoot}/web/modules/contrib/admin_toolbar/a.php`, policy),
    ).toBeNull();
  });

  it.each(['{ malformed', 'null'])(
    'allows repairing a broken baseline manifest (%s) while protecting the corrected framework',
    async (broken) => {
      const root = await repository();
      await file(root, 'composer.json', broken);
      await git(root, ['add', 'composer.json']);
      await git(root, ['commit', '-qm', 'broken manifest']);
      await file(
        root,
        'composer.json',
        JSON.stringify({
          require: { 'drupal/core-recommended': '^11' },
          extra: { 'drupal-scaffold': { locations: { 'web-root': 'custom/site' } } },
        }),
      );
      const policy = await loadDependencyPolicy(context(), root);
      expect(policy.drupal).toBe(true);
      expect(upstreamKind('custom/site/core/lib/Drupal.php', policy)).toBe('infrastructure');
      await expect(assertDependencyCommitSafe(context(), root)).resolves.toBeUndefined();
      await file(root, 'custom/site/core/lib/Drupal.php', 'rewritten\n');
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit',
      );
    },
  );

  it.each(['{ malformed', 'null'])(
    'keeps baseline framework protection with a broken current manifest (%s)',
    async (broken) => {
      const root = await repository();
      await file(root, 'composer.json', broken);
      await file(root, 'web/core/lib/Framework.php', 'rewritten\n');
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit',
      );
    },
  );

  it.each(['unstaged', 'staged', 'deleted', 'renamed', 'new'])(
    'refuses upstream source at commit time (%s)',
    async (state) => {
      const root = await repository();
      const rel = 'web/modules/contrib/admin_toolbar/admin_toolbar.module';
      if (state === 'deleted') await git(root, ['rm', rel]);
      else if (state === 'renamed') await git(root, ['mv', rel, 'stolen.module']);
      else {
        await file(root, state === 'new' ? 'vendor/acme/pkg/new.php' : rel, 'edited\n');
        if (state === 'staged') await git(root, ['add', rel]);
      }
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit changed upstream source',
      );
    },
  );

  it('allows a patch, package-manager registration and project-owned integration changes', async () => {
    const root = await repository();
    await file(root, 'patches/admin-toolbar.patch', '--- a/file\n+++ b/file\n');
    await file(
      root,
      'composer.json',
      JSON.stringify({
        require: { 'drupal/core-recommended': '^11' },
        extra: {
          patches: {
            'drupal/admin_toolbar': { 'Installation blocker': 'patches/admin-toolbar.patch' },
          },
        },
      }),
    );
    await file(root, 'web/modules/custom/company/company.module', 'project change\n');
    await expect(assertDependencyCommitSafe(context(), root)).resolves.toBeUndefined();
  });

  it.each([
    'patches/vendor/acme/fix.patch',
    'patches/modules/contrib/foo.patch',
    'patches/node_modules/pkg/fix.diff',
  ])('allows project patch artifacts that mirror dependency paths: %s', async (rel) => {
    const root = await repository();
    await file(root, rel, '--- a/file\n+++ b/file\n');
    expect(upstreamKind(rel)).toBeNull();
    await expect(assertDependencyCommitSafe(context(), root)).resolves.toBeUndefined();
  });

  it.each([
    'vendor/acme/pkg/patches/fix.patch',
    'web/modules/contrib/foo/patches/fix.diff',
    'patches/vendor/acme/source.php',
  ])('does not exempt upstream-maintained patches or non-patch source: %s', async (rel) => {
    const root = await repository();
    await file(root, rel, 'rewritten\n');
    expect(upstreamKind(rel)).toBe('dependency');
    await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow('Refusing to commit');
  });

  it.each(['vendor/acme/pkg/a\nb.php', 'web/core/lib/a\tb.php', 'node_modules/pkg/a\u0085b.js'])(
    'refuses upstream paths containing Git-valid control characters: %s',
    async (rel) => {
      const root = await repository();
      await file(root, rel, 'rewritten\n');
      await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow(
        'Refusing to commit',
      );
    },
  );

  it('rejects earlier committed edits and ownership claims, but allows restoring upstream source', async () => {
    const root = await repository();
    await git(root, ['branch', 'task-base']);
    await file(
      root,
      OWNERSHIP_POLICY_PATH,
      JSON.stringify({ ownedPaths: ['web/modules/contrib/admin_toolbar'] }),
    );
    const rel = 'web/modules/contrib/admin_toolbar/admin_toolbar.module';
    await file(root, rel, 'rewritten\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'agent change']);
    await expect(assertDependencyCommitSafe(context('task-base'), root)).rejects.toThrow(
      'Refusing to commit',
    );
    await git(root, ['restore', '--source=task-base', '--', rel]);
    await expect(assertDependencyCommitSafe(context('task-base'), root)).resolves.toBeUndefined();
  });

  it('cannot disable root core protection by changing the working manifest', async () => {
    const root = await repository();
    await file(root, 'composer.json', '{}');
    await file(root, 'core/lib/Framework.php', 'rewritten\n');
    await expect(assertDependencyCommitSafe(context(), root)).rejects.toThrow('Refusing to commit');
  });

  it('rejects a scoped npm namespace as a blanket ownership claim', () => {
    expect(() =>
      parseDependencyOwnership(JSON.stringify({ ownedPaths: ['node_modules/@company'] })),
    ).toThrow();
  });
});
