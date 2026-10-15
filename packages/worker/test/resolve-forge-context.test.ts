import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { encrypt, encryptDek, generateDek, secretsService } from '@haive/shared';
import { ForgeError } from '@haive/shared/forge';
import { resolveForgeContext } from '../src/forge/resolve-forge-context.js';

const KEK = 'ab'.repeat(32);
const masterKek = vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);

type Row = { provider: string | null; host: string; apiBaseUrl: string | null };

const sealed = (username: string, secret: string) => {
  const dek = generateDek();
  return {
    usernameEncrypted: encrypt(username, dek),
    secretEncrypted: encrypt(secret, dek),
    encryptedDek: encryptDek(dek, KEK),
  };
};

const API_BASE_REFUSAL =
  "Edit the credential's API base: it must be https on the credential's host or its forge's API host.";
const REMOTE_REFUSAL =
  "This credential is not for the repository's remote: its host and forge must match the remote's. Choose another credential, or edit this one's host and provider.";
const NO_PROVIDER_REFUSAL =
  'This credential has no forge provider set, and the host is not a known public forge. Choose a provider (GitHub, Gitea/Forgejo, GitLab, Bitbucket) on the credential to open pull requests.';

const resolveReading = (findFirst: () => Promise<unknown>, remoteUrl: string) =>
  resolveForgeContext({
    db: { query: { repoCredentials: { findFirst } } } as unknown as Database,
    userId: 'user-1',
    credentialId: 'cred-1',
    remoteUrl,
  });

const resolve = (row: Row, remoteUrl: string) =>
  resolveReading(async () => ({ ...row, ...sealed('u', 'tok') }), remoteUrl);

async function outcomeOf(row: Row, remoteUrl: string): Promise<unknown> {
  try {
    return await resolve(row, remoteUrl);
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  masterKek.mockClear();
});

describe('resolveForgeContext', () => {
  it('refuses a stored API base that is not https on the credential host, before decrypting the token', async () => {
    const outcome = await outcomeOf(
      { provider: 'gitlab', host: 'gitlab.corp.example', apiBaseUrl: 'http://169.254.169.254/' },
      'https://gitlab.corp.example/acme/app.git',
    );
    expect(outcome).toBeInstanceOf(ForgeError);
    expect((outcome as ForgeError).message).toBe(API_BASE_REFUSAL);
    expect(masterKek).not.toHaveBeenCalled();
  });

  it.each([['https://gitlab.com/acme/app.git'], ['git@gitlab.com:acme/app.git']])(
    'refuses a gitlab credential on gitlab.corp.example for the gitlab.com remote %s, before decrypting the token',
    async (remote) => {
      const outcome = await outcomeOf(
        { provider: 'gitlab', host: 'gitlab.corp.example', apiBaseUrl: null },
        remote,
      );
      expect(outcome).toBeInstanceOf(ForgeError);
      expect((outcome as ForgeError).message).toBe(REMOTE_REFUSAL);
      expect(masterKek).not.toHaveBeenCalled();
    },
  );

  it('still names a missing provider before it names the host', async () => {
    const outcome = await outcomeOf(
      { provider: null, host: 'git.corp', apiBaseUrl: null },
      'https://git.corp/o/r.git',
    );
    expect((outcome as ForgeError).message).toBe(NO_PROVIDER_REFUSAL);
    expect(masterKek).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an auto-detect gitlab.com credential with no stored base',
      { provider: null, host: 'gitlab.com', apiBaseUrl: null },
      'https://gitlab.com/acme/app.git',
      { provider: 'gitlab', apiBase: 'https://gitlab.com/api/v4', host: 'gitlab.com' },
    ],
    [
      'a github.com credential with its forge API base stored',
      { provider: 'github', host: 'github.com', apiBaseUrl: 'https://api.github.com/' },
      'git@github.com:acme/app.git',
      { provider: 'github', apiBase: 'https://api.github.com', host: 'github.com' },
    ],
    [
      'a self-hosted gitea credential with a port and a stored base on its host',
      { provider: 'gitea', host: 'git.corp:3000', apiBaseUrl: 'https://git.corp:3000/api/v1/' },
      'https://git.corp:3000/acme/app.git',
      { provider: 'gitea', apiBase: 'https://git.corp:3000/api/v1', host: 'git.corp:3000' },
    ],
  ])('still builds the context of %s', async (_what, row, remote, expected) => {
    await expect(resolve(row, remote)).resolves.toEqual({
      ...expected,
      owner: 'acme',
      repo: 'app',
      token: 'tok',
      username: 'u',
    });
  });

  it('decrypts the row it checked, from one read, when an edit lands after the check', async () => {
    const checked = {
      provider: 'gitlab',
      host: 'gitlab.com',
      apiBaseUrl: null,
      ...sealed('alice', 'secret-a'),
    };
    const edited = {
      provider: 'gitlab',
      host: 'git.other.example',
      apiBaseUrl: null,
      ...sealed('mallory', 'secret-b'),
    };
    const findFirst = vi.fn().mockResolvedValueOnce(checked).mockResolvedValue(edited);

    const ctx = await resolveReading(findFirst, 'https://gitlab.com/acme/app.git');

    expect.soft(ctx).toMatchObject({ token: 'secret-a', username: 'alice' });
    expect.soft(findFirst).toHaveBeenCalledTimes(1);
  });
});
