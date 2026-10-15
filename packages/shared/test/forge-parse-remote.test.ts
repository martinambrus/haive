import { describe, expect, it } from 'vitest';
import {
  ForgeError,
  hostFromRemote,
  parseRemote,
  resolveForgeProvider,
} from '../src/forge/index.js';

describe('parseRemote', () => {
  it('reads owner and repo, with the /scm prefix of Bitbucket Server dropped', () => {
    expect(parseRemote('https://gitlab.com/group/sub/app.git', 'gitlab')).toEqual({
      host: 'gitlab.com',
      owner: 'group/sub',
      repo: 'app',
    });
    expect(parseRemote('https://bb.acme.io/scm/PROJ/app.git', 'bitbucket_server')).toEqual({
      host: 'bb.acme.io',
      owner: 'PROJ',
      repo: 'app',
    });
  });

  it('refuses a remote with no readable host or owner', () => {
    expect(() => parseRemote('not a url', 'github')).toThrow(ForgeError);
    expect(() => parseRemote('https://github.com/app.git', 'github')).toThrow(ForgeError);
  });

  it('reads an ssh remote by its hostname, without the ssh port', () => {
    expect(parseRemote('ssh://git@git.example.com:2222/acme/app.git', 'gitea')).toEqual({
      host: 'git.example.com',
      owner: 'acme',
      repo: 'app',
    });
    expect(parseRemote('ssh://git@bb.acme.io:7999/PROJ/app.git', 'bitbucket_server')).toEqual({
      host: 'bb.acme.io',
      owner: 'PROJ',
      repo: 'app',
    });
  });

  it.each([
    ['git+ssh://git@git.example.com:2222/acme/app.git'],
    ['git://git.example.com:9418/acme/app.git'],
  ])('reads %s by its hostname too: the port belongs to the transport', (remote) => {
    expect(parseRemote(remote, 'gitea').host).toBe('git.example.com');
    expect(hostFromRemote(remote)).toBe('git.example.com');
  });

  it('keeps the port of an https or http remote, where the forge listens', () => {
    expect(parseRemote('https://git.example.com:8443/acme/app.git', 'gitea').host).toBe(
      'git.example.com:8443',
    );
    expect(parseRemote('http://git.example.com:3000/acme/app.git', 'gitea').host).toBe(
      'git.example.com:3000',
    );
    expect(hostFromRemote('http://git.example.com:3000/acme/app.git')).toBe('git.example.com:3000');
  });

  it.each([
    ['https://github.com/acme/app.git'],
    ['git@github.com:acme/app.git'],
    ['ssh://git@github.com/acme/app.git'],
    ['ssh://git@git.example.com:2222/acme/app.git'],
    ['https://GIT.EXAMPLE.COM/acme/app.git'],
    ['https://git.example.com:8443/acme/app.git'],
  ])('names the same host as hostFromRemote for %s', (remote) => {
    expect(parseRemote(remote, 'gitea').host).toBe(hostFromRemote(remote));
  });

  it('builds the default API base from the hostname, never from an ssh port', () => {
    const bitbucket = parseRemote('ssh://git@bb.acme.io:7999/PROJ/app.git', 'bitbucket_server');
    expect(resolveForgeProvider('bitbucket_server').defaultApiBase(bitbucket.host)).toBe(
      'https://bb.acme.io/rest/api/1.0',
    );
    const gitea = parseRemote('ssh://git@git.example.com:2222/acme/app.git', 'gitea');
    expect(resolveForgeProvider('gitea').defaultApiBase(gitea.host)).toBe(
      'https://git.example.com/api/v1',
    );
  });

  it('keeps an https port in the default API base, where the forge listens', () => {
    const { host } = parseRemote('https://git.example.com:8443/acme/app.git', 'gitea');
    expect(resolveForgeProvider('gitea').defaultApiBase(host)).toBe(
      'https://git.example.com:8443/api/v1',
    );
  });
});
