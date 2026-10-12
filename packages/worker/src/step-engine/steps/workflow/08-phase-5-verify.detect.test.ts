import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const { loadPreviousStepOutput, resolveDdevWorkspace, loadDeclaredVerifyCommands } = vi.hoisted(
  () => ({
    loadPreviousStepOutput: vi.fn(),
    resolveDdevWorkspace: vi.fn(),
    loadDeclaredVerifyCommands: vi.fn(),
  }),
);

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace,
  loadDeclaredVerifyCommands,
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
    loadDeclaredVerifyCommands.mockReset().mockResolvedValue(null);
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

  // The Drupal recommended-project shape: the only tooling is core's, and it targets core.
  it('declines a sailorix-shaped core/ and lists it, running nothing', async () => {
    await put('.eslintrc.json', '{"extends":"./core/.eslintrc.json"}');
    await put('composer.json', JSON.stringify({ require: {} }));
    await mkdir(path.join(workspace, 'core'));
    await put('core/package.json', JSON.stringify({ scripts: { 'lint:core-js': 'eslint .' } }));
    await put('core/phpcs.xml.dist', '<ruleset/>');
    await put('core/phpstan.neon.dist', '');
    await put('core/phpunit.xml.dist', '<phpunit/>');
    await mkdir(path.join(workspace, 'core/lib'));
    await put('core/lib/Drupal.php', '<?php');

    const out = await detect();

    expect([out.test, out.lint, out.typecheck]).toEqual([null, null, null]);
    expect(JSON.stringify([out.test, out.lint, out.typecheck, out.phpLint])).not.toContain('core');
    expect(out.declinedConfigs).toEqual([
      'core/package.json (Drupal core)',
      'core/phpcs.xml.dist (Drupal core)',
      'core/phpstan.neon.dist (Drupal core)',
      'core/phpunit.xml.dist (Drupal core)',
    ]);
  });

  it('labels each declined directory by what it is', async () => {
    for (const d of ['vendor', 'contrib', 'app']) await mkdir(path.join(workspace, d));
    await put('vendor/phpunit.xml', '<phpunit/>');
    await put('contrib/phpcs.xml', '<ruleset/>');
    await put('app/composer.json', JSON.stringify({ scripts: { test: 'phpunit' } }));
    await put('app/jest.config.js', '');

    const out = await detect();

    expect(out.declinedConfigs).toEqual([
      'app/composer.json (below the repository root)',
      'app/jest.config.js (below the repository root)',
      "contrib/phpcs.xml (not the project's)",
      'vendor/phpunit.xml (vendor)',
    ]);
  });

  it('labels a core/ without Drupal core as below the root, and declines every root config name', async () => {
    for (const d of ['core', 'py']) await mkdir(path.join(workspace, d));
    await put('core/phpunit.xml', '<phpunit/>');
    await put('py/pytest.ini', '');
    await put('py/.phpcs.xml', '<ruleset/>');
    await put('py/phpstan.dist.neon', '');

    expect((await detect()).declinedConfigs).toEqual([
      'core/phpunit.xml (below the repository root)',
      'py/.phpcs.xml (below the repository root)',
      'py/phpstan.dist.neon (below the repository root)',
      'py/pytest.ini (below the repository root)',
    ]);
  });

  it('declines nothing for a manifest without scripts, and omits the key', async () => {
    await mkdir(path.join(workspace, 'sub'));
    await put('sub/package.json', JSON.stringify({ name: 'x' }));
    await put('package.json', JSON.stringify({ scripts: { lint: 'eslint .' } }));

    const out = await detect();

    expect(out.lint?.argv).toEqual(['npm', 'run', 'lint']);
    expect('declinedConfigs' in out).toBe(false);
  });

  it('omits declinedConfigs when the repository has no deeper tooling', async () => {
    await put('phpcs.xml', '<ruleset/>');

    expect('declinedConfigs' in (await detect())).toBe(false);
  });
});
