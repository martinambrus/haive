import { expect, it } from 'vitest';
import { hardenGitArgs } from '../src/git-args.js';
it.each([
  ['fetch'],
  ['pull'],
  ['push'],
  ['ls-remote'],
  ['remote', 'update'],
  ['remote', '--verbose', 'update'],
  ['clone', 'https://example.test/r', 'dest'],
  ['fetch', 'upstream'],
  ['-C', '/repo', 'fetch'],
])('refuses file transport by verb: %j', (...args) => {
  expect(hardenGitArgs(args)).toContain('protocol.file.allow=never');
});
it.each([['status'], ['remote', 'get-url', 'origin'], ['config', '--get', 'fetch']])(
  'leaves non-transport commands alone: %j',
  (...args) => {
    expect(hardenGitArgs(args)).not.toContain('protocol.file.allow=never');
  },
);

it('keeps the explicit host-folder transport available through an opt-in', () => {
  const argv = ['fetch', '--', '/host/repository', 'refs/heads/main'];
  expect(hardenGitArgs(argv)).toContain('protocol.file.allow=never');
  expect(hardenGitArgs(argv, { allowFileTransport: true })).not.toContain(
    'protocol.file.allow=never',
  );
});
