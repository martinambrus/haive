import { describe, expect, it } from 'vitest';
import { hardenGitArgs } from '../src/git-args.js';

const NEVER = 'protocol.file.allow=never';
const ARGVS: readonly (readonly string[])[] = [
  ['fetch'],
  ['pull'],
  ['push'],
  ['ls-remote'],
  ['remote', 'update'],
  ['remote', '--verbose', 'update'],
  ['clone', 'https://example.test/r', 'dest'],
  ['fetch', 'upstream'],
  ['-C', '/repo', 'fetch'],
  ['remote', 'show', 'origin'],
  ['remote', 'prune', 'origin'],
  ['remote', 'set-head', 'origin', '-a'],
  ['remote', 'add', '-f', 'up', '/p'],
  ['submodule', 'update', '--init'],
  ['submodule', 'add', '/p', 'sub'],
  ['archive', '--remote=/p', 'HEAD'],
  ['cat-file', '-p', 'abc'],
  ['status'],
  ['remote', 'get-url', 'origin'],
  ['config', '--get', 'fetch'],
  ['-C', '/repo', 'log', '-1'],
  ['--version'],
];
const ROWS = ARGVS.map((args) => [args.join(' '), args] as const);

describe('the file transport is refused unless the caller opts in', () => {
  it.each(ROWS)('refuses it: git %s', (_name, args) => {
    const argv = hardenGitArgs(args);
    const at = argv.indexOf(NEVER);
    expect(at).toBeGreaterThan(0);
    expect(argv[at - 1]).toBe('-c');
  });

  it.each(ROWS)('does not add it for a caller who opts in: git %s', (_name, args) => {
    const argv = hardenGitArgs(args, { allowFileTransport: true });
    expect(argv).not.toContain(NEVER);
    expect(argv).toContain('core.hooksPath=/dev/null');
  });

  it.each([{}, { allowFileTransport: true }])(
    'puts the pack command right after the subcommand with %j',
    (options) => {
      for (const args of [['fetch'], ['-C', '/repo', 'fetch']]) {
        const argv = hardenGitArgs(args, options);
        expect(argv[argv.indexOf('fetch') + 1]).toBe('--upload-pack=git-upload-pack');
      }
    },
  );
});

it('keeps the explicit host-folder transport available through an opt-in', () => {
  const argv = ['fetch', '--', '/host/repository', 'refs/heads/main'];
  expect(hardenGitArgs(argv)).toContain('protocol.file.allow=never');
  expect(hardenGitArgs(argv, { allowFileTransport: true })).not.toContain(
    'protocol.file.allow=never',
  );
});
