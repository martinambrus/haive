import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  connectionCredentialFits,
  credentialApiHost,
  credentialUsableForPr,
  hostFromRemote,
} from '../src/forge/index.js';

const PROVIDERS = [
  null,
  '',
  'github',
  'gitlab',
  'gitea',
  'bitbucket_cloud',
  'bitbucket_server',
  'nonsense',
];
const HOSTS = [
  'github.com',
  'gitlab.com',
  'codeberg.org',
  'bitbucket.org',
  'git.example.com',
  'GitHub.com',
  'git.other.example',
  'Git.Example.com',
];
const REMOTES = [
  'https://github.com/acme/app.git',
  'git@github.com:acme/app.git',
  'ssh://git@github.com/acme/app.git',
  'https://gitlab.com/group/sub/app.git',
  'git@gitlab.com:group/app.git',
  'https://codeberg.org/acme/app.git',
  'git@bitbucket.org:acme/app.git',
  'https://git.example.com/acme/app.git',
  'git@git.example.com:acme/app.git',
  'ssh://git@git.example.com:2222/acme/app.git',
  'https://GIT.EXAMPLE.COM/acme/app.git',
  'git@GitHub.com:acme/app.git',
  'ssh://git@GitHub.com/acme/app.git',
  'git@GIT.EXAMPLE.COM:acme/app.git',
  'ssh://git@GIT.EXAMPLE.COM:2222/acme/app.git',
  'file:///srv/git/app.git',
  '/srv/git/app.git',
  '',
  '   ',
  'not a url',
  null,
];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fits = (provider: string | null, host: string, remote: string | null) =>
  credentialUsableForPr({ provider, host }, remote);

describe('hostFromRemote', () => {
  it.each([
    ['https://gitlab.com/martin/rs_test.git', 'gitlab.com'],
    ['git@github.com:acme/app.git', 'github.com'],
    ['ssh://git@github.com/acme/app.git', 'github.com'],
    ['ssh://git@github.com:22/acme/app.git', 'github.com'],
    ['ssh://git@git.example.com:2222/acme/app.git', 'git.example.com'],
    ['https://git.example.com:8443/acme/app.git', 'git.example.com:8443'],
    ['https://GIT.EXAMPLE.COM/acme/app.git', 'git.example.com'],
    ['git@GitHub.com:acme/app.git', 'github.com'],
    ['ssh://git@GitHub.com/acme/app.git', 'github.com'],
    ['git@GIT.EXAMPLE.COM:acme/app.git', 'git.example.com'],
    ['ssh://git@GIT.EXAMPLE.COM:2222/acme/app.git', 'git.example.com'],
    ['  git@bitbucket.org:acme/app.git ', 'bitbucket.org'],
    ['file:///srv/git/app.git', ''],
    ['/srv/git/app.git', ''],
    ['not a url', ''],
    ['', ''],
  ])('reads %j as host %j', (remote, host) => {
    expect(hostFromRemote(remote)).toBe(host);
  });

  it('answers as the worker did for every remote of the grid, but for an ssh port and an upper-case scp or ssh host', () => {
    const text = REMOTES.filter((remote) => remote !== null)
      .map((remote) => `${JSON.stringify(remote)}=>${JSON.stringify(hostFromRemote(remote))}\n`)
      .join('');
    expect(sha(text)).toBe('813eef3f732484346b6d4417315174c560673ebd678d964dc708025e573213eb');
  });
});

describe('credentialUsableForPr', () => {
  it.each([
    ['https://github.com/acme/app.git'],
    ['git@github.com:acme/app.git'],
    ['ssh://git@github.com/acme/app.git'],
    ['ssh://git@github.com:22/acme/app.git'],
  ])('takes an auto-detect github.com credential for the github.com remote %s', (remote) => {
    expect(fits(null, 'github.com', remote)).toBe(true);
    expect(fits('', 'github.com', remote)).toBe(true);
    expect(fits('github', 'github.com', remote)).toBe(true);
  });

  it('keeps a credential of one public forge out of another public forge', () => {
    expect(fits(null, 'github.com', 'https://gitlab.com/group/sub/app.git')).toBe(false);
    expect(fits('github', 'github.com', 'git@gitlab.com:group/app.git')).toBe(false);
    expect(fits(null, 'gitlab.com', 'https://github.com/acme/app.git')).toBe(false);
    expect(fits(null, 'gitlab.com', 'git@gitlab.com:group/app.git')).toBe(true);
    expect(fits(null, 'codeberg.org', 'https://codeberg.org/acme/app.git')).toBe(true);
    expect(fits(null, 'bitbucket.org', 'git@bitbucket.org:acme/app.git')).toBe(true);
    expect(fits(null, 'bitbucket.org', 'https://github.com/acme/app.git')).toBe(false);
  });

  it('lets an explicit provider decide for a public host, but only for a credential on that host', () => {
    expect(fits('gitea', 'codeberg.org', 'https://codeberg.org/acme/app.git')).toBe(true);
    expect(fits('gitea', 'git.example.com', 'https://codeberg.org/acme/app.git')).toBe(false);
    expect(fits('github', 'git.example.com', 'https://codeberg.org/acme/app.git')).toBe(false);
  });

  it.each([['https://git.example.com/acme/app.git'], ['git@git.example.com:acme/app.git']])(
    'takes a self-hosted credential for %s only with the same host and an explicit provider',
    (remote) => {
      expect(fits('gitea', 'git.example.com', remote)).toBe(true);
      expect(fits('gitlab', 'git.example.com', remote)).toBe(true);
      expect(fits(null, 'git.example.com', remote)).toBe(false);
      expect(fits('', 'git.example.com', remote)).toBe(false);
      expect(fits('nonsense', 'git.example.com', remote)).toBe(false);
      expect(fits('gitea', 'git.other.example', remote)).toBe(false);
      expect(fits('gitea', 'github.com', remote)).toBe(false);
    },
  );

  it('compares a self-hosted host as the remote spells it, an ssh port aside', () => {
    expect(fits('gitea', 'git.example.com', 'ssh://git@git.example.com:2222/acme/app.git')).toBe(
      true,
    );
    expect(fits('gitea', 'git.example.com', 'https://git.example.com:8443/acme/app.git')).toBe(
      false,
    );
    expect(fits('gitea', 'git.example.com:8443', 'https://git.example.com:8443/acme/app.git')).toBe(
      true,
    );
    expect(fits('gitea', 'git.example.com', 'https://GIT.EXAMPLE.COM/acme/app.git')).toBe(true);
  });

  it.each([
    ['ssh://git@git.example.com:2222/a/b.git'],
    ['git@git.example.com:a/b.git'],
    ['git://git.example.com:9418/a/b.git'],
  ])(
    'takes a self-hosted credential with a forge port in its host for the non-http(s) remote %s',
    (remote) => {
      expect(fits('gitea', 'git.example.com:8443', remote)).toBe(true);
      expect(fits('gitea', 'Git.Example.com:8443', remote)).toBe(true);
      expect(fits('gitea', 'other.example.com:8443', remote)).toBe(false);
      expect(fits(null, 'git.example.com:8443', remote)).toBe(false);
      expect(fits('nonsense', 'git.example.com:8443', remote)).toBe(false);
    },
  );

  it.each([
    [null],
    [''],
    ['   '],
    ['file:///srv/git/app.git'],
    ['/srv/git/app.git'],
    ['not a url'],
  ])('fits no credential to the remote %j', (remote) => {
    expect(fits('github', 'github.com', remote)).toBe(false);
    expect(fits('gitea', 'git.example.com', remote)).toBe(false);
  });

  it.each([
    ['gitea', 'Git.Example.com', 'https://git.example.com/acme/app.git'],
    ['gitea', 'GIT.EXAMPLE.COM', 'git@git.example.com:acme/app.git'],
    ['gitea', 'git.example.com', 'ssh://git@GIT.EXAMPLE.COM/acme/app.git'],
    ['gitea', 'git.example.com', 'git@GIT.EXAMPLE.COM:acme/app.git'],
    ['gitlab', 'Git.Example.com', 'ssh://git@GIT.EXAMPLE.COM:2222/acme/app.git'],
  ])(
    'takes a %s credential on %s for the remote %s whatever the letter case',
    (provider, host, remote) => {
      expect(fits(provider, host, remote)).toBe(true);
    },
  );

  it('still needs the same host and an explicit provider once the letter case is ignored', () => {
    expect(fits('gitea', 'Git.Other.example', 'https://git.example.com/acme/app.git')).toBe(false);
    expect(fits('gitea', 'Git.Example.com:8443', 'https://git.example.com/acme/app.git')).toBe(
      false,
    );
    expect(fits(null, 'Git.Example.com', 'https://git.example.com/acme/app.git')).toBe(false);
    expect(fits('nonsense', 'Git.Example.com', 'git@GIT.EXAMPLE.COM:acme/app.git')).toBe(false);
  });

  it('answers as the worker did for every credential and remote of the grid, but for an ssh port, a host in other letter case and a public remote reached by a credential of another host', () => {
    let bits = '';
    for (const provider of PROVIDERS) {
      for (const host of HOSTS) {
        for (const remote of REMOTES) bits += fits(provider, host, remote) ? '1' : '0';
      }
    }
    expect(bits).toHaveLength(1344);
    expect([...bits].filter((bit) => bit === '1')).toHaveLength(116);
    expect(sha(bits)).toBe('02a87922b39bed270163d242d25cbc219ec5ee6686af11070cb8e9c09d09c9fd');
  });
});

describe('credentialUsableForPr: a token goes only to the host it belongs to', () => {
  it.each([['https://gitlab.com/acme/app.git'], ['git@gitlab.com:acme/app.git']])(
    'keeps a gitlab credential on gitlab.corp.example out of the gitlab.com remote %s',
    (remote) => {
      expect(fits('gitlab', 'gitlab.corp.example', remote)).toBe(false);
    },
  );

  it.each([['https://github.com/acme/app.git'], ['git@github.com:acme/app.git']])(
    'still takes a github.com credential, explicit or auto-detect, for the github.com remote %s',
    (remote) => {
      expect(fits('github', 'github.com', remote)).toBe(true);
      expect(fits(null, 'github.com', remote)).toBe(true);
    },
  );

  it.each([['https://git.corp:3000/o/r.git'], ['git@git.corp:o/r.git']])(
    'still takes a self-hosted gitea credential on git.corp:3000 for %s',
    (remote) => {
      expect(fits('gitea', 'git.corp:3000', remote)).toBe(true);
    },
  );
});

describe('connectionCredentialFits', () => {
  const SELF_REMOTE = 'https://git.example.com/acme/app.git';
  const credentialFits = (
    providerId: string,
    provider: string | null,
    host: string,
    remote: string | null,
  ) => connectionCredentialFits(providerId, { provider, host }, remote);

  it.each([
    ['github', 'github', 'github.com', 'https://github.com/acme/app.git'],
    ['github', null, 'github.com', 'git@github.com:acme/app.git'],
    ['gitlab', null, 'gitlab.com', 'https://gitlab.com/group/sub/app.git'],
    ['github', 'github', 'ghe.example.com', 'https://ghe.example.com/acme/app.git'],
    ['gitea', 'gitea', 'git.example.com', SELF_REMOTE],
    ['gitea', 'gitea', 'git.example.com', 'git@git.example.com:acme/app.git'],
  ])(
    'takes a %s connection whose credential (provider %j) on %s is of that forge, for %s',
    (providerId, provider, host, remote) => {
      expect(credentialFits(providerId, provider, host, remote)).toBe(true);
    },
  );

  it.each([
    ['github', 'gitea', 'git.example.com', SELF_REMOTE],
    ['gitea', 'github', 'git.example.com', SELF_REMOTE],
    ['gitlab', null, 'github.com', 'https://github.com/acme/app.git'],
    ['github', 'gitlab', 'gitlab.com', 'https://gitlab.com/group/app.git'],
  ])(
    'refuses a %s connection whose credential is now of another forge (provider %j on %s), though the remote %s takes that credential',
    (providerId, provider, host, remote) => {
      expect(credentialUsableForPr({ provider, host }, remote)).toBe(true);
      expect(credentialFits(providerId, provider, host, remote)).toBe(false);
    },
  );

  it.each(['github', 'gitea', 'gitlab'])(
    'refuses a %s connection whose self-hosted credential names no provider',
    (providerId) => {
      expect(credentialFits(providerId, null, 'git.example.com', SELF_REMOTE)).toBe(false);
      expect(credentialFits(providerId, '', 'git.example.com', SELF_REMOTE)).toBe(false);
    },
  );

  it.each([
    ['github', 'github', 'github.com', 'https://gitlab.com/group/app.git'],
    ['github', 'github', 'git.example.com', 'https://github.com/acme/app.git'],
    ['gitea', 'gitea', 'git.example.com', 'https://codeberg.org/acme/app.git'],
    ['gitea', 'gitea', 'git.other.example', SELF_REMOTE],
  ])(
    'refuses a %s connection whose credential (provider %j on %s) is of the forge but not for the remote %s',
    (providerId, provider, host, remote) => {
      expect(credentialFits(providerId, provider, host, remote)).toBe(false);
    },
  );

  it('judges a connection of a provider that is no forge by the remote alone', () => {
    // No Git credential has a module provider as its forge; a connection that still holds one is the
    // engine's to route (the worker's module-provider stamping tests do), not this comparison's.
    expect(
      credentialFits('module.fx.crm', 'github', 'github.com', 'https://github.com/acme/app.git'),
    ).toBe(true);
    expect(credentialFits('module.fx.crm', 'gitea', 'git.example.com', SELF_REMOTE)).toBe(true);
    expect(credentialFits('module.fx.crm', null, 'git.example.com', SELF_REMOTE)).toBe(false);
    expect(
      credentialFits('module.fx.crm', 'github', 'github.com', 'https://gitlab.com/g/app.git'),
    ).toBe(false);
  });

  it.each([[null], [''], ['file:///srv/git/app.git']])(
    'fits no connection to the remote %j',
    (remote) => {
      expect(credentialFits('github', 'github', 'github.com', remote)).toBe(false);
      expect(credentialFits('gitea', 'gitea', 'git.example.com', remote)).toBe(false);
    },
  );
});

describe('credentialApiHost', () => {
  it.each([
    [
      'an ssh remote on a port',
      'ssh://git@git.example.com:2222/a/b.git',
      'git.example.com:8443',
      'git.example.com:8443',
    ],
    [
      'an scp remote',
      'git@git.example.com:a/b.git',
      'Git.Example.com:8443',
      'git.example.com:8443',
    ],
    [
      'an ssh remote, credential without a port',
      'git@git.example.com:a/b.git',
      'git.example.com',
      'git.example.com',
    ],
    [
      'an ssh remote, credential on another host',
      'git@git.example.com:a/b.git',
      'other.example.com:8443',
      'git.example.com',
    ],
    [
      'an https remote with a port',
      'https://git.example.com:8443/a/b.git',
      'git.example.com:9443',
      'git.example.com:8443',
    ],
    [
      'an https remote without a port',
      'https://git.example.com/a/b.git',
      'git.example.com:8443',
      'git.example.com',
    ],
  ])('takes %s', (_what, remote, credentialHost, expected) => {
    expect(credentialApiHost(credentialHost, remote)).toBe(expected);
  });
});
