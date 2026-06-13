import { describe, expect, it } from 'vitest';
import { signRepoGitCredToken, verifyRepoGitCredToken } from '../src/git/token.js';

const SECRET = 'test-secret-key-0123456789';

describe('repo git credential token', () => {
  it('round-trips a valid token and recovers repositoryId + userId', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);
    expect(verifyRepoGitCredToken(token, SECRET)).toEqual({
      repositoryId: 'repo-abc',
      userId: 'user-1',
    });
  });

  it('rejects a token signed with a different secret', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);
    expect(verifyRepoGitCredToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a tampered payload (different repo/user) under the original mac', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET);
    const [, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ repositoryId: 'evil', userId: 'attacker', exp: 99999999999 }),
    ).toString('base64url');
    expect(verifyRepoGitCredToken(`${forged}.${mac}`, SECRET)).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signRepoGitCredToken('repo-abc', 'user-1', SECRET, -1);
    expect(verifyRepoGitCredToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifyRepoGitCredToken('', SECRET)).toBeNull();
    expect(verifyRepoGitCredToken('not-a-token', SECRET)).toBeNull();
    expect(verifyRepoGitCredToken('a.b.c', SECRET)).toBeNull();
  });
});
