import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateFormValues, type FormSchema } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';

// Avoid the master-KEK / secretsService dependency: the credentialed push path
// only needs a {username,secret,host}. A local bare remote ignores the creds,
// so the real `git push` still succeeds while we assert the call happened.
vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: vi.fn(async () => ({ username: 'u', secret: 's', host: 'github.com' })),
}));

import { gate4PushStep } from '../src/step-engine/steps/workflow/11a-gate-4-push.js';
import { getDecryptedCredentials } from '../src/repo/credentials.js';

const exec = promisify(execFile);
const BRANCH = 'feature/test';
const tmpDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

async function mkTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function makeRepo(withOrigin: boolean): Promise<{ dir: string; bare: string | null }> {
  const dir = await mkTmp('gate4-repo-');
  await git(dir, ['init', '-b', BRANCH]);
  await git(dir, ['config', 'user.email', 't@e.st']);
  await git(dir, ['config', 'user.name', 'T']);
  await writeFile(path.join(dir, 'a.txt'), 'hi');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init commit']);
  let bare: string | null = null;
  if (withOrigin) {
    bare = await mkTmp('gate4-bare-');
    await git(bare, ['init', '--bare']);
    await git(dir, ['remote', 'add', 'origin', bare]);
  }
  return { dir, bare };
}

async function bareHasBranch(bare: string): Promise<boolean> {
  try {
    await exec('git', ['--git-dir', bare, 'show-ref', '--verify', `refs/heads/${BRANCH}`]);
    return true;
  } catch {
    return false;
  }
}

function makeCtx(
  workspacePath: string,
  opts: {
    boundCredentialId?: string | null;
    credentials?: Array<{ id: string; label: string; host: string }>;
  } = {},
): { ctx: StepContext; sets: Record<string, unknown>[] } {
  const sets: Record<string, unknown>[] = [];
  const credentials = opts.credentials ?? [{ id: 'cred-1', label: 'GH', host: 'github.com' }];
  const db = {
    query: {
      tasks: { findFirst: async () => ({ repositoryId: 'repo-1' }) },
      repositories: {
        findFirst: async () => ({ credentialsSecretId: opts.boundCredentialId ?? null }),
      },
      repoCredentials: { findMany: async () => credentials },
    },
    // loadPreviousStepOutput(01-worktree-setup) -> no row, so detect falls back
    // to ctx.workspacePath.
    select: () => ({
      from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  const noop = (): void => undefined;
  const ctx = {
    taskId: 'task-1',
    taskStepId: 'ts-1',
    userId: 'user-1',
    repoPath: workspacePath,
    workspacePath,
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    signal: new AbortController().signal,
    emitProgress: async () => undefined,
    throwIfCancelled: noop,
  } as unknown as StepContext;
  return { ctx, sets };
}

function leafFields(schema: FormSchema): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const field of schema.fields) map.set(field.id, field as Record<string, unknown>);
  return map;
}

function applyArgs(detected: unknown, formValues: Record<string, unknown>) {
  return { detected, formValues, iteration: 0, previousIterations: [] } as never;
}

afterEach(async () => {
  vi.clearAllMocks();
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('gate-4 push: detect', () => {
  it('reports origin + branch + commits when a remote exists', async () => {
    const { dir, bare } = await makeRepo(true);
    const { ctx } = makeCtx(dir);
    const detected = await gate4PushStep.detect!(ctx);
    expect(detected.hasGit).toBe(true);
    expect(detected.hasOrigin).toBe(true);
    expect(detected.originUrl).toBe(bare);
    expect(detected.branch).toBe(BRANCH);
    expect(detected.recentCommits).toContain('init commit');
    expect(detected.credentials).toHaveLength(1);
  });

  it('reports no origin for a freshly initialised repo', async () => {
    const { dir } = await makeRepo(false);
    const { ctx } = makeCtx(dir);
    const detected = await gate4PushStep.detect!(ctx);
    expect(detected.hasOrigin).toBe(false);
    expect(detected.originUrl).toBeNull();
  });
});

describe('gate-4 push: form', () => {
  const baseDetected = {
    hasGit: true,
    workspacePath: '/tmp/x',
    branch: BRANCH,
    recentCommits: 'abc init commit',
    repositoryId: 'repo-1',
    credentials: [{ id: 'cred-1', label: 'GH', host: 'github.com' }],
  };

  it('gates the push (checkbox default false) and offers a manual credential option', () => {
    const { ctx } = makeCtx('/tmp/x');
    const schema = gate4PushStep.form!(ctx, {
      ...baseDetected,
      hasOrigin: true,
      originUrl: 'https://github.com/o/r.git',
      boundCredentialId: null,
    }) as FormSchema;
    const fields = leafFields(schema);
    expect((fields.get('push') as { default: boolean }).default).toBe(false);
    const cred = fields.get('credentialId') as { options: { value: string }[]; default: string };
    expect(cred.options.map((o) => o.value)).toContain('cred-1');
    expect(cred.options.map((o) => o.value)).toContain(''); // manual
    expect(cred.default).toBe(''); // no bound credential -> manual
    expect(fields.has('setUpstream')).toBe(true);
    expect(fields.has('remoteUrl')).toBe(false);
  });

  it('defaults the credential to the repo-bound one when present', () => {
    const { ctx } = makeCtx('/tmp/x');
    const schema = gate4PushStep.form!(ctx, {
      ...baseDetected,
      hasOrigin: true,
      originUrl: 'https://github.com/o/r.git',
      boundCredentialId: 'cred-1',
    }) as FormSchema;
    expect((leafFields(schema).get('credentialId') as { default: string }).default).toBe('cred-1');
  });

  it('asks for a remote URL when there is no origin', () => {
    const { ctx } = makeCtx('/tmp/x');
    const schema = gate4PushStep.form!(ctx, {
      ...baseDetected,
      hasOrigin: false,
      originUrl: null,
      boundCredentialId: null,
    }) as FormSchema;
    const fields = leafFields(schema);
    const url = fields.get('remoteUrl') as { required: boolean };
    expect(url).toBeDefined();
    expect(url.required).toBe(true);
    expect((fields.get('push') as { default: boolean }).default).toBe(false);
  });
});

describe('gate-4 push: smoke canned value satisfies the form', () => {
  // The workflow smokes submit this for 11a-gate-4-push. The step runner
  // validates form values against the form schema before apply, so the canned
  // value must pass whichever variant detect produces. Guards the smokes
  // against future form changes.
  const SMOKE_VALUE = {
    push: false,
    remoteUrl: 'https://smoke.invalid/repo.git',
    credentialId: '',
  };
  const detectedBase = {
    hasGit: true,
    workspacePath: '/tmp/x',
    branch: BRANCH,
    recentCommits: 'abc init',
    repositoryId: 'repo-1',
    boundCredentialId: null,
    credentials: [],
  };

  it('validates against the no-origin form', () => {
    const { ctx } = makeCtx('/tmp/x');
    const schema = gate4PushStep.form!(ctx, {
      ...detectedBase,
      hasOrigin: false,
      originUrl: null,
    }) as FormSchema;
    expect(validateFormValues(schema, SMOKE_VALUE).success).toBe(true);
  });

  it('validates against the has-origin form', () => {
    const { ctx } = makeCtx('/tmp/x');
    const schema = gate4PushStep.form!(ctx, {
      ...detectedBase,
      hasOrigin: true,
      originUrl: 'https://github.com/o/r.git',
    }) as FormSchema;
    expect(validateFormValues(schema, SMOKE_VALUE).success).toBe(true);
  });
});

describe('gate-4 push: apply', () => {
  it('pushes nothing when the gate is not confirmed', async () => {
    const { dir, bare } = await makeRepo(true);
    const { ctx, sets } = makeCtx(dir);
    const detected = await gate4PushStep.detect!(ctx);
    const out = await gate4PushStep.apply(ctx, applyArgs(detected, { push: false }));
    expect(out.pushed).toBe(false);
    expect(await bareHasBranch(bare!)).toBe(false);
    expect(sets).toHaveLength(0);
  });

  it('adds origin, persists it, and pushes when none existed', async () => {
    const { dir } = await makeRepo(false);
    const bare = await mkTmp('gate4-bare-');
    await git(bare, ['init', '--bare']);
    const { ctx, sets } = makeCtx(dir);
    const detected = await gate4PushStep.detect!(ctx);
    const out = await gate4PushStep.apply(
      ctx,
      applyArgs(detected, { push: true, remoteUrl: bare, credentialId: '' }),
    );
    expect(out.pushed).toBe(true);
    expect(out.branch).toBe(BRANCH);
    expect(await bareHasBranch(bare)).toBe(true);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.remoteUrl).toBe(bare);
  });

  it('pushes to an existing origin using the chosen credential', async () => {
    const { dir, bare } = await makeRepo(true);
    const { ctx, sets } = makeCtx(dir, { boundCredentialId: 'cred-1' });
    const detected = await gate4PushStep.detect!(ctx);
    const out = await gate4PushStep.apply(
      ctx,
      applyArgs(detected, { push: true, credentialId: 'cred-1', setUpstream: true }),
    );
    expect(out.pushed).toBe(true);
    expect(vi.mocked(getDecryptedCredentials)).toHaveBeenCalledWith(
      expect.anything(),
      'cred-1',
      'user-1',
    );
    expect(await bareHasBranch(bare!)).toBe(true);
    expect(sets).toHaveLength(0); // existing origin -> no repo-row write
  });
});
