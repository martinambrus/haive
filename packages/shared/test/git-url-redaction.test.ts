import { expect, it } from 'vitest';
import { gitRemoteUrlSchema, redactGitText, redactGitUrl } from '../src/schemas/git-url.js';

it.each([
  'https://fixture-user:fixture-password@example.test/repo.git',
  'https://fixture-user@example.test/repo.git',
])('redacts URL userinfo from display and saved remotes', (url) => {
  expect(redactGitUrl(url)).toBe('https://example.test/repo.git');
  expect(gitRemoteUrlSchema.parse(url)).toBe('https://example.test/repo.git');
});
it('keeps a usable SSH login for transport while redacting it from display', () => {
  const url = 'ssh://git:fixture-password@example.test:2222/repo.git';
  expect(gitRemoteUrlSchema.parse(url)).toBe('ssh://git@example.test:2222/repo.git');
  expect(redactGitUrl(url)).toBe('ssh://example.test:2222/repo.git');
  expect(gitRemoteUrlSchema.parse('git@example.test:repo.git')).toBe('git@example.test:repo.git');
});
it('redacts every URL in command errors with the same helper', () => {
  const message =
    'failed https://u:fixture-password@example.test/r and http://u:fixture-password@other.test/r';
  expect(redactGitText(message).includes('fixture-password')).toBe(false);
  expect(redactGitText(message)).toContain('https://example.test/r');
});
