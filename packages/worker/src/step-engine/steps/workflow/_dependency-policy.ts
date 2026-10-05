import path from 'node:path';
import { readTextNoFollow, lstatNoFollow } from '@haive/shared/fs-safe';
import { gitRun } from '../../../repo/git-exec.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { parsePorcelainZ } from './_commit-diff.js';

/** Unknown ownership is report-only just like upstream source; it never means owned. */
export type UpstreamKind = 'infrastructure' | 'dependency' | 'unknown';
export interface DependencyPolicy {
  baselineRef?: string;
  workspaceRoots?: string[];
  drupal: boolean;
  drupal7?: boolean;
  drupal7Roots?: string[];
  drupalRoots: string[];
  ownedPaths: string[];
}

export const OWNERSHIP_POLICY_PATH = '.haive-data/dependency-ownership.json';
const DEFAULT_ROOTS = ['', 'web', 'docroot', 'public', 'html'];

function relativePath(value: string, allowGitControls = false): string | null {
  const raw = value.replace(/:\d+(?::\d+)?$/, '').replaceAll('\\', '/');
  // Git accepts tabs and newlines in filenames. Refusing a policy declaration is safe;
  // refusing to classify such a changed path would let upstream source through the guard.
  if (!allowGitControls && /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(raw)) return null;
  if (path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../'))
    return null;
  return normalized;
}

export function parseDependencyOwnership(raw: string | null): string[] {
  if (raw === null) return [];
  const data = JSON.parse(raw) as { ownedPaths?: unknown };
  if (!data || !Array.isArray(data.ownedPaths)) {
    throw new Error(`${OWNERSHIP_POLICY_PATH} must contain an ownedPaths array.`);
  }
  return data.ownedPaths.map((entry: unknown) => {
    const rel = typeof entry === 'string' ? relativePath(entry) : null;
    if (!rel || entry !== rel || !rel.includes('/')) {
      throw new Error(`Ownership entries must name exact package directories, not roots or globs.`);
    }
    if (/[?*{}[\]]/.test(rel)) throw new Error('Ownership entries cannot contain globs.');
    if (
      /(^|\/)(vendor|node_modules|contrib)$/.test(rel) ||
      /(^|\/)vendor\/[^/]+$/.test(rel) ||
      /(^|\/)node_modules\/@[^/]+$/.test(rel)
    )
      throw new Error(
        'Ownership entries must name individual packages, not dependency containers.',
      );
    return rel;
  });
}

export function upstreamKind(
  file: string | undefined,
  policy?: DependencyPolicy,
): UpstreamKind | null {
  if (!file?.trim()) return 'unknown';
  // Reviewers sometimes supply an absolute sandbox path instead of a repository-relative one.
  const workspaceRoot = policy?.workspaceRoots
    ?.filter((root) => file.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
  const rel = relativePath(
    workspaceRoot ? file.slice(workspaceRoot.length + 1) : file.replace(/^\/haive\/workdir\//, ''),
    true,
  );
  if (!rel || /^[a-z]:\//i.test(rel)) return 'unknown';
  const roots = policy?.drupalRoots ?? DEFAULT_ROOTS;
  for (const root of roots) {
    const prefix = root ? `${root}/` : '';
    if (
      (policy ? policy.drupal : root !== '') &&
      (rel === `${prefix}core` || rel.startsWith(`${prefix}core/`))
    )
      return 'infrastructure';
    if (
      (policy?.drupal7Roots ?? (policy?.drupal7 ? roots : [])).includes(root) &&
      /^(includes|modules|profiles|themes|misc)(\/|$)/.test(rel.slice(prefix.length)) &&
      rel.startsWith(prefix)
    ) {
      // Drupal 7's core modules live directly under modules; project extensions live in sites/.
      if (!/^(modules|themes|profiles)\/(contrib|custom)(\/|$)/.test(rel.slice(prefix.length)))
        return 'infrastructure';
    }
  }
  if (/(^|\/)vendor\/drupal\/core(?:\/|$)/.test(rel)) return 'infrastructure';
  // Project patch artifacts can mirror package paths without being installed source.
  // Restrict the exemption to the project's patch directory, never a package's own patches
  // or framework core under a configured web root that happens to be named patches.
  if (rel.startsWith('patches/') && /\.(patch|diff)$/.test(rel)) return null;
  const installed =
    /(^|\/)(vendor|node_modules)(\/|$)/.test(rel) ||
    /(^|\/)(modules|themes|profiles)\/contrib(?:\/|$)/.test(rel) ||
    /(^|\/)sites\/[^/]+\/(modules|themes)\/(?!custom(?:\/|$))/.test(rel);
  if (!installed) return null;
  if (
    policy?.ownedPaths.some((owned) => {
      if (rel === owned) return true;
      if (!rel.startsWith(`${owned}/`)) return false;
      // Owning a package does not establish ownership of its installed dependencies.
      return !/(^|\/)(vendor|node_modules|contrib)(\/|$)/.test(rel.slice(owned.length + 1));
    })
  )
    return null;
  return 'dependency';
}

/** Only host-assigned upstream metadata is accepted; reviewer schemas discard this field. */
export function findingUpstream(f: {
  path?: string;
  file?: string;
  upstream?: UpstreamKind | null;
}): UpstreamKind | null {
  if (!(f.path ?? f.file)?.trim()) return 'unknown';
  return f.upstream === undefined ? upstreamKind(f.path ?? f.file) : f.upstream;
}

/** Ownership is read from the task's fork point, never from an agent's edited working copy. */
export async function loadDependencyPolicy(
  ctx: StepContext,
  workspace: string,
): Promise<DependencyPolicy> {
  const previous = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const worktree = previous?.output as {
    baseBranch?: string;
    sandboxWorktreePath?: string;
  } | null;
  const baseBranch = worktree?.baseBranch;
  const base = baseBranch
    ? await gitRun(workspace, ['merge-base', 'HEAD', baseBranch])
    : await gitRun(workspace, ['rev-parse', '--verify', 'HEAD']);
  if (base.code !== 0) {
    throw new Error('Cannot establish the repository baseline for dependency ownership.');
  }
  const ownership = await gitRun(workspace, [
    'show',
    `${base.stdout.trim()}:${OWNERSHIP_POLICY_PATH}`,
  ]);
  const baselineComposer = await gitRun(workspace, ['show', `${base.stdout.trim()}:composer.json`]);
  const { anchor, prefix } = workspaceAnchor(workspace);
  const composer = await readTextNoFollow(anchor, `${prefix}composer.json`);
  let drupal = false;
  const roots = [...DEFAULT_ROOTS];
  // Removing the framework from the working manifest cannot remove its protection.
  for (const raw of [baselineComposer.code === 0 ? baselineComposer.stdout : null, composer]) {
    if (!raw) continue;
    let manifest: {
      type?: string;
      require?: Record<string, unknown>;
      extra?: { 'drupal-scaffold'?: { locations?: { 'web-root'?: string } } };
    };
    try {
      manifest = JSON.parse(raw) as typeof manifest;
    } catch {
      // A task may be repairing a broken manifest. The other copy can still establish
      // framework protection, so parse baseline and current evidence independently.
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    drupal ||=
      !['drupal-module', 'drupal-theme', 'drupal-profile'].includes(manifest.type ?? '') &&
      Object.keys(manifest.require ?? {}).some((name) => name.startsWith('drupal/core'));
    const root = manifest.extra?.['drupal-scaffold']?.locations?.['web-root'];
    if (typeof root === 'string') {
      const rel = relativePath(root);
      if (rel) roots.push(rel);
    }
  }
  const drupal7Roots: string[] = [];
  for (const root of new Set(roots)) {
    const marker = `${root ? `${root}/` : ''}includes/bootstrap.inc`;
    const baselineDrupal7 = await gitRun(workspace, [
      'cat-file',
      '-e',
      `${base.stdout.trim()}:${marker}`,
    ]);
    if (
      baselineDrupal7.code === 0 ||
      (await lstatNoFollow(anchor, `${prefix}${marker}`)) !== null
    ) {
      drupal7Roots.push(root);
    }
  }
  const drupal7 = drupal7Roots.length > 0;
  drupal ||= drupal7;
  return {
    baselineRef: base.stdout.trim(),
    workspaceRoots: [workspace, worktree?.sandboxWorktreePath, ctx.sandboxWorkdir]
      .filter((root): root is string => !!root)
      .map((root) => root.replace(/\/$/, '')),
    drupal,
    drupal7,
    drupal7Roots,
    drupalRoots: [...new Set(roots)],
    ownedPaths: parseDependencyOwnership(ownership.code === 0 ? ownership.stdout : null),
  };
}

/** Rehydrate pre-policy detect output before deciding which findings can cause edits. */
export async function loadReviewDependencyPolicy(
  ctx: StepContext,
  detected: { dependencyPolicy?: DependencyPolicy; worktreePath?: string },
): Promise<DependencyPolicy> {
  if (detected.dependencyPolicy) return detected.dependencyPolicy;
  const previous = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
  const worktree = previous?.output as { worktreePath?: string } | null;
  const workspace = detected.worktreePath ?? worktree?.worktreePath;
  if (!workspace)
    throw new Error('Cannot establish the workspace for review dependency ownership.');
  return loadDependencyPolicy(ctx, workspace);
}

/** No changed upstream source may enter either a workflow or DAG issue commit. */
export async function assertDependencyCommitSafe(
  ctx: StepContext,
  workspace: string,
): Promise<void> {
  const policy = await loadDependencyPolicy(ctx, workspace);
  const status = await gitRun(workspace, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    '-uall',
  ]);
  if (status.code !== 0) throw new Error(`Cannot check dependency changes: ${status.stderr}`);
  // Compare the final tracked tree with the fork point, including previous issue commits.
  // Restoring an accidentally committed upstream file to its baseline is permitted.
  const changes = await gitRun(workspace, [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    policy.baselineRef!,
    '--',
  ]);
  if (changes.code !== 0)
    throw new Error(`Cannot check dependency changes against the baseline: ${changes.stderr}`);
  const denied = [
    ...parsePorcelainZ(status.stdout)
      .filter((entry) => entry.x === '?')
      .map((entry) => entry.path),
    ...changes.stdout.split('\0'),
  ].filter((file): file is string => !!file && upstreamKind(file, policy) !== null);
  if (denied.length > 0) {
    throw new Error(
      `Refusing to commit changed upstream source: ${[...new Set(denied)].join(', ')}. ` +
        'Report infrastructure defects to the user. For a reproduced third-party module blocker, ' +
        'commit a package-manager-applied patch and restore the upstream source before committing. ' +
        `Declare genuinely project-owned packages in ${OWNERSHIP_POLICY_PATH} on the base branch.`,
    );
  }
}
