import { expect, it } from 'vitest';
import { credentialFitsGitRemote, gitCredentialTarget } from '../src/schemas/git-url.js';

it.each([
  ['example.test', 'https://example.test/a', true],
  ['EXAMPLE.TEST', 'https://example.test/a', true],
  ['example.test', 'https://other.test/a', false],
  ['example.test:8443', 'https://example.test/a', false],
  ['example.test', 'https://example.test:8443/a', false],
  ['example.test:8443', 'https://example.test:8443/a', true],
  ['example.test', 'http://example.test/a', true],
  ['example.test', 'https://example.test:443/a', true],
  ['example.test', 'http://example.test:443/a', false],
  ['example.test:8443', 'ssh://git@example.test:2222/a', true],
  ['example.test', 'git@example.test:a', true],
  ['example.test', 'file:///example.test/a', false],
  ['example.test', null, false],
  ['user@example.test', 'https://example.test/a', false],
  ['example.test/path', 'https://example.test/a', false],
])('host %s fits remote %s: %s', (host, remote, fits) => {
  expect(credentialFitsGitRemote({ host }, remote)).toBe(fits);
});
it('pins the HTTP protocol and port and never serves an SSH challenge', () => {
  expect(gitCredentialTarget('http://example.test:8080/a')).toEqual({
    protocol: 'http',
    host: 'example.test:8080',
  });
  expect(gitCredentialTarget('https://example.test/a')).toEqual({
    protocol: 'https',
    host: 'example.test',
  });
  expect(gitCredentialTarget('ssh://git@example.test/a')).toBeNull();
});
