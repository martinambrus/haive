import { describe, expect, it } from 'vitest';
import { credentialForgeProvider, inferForgeProviderFromHost } from '../src/forge/index.js';

describe('inferForgeProviderFromHost', () => {
  it.each([
    ['github.com', 'github'],
    ['gitlab.com', 'gitlab'],
    ['codeberg.org', 'gitea'],
    ['bitbucket.org', 'bitbucket_cloud'],
  ])('%s runs %s', (host, forge) => {
    expect(inferForgeProviderFromHost(host)).toBe(forge);
  });

  it('cannot tell the forge of a self-hosted or unknown host', () => {
    expect(inferForgeProviderFromHost('git.self-hosted.example')).toBeNull();
    expect(inferForgeProviderFromHost('')).toBeNull();
  });

  it('reads a typed host as the browser would: case and surrounding space do not matter', () => {
    expect(inferForgeProviderFromHost('  GitLab.COM ')).toBe('gitlab');
  });

  it('matches the whole host, never one that merely contains a known one', () => {
    expect(inferForgeProviderFromHost('gitlab.com.attacker.example')).toBeNull();
    expect(inferForgeProviderFromHost('notgithub.com')).toBeNull();
  });

  it('does not take a host that is also an object property name for a forge', () => {
    expect(inferForgeProviderFromHost('constructor')).toBeNull();
    expect(inferForgeProviderFromHost('__proto__')).toBeNull();
    expect(inferForgeProviderFromHost('toString')).toBeNull();
  });
});

describe('credentialForgeProvider', () => {
  it('infers a blank-provider credential from its host', () => {
    expect(credentialForgeProvider('', 'gitlab.com')).toBe('gitlab');
    expect(credentialForgeProvider(null, 'gitlab.com')).toBe('gitlab');
    expect(credentialForgeProvider(undefined, 'codeberg.org')).toBe('gitea');
  });

  it('lets an explicit provider win over the host', () => {
    expect(credentialForgeProvider('gitea', 'git.self-hosted.example')).toBe('gitea');
    expect(credentialForgeProvider('github', 'gitlab.com')).toBe('github');
  });

  it('leaves a blank provider on a self-hosted host unresolved', () => {
    expect(credentialForgeProvider('', 'git.self-hosted.example')).toBeNull();
    expect(credentialForgeProvider(null, 'git.self-hosted.example')).toBeNull();
  });

  it('treats a provider that is not a forge name as unset', () => {
    expect(credentialForgeProvider('nonsense', 'gitlab.com')).toBe('gitlab');
    expect(credentialForgeProvider('nonsense', 'git.self-hosted.example')).toBeNull();
  });
});
