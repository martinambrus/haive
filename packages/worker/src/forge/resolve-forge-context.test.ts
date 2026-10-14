import { describe, expect, it } from 'vitest';
import { credentialForgeProvider, inferForgeProviderFromHost } from './index.js';
import { hostFromRemote, parseRemote } from './resolve-forge-context.js';

describe('parseRemote', () => {
  it('parses an https URL', () => {
    expect(parseRemote('https://github.com/acme/app.git', 'github')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
    });
  });
  it('parses an scp-style ssh URL', () => {
    expect(parseRemote('git@github.com:acme/app.git', 'github')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
    });
  });
  it('keeps a GitLab subgroup path in the owner', () => {
    expect(parseRemote('https://gitlab.com/group/sub/app.git', 'gitlab')).toEqual({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'app',
    });
  });
  it('strips the /scm prefix for Bitbucket Server', () => {
    expect(parseRemote('https://bb.acme.io/scm/PROJ/app.git', 'bitbucket_server')).toEqual({
      host: 'bb.acme.io',
      owner: 'PROJ',
      repo: 'app',
    });
  });
});

describe('credential forge inference', () => {
  it('extracts the host from https and scp remotes', () => {
    expect(hostFromRemote('https://gitlab.com/martin/rs_test.git')).toBe('gitlab.com');
    expect(hostFromRemote('git@github.com:acme/app.git')).toBe('github.com');
  });
  it('infers the forge for well-known public hosts only', () => {
    expect(inferForgeProviderFromHost('gitlab.com')).toBe('gitlab');
    expect(inferForgeProviderFromHost('github.com')).toBe('github');
    expect(inferForgeProviderFromHost('codeberg.org')).toBe('gitea');
    expect(inferForgeProviderFromHost('bitbucket.org')).toBe('bitbucket_cloud');
    expect(inferForgeProviderFromHost('git.self-hosted.example')).toBeNull();
  });
  it('resolves a blank-provider credential from its host (the picker bug)', () => {
    // An "auto-detect" GitLab credential (blank provider) must still resolve to gitlab so
    // it is offered for a gitlab.com repo instead of being dropped from the picker.
    expect(credentialForgeProvider('', 'gitlab.com')).toBe('gitlab');
    expect(credentialForgeProvider(null, 'gitlab.com')).toBe('gitlab');
    // An explicit provider wins over the host (self-hosted Gitea on any host).
    expect(credentialForgeProvider('gitea', 'git.self-hosted.example')).toBe('gitea');
    // Blank provider on a self-hosted host stays unresolved (needs an explicit pick).
    expect(credentialForgeProvider('', 'git.self-hosted.example')).toBeNull();
  });
});
