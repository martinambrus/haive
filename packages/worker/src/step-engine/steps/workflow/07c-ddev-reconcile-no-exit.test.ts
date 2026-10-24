import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const m = vi.hoisted(() => ({
  resolveDdevWorkspace: vi.fn(),
  loadPreviousStepOutput: vi.fn(),
}));

vi.mock('./_app-runtime.js', () => ({
  ensureDdevWithProgress: vi.fn(),
  withDdevProgress: (_ctx: unknown, _label: string, run: (onLine: () => void) => unknown) =>
    run(() => {}),
}));
vi.mock('./_task-meta.js', () => ({ resolveDdevWorkspace: m.resolveDdevWorkspace }));
vi.mock('../onboarding/_helpers.js', () => ({ loadPreviousStepOutput: m.loadPreviousStepOutput }));

import { killGit } from '../../../../test/support/kill-git.js';
import { hashDdevInputs } from '../_ddev-inputs-hash.js';
import { ddevReconcileStep } from './07c-ddev-reconcile.js';

const dirs: string[] = [];
let restore: (() => Promise<void>) | null = null;

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ddev-rec-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'gc.auto', '0');
  await mkdir(path.join(dir, '.ddev', 'php'), { recursive: true });
  await writeFile(path.join(dir, '.ddev', 'config.yaml'), 'php_version: "8.3"\n');
  git('add', '.ddev/config.yaml');
  await writeFile(path.join(dir, '.ddev', 'php', 'extra.ini'), 'memory_limit=1G\n');
  return dir;
}

async function setup(repo: string) {
  const baseline = {
    phpVersion: '8.3',
    dbType: null,
    dbVersion: null,
    configHash: await hashDdevInputs(repo),
  };
  m.resolveDdevWorkspace.mockResolvedValue({ workspace: repo, repoSubpath: 'x' });
  m.loadPreviousStepOutput.mockResolvedValue({ output: { started: true, baseline } });
  const chain: Record<string, unknown> = {};
  for (const k of ['select', 'from', 'where', 'orderBy']) chain[k] = () => chain;
  chain.limit = async () => [];
  const warn = vi.fn();
  const ctx = {
    taskId: 't',
    repoPath: repo,
    db: chain,
    logger: { warn, info: vi.fn(), error: vi.fn() },
  } as never;
  return { ctx, warn };
}

afterEach(async () => {
  await restore?.();
  restore = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('07c-ddev-reconcile when the .ddev/ listing gave no answer', () => {
  it('leaves DDEV as booted and warns', async () => {
    const repo = await makeRepo();
    const { ctx, warn } = await setup(repo);
    restore = (await killGit(['ls-files'])).restore;
    expect(await ddevReconcileStep.shouldRun!(ctx)).toBe(false);
    expect((await ddevReconcileStep.detect!(ctx)).driftKind).toBe('none');
    expect(warn).toHaveBeenCalled();
  });

  it('apply says the inputs could not be hashed, not that they are unchanged', async () => {
    const repo = await makeRepo();
    const { ctx } = await setup(repo);
    restore = (await killGit(['ls-files'])).restore;
    const detected = await ddevReconcileStep.detect!(ctx);
    const out = await ddevReconcileStep.apply(ctx, { detected, formValues: {} } as never);
    expect(out).toMatchObject({ action: 'none', reconciled: false });
    expect(out.output).toMatch(/could not be hashed/);
  });

  it('an unchanged healthy tree does not run', async () => {
    const repo = await makeRepo();
    const { ctx } = await setup(repo);
    expect(await ddevReconcileStep.shouldRun!(ctx)).toBe(false);
  });

  it('an edited input still reads as a restart', async () => {
    const repo = await makeRepo();
    const { ctx } = await setup(repo);
    await writeFile(path.join(repo, '.ddev', 'php', 'extra.ini'), 'memory_limit=2G\n');
    expect((await ddevReconcileStep.detect!(ctx)).driftKind).toBe('restart');
  });
});
