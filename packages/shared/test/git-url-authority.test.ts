import { expect, it } from 'vitest';
import {
  credentialFitsGitRemote,
  gitCredentialTarget,
  gitRemoteUrlSchema,
  isAllowedGitRemoteUrl,
} from '../src/schemas/git-url.js';

it.each([
  'http://public.test\\@127.0.0.1:1/r.git',
  'https://git\thub.com/r.git',
  'https://git\nhub.com/r.git',
  'https://git\rhub.com/r.git',
  'https://github.com\u007f/r.git',
  'https://user name@github.com/r.git',
  'https://%67ithub.com/r.git',
  'http://127.1/r.git',
  'ssh://git\\@public.test/r.git',
])('refuses raw authorities that disagree with transport parsing: case %#', (remote) => {
  expect(isAllowedGitRemoteUrl(remote)).toBe(false);
  expect(gitRemoteUrlSchema.safeParse(remote).success).toBe(false);
  expect(gitCredentialTarget(remote)).toBeNull();
});

it('does not bind credentials through an ambiguous authority', () => {
  expect(
    credentialFitsGitRemote({ host: 'github.com' }, 'https://github.com\\@evil.example/x'),
  ).toBe(false);
});

it.each([
  'https://USER:password@GitHub.COM:443/a=b/r.git',
  'ssh://git@EXAMPLE.test:2222/r.git',
  'https://[2606:4700:4700::1111]:443/r.git',
])('keeps ordinary authority spelling valid: %s', (remote) => {
  expect(isAllowedGitRemoteUrl(remote)).toBe(true);
  expect(gitRemoteUrlSchema.safeParse(remote).success).toBe(true);
});

it.each([
  '\x01http://h/r',
  ' http://h/r',
  'http://h/r with-space',
  'http://h/r\tpath',
  'http://h/r\x7f',
  'git@h.test:r with-space',
  'https://h/r\u00a0path',
])('refuses controls or whitespace anywhere in a remote: case %#', (remote) => {
  expect(isAllowedGitRemoteUrl(remote)).toBe(false);
});
