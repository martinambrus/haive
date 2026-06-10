import { describe, it, expect } from 'vitest';
import { buildVerifyCommand } from './08-phase-5-verify.js';

describe('buildVerifyCommand', () => {
  it('builds host pm-script commands (JS, always host)', () => {
    expect(buildVerifyCommand({ runner: 'pm', pm: 'pnpm', script: 'test' }, false)).toEqual({
      kind: 'host',
      label: 'pnpm run test',
      argv: ['pnpm', 'run', 'test'],
    });
    // ddevMode does not move JS scripts into ddev
    expect(buildVerifyCommand({ runner: 'pm', pm: 'npm', script: 'lint' }, true)?.kind).toBe(
      'host',
    );
  });

  it('returns null for pm runner without a package manager or script', () => {
    expect(buildVerifyCommand({ runner: 'pm', pm: 'none', script: 'test' }, false)).toBeNull();
    expect(buildVerifyCommand({ runner: 'pm', pm: 'pnpm' }, false)).toBeNull();
  });

  it('routes composer scripts through ddev when ddevMode, else host', () => {
    expect(buildVerifyCommand({ runner: 'composer', script: 'phpcs' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev composer phpcs',
      argv: ['composer', 'phpcs'],
    });
    expect(buildVerifyCommand({ runner: 'composer', script: 'test' }, false)).toEqual({
      kind: 'host',
      label: 'composer test',
      argv: ['composer', 'test'],
    });
  });

  it('builds phpunit / phpcs / phpstan / pytest binaries, ddev vs host', () => {
    expect(buildVerifyCommand({ runner: 'phpunit' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev exec vendor/bin/phpunit',
      argv: ['exec', 'vendor/bin/phpunit'],
    });
    expect(buildVerifyCommand({ runner: 'phpcs' }, false)).toEqual({
      kind: 'host',
      label: 'vendor/bin/phpcs',
      argv: ['vendor/bin/phpcs'],
    });
    expect(buildVerifyCommand({ runner: 'phpstan' }, true)).toEqual({
      kind: 'ddev',
      label: 'ddev exec vendor/bin/phpstan analyse',
      argv: ['exec', 'vendor/bin/phpstan', 'analyse'],
    });
    expect(buildVerifyCommand({ runner: 'pytest' }, false)).toEqual({
      kind: 'host',
      label: 'pytest',
      argv: ['pytest'],
    });
  });
});
