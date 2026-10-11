import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { loadPreviousStepOutput, resolveDdevWorkspace } = vi.hoisted(() => ({
  loadPreviousStepOutput: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
}));

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace,
}));

import { phase5VerifyStep } from './08-phase-5-verify.js';

describe('phase5VerifyStep.detect lint runners', () => {
  let workspace = '';
  const put = (name: string, body: string) => writeFile(path.join(workspace, name), body);
  const detect = () =>
    phase5VerifyStep.detect!({
      db: {},
      taskId: 'task-1',
      workspacePath: workspace,
      repoPath: workspace,
    } as never);

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'verify-detect-'));
    loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    resolveDdevWorkspace.mockReset().mockResolvedValue(null);
  });
  afterEach(() => rm(workspace, { recursive: true, force: true }));

  it('adds the phpcs runner beside a root JS lint script', async () => {
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await put('phpcs.xml', '<ruleset/>');

    const out = await detect();

    expect(out.lint?.argv).toEqual(['npm', 'run', 'lint']);
    expect(out.phpLint?.argv).toEqual(['vendor/bin/phpcs']);
  });

  it('prefers a composer script over a phpcs config for the added runner', async () => {
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await put('composer.json', JSON.stringify({ scripts: { phpcs: 'phpcs src' } }));
    await put('phpcs.xml', '<ruleset/>');

    const out = await detect();

    expect(out.lint?.argv).toEqual(['npm', 'run', 'lint']);
    expect(out.phpLint?.argv).toEqual(['composer', 'phpcs']);
  });

  it('leaves a repo with phpcs alone with one lint runner and no phpLint key', async () => {
    await put('phpcs.xml', '<ruleset/>');

    const out = await detect();

    expect(out.lint?.argv).toEqual(['vendor/bin/phpcs']);
    expect('phpLint' in out).toBe(false);
  });

  it('leaves a repo with a JS lint script alone with one lint runner and no phpLint key', async () => {
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));

    const out = await detect();

    expect(out.lint?.argv).toEqual(['npm', 'run', 'lint']);
    expect('phpLint' in out).toBe(false);
  });

  it('sets no phpLint when a JS lint script has no PHP runner beside it', async () => {
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));
    await put('composer.json', JSON.stringify({ scripts: { test: 'phpunit' } }));

    const out = await detect();

    expect(out.phpLint ?? null).toBeNull();
  });
});
