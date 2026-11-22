import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attemptVersion, readAttemptInstallFields } from './attempt-fields.js';

it('accepts 64-character versions and replaces 65-character versions with unknown', () => {
  const longest = '1'.repeat(64);
  expect(attemptVersion(longest)).toBe(longest);
  expect(attemptVersion(longest + '1')).toBe('unknown');
});

describe('safe display fields for an early attempt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attempt-fields-'));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it.each([
    ['HAIVE_CHANNEL=acme\nHAIVE_VERSION=1.2.3\n', 'acme'],
    ['HAIVE_VERSION=1.2.3\n', 'public'],
    ['HAIVE_CHANNEL=\nHAIVE_VERSION=1.2.3\n', 'public'],
    ["export HAIVE_CHANNEL = 'acme' # channel\r\nHAIVE_VERSION=1.2.3\r\n", 'acme'],
    ['HAIVE_CHANNEL="acme"\nHAIVE_VERSION=1.2.3\n', 'acme'],
    ["OTHER='multiline\nHAIVE_CHANNEL=wrong\n'\nHAIVE_VERSION=1.2.3\n", 'public'],
    ['HAIVE_CHANNEL=${OTHER}\nHAIVE_CHANNEL=acme\nHAIVE_VERSION=1.2.3\n', 'acme'],
  ])('reads literal fields using the existing env parser: %j', async (text, channel) => {
    await writeFile(join(dir, '.env'), text);
    expect(await readAttemptInstallFields(dir)).toEqual({ channel, fromVersion: '1.2.3' });
  });

  it.each(['${CHANNEL}', 'INVALID/channel'])(
    'marks an unresolved channel without losing a known version: %s',
    async (channel) => {
      await writeFile(join(dir, '.env'), `HAIVE_CHANNEL=${channel}\nHAIVE_VERSION=1.2.3\n`);
      const result = await readAttemptInstallFields(dir);
      expect(result).toEqual({
        channel: 'unknown',
        fromVersion: '1.2.3',
        note: 'Install channel could not be resolved from literal .env settings.',
      });
      expect(result.note).not.toContain(channel);
    },
  );

  it.each(['', 'HAIVE_VERSION=${VERSION}\n', 'HAIVE_VERSION=invalid/version\n'])(
    'explains an absent or unresolved version without losing the channel: %j',
    async (version) => {
      await writeFile(join(dir, '.env'), `HAIVE_CHANNEL=acme\n${version}`);
      expect(await readAttemptInstallFields(dir)).toEqual({
        channel: 'acme',
        fromVersion: 'unknown',
        note: 'Current version could not be resolved from literal .env settings.',
      });
    },
  );

  it.each(['absent', 'directory', 'linked', 'oversized', 'invalid'])(
    'explains unreadable settings without exposing file data: %s',
    async (kind) => {
      const file = join(dir, '.env');
      if (kind === 'directory') await mkdir(file);
      if (kind === 'linked') {
        await writeFile(join(dir, 'private'), 'secret');
        await symlink(join(dir, 'private'), file);
      }
      if (kind === 'oversized') await writeFile(file, 's'.repeat(17));
      if (kind === 'invalid') await writeFile(file, "SECRET='broken");
      expect(await readAttemptInstallFields(dir, 16)).toEqual({
        channel: 'not-read',
        fromVersion: 'not-read',
        note: 'Install channel and current version were not read: .env was unavailable, unsafe, oversized or invalid.',
      });
    },
  );

  it('accepts a file exactly at the read limit', async () => {
    const text = 'HAIVE_VERSION=1.2.3\n';
    await writeFile(join(dir, '.env'), text);
    expect(await readAttemptInstallFields(dir, Buffer.byteLength(text))).toEqual({
      channel: 'public',
      fromVersion: '1.2.3',
    });
  });

  it('returns not-read for a FIFO .env without blocking', async () => {
    execFileSync('mkfifo', [join(dir, '.env')]);
    expect(await readAttemptInstallFields(dir)).toEqual({
      channel: 'not-read',
      fromVersion: 'not-read',
      note: 'Install channel and current version were not read: .env was unavailable, unsafe, oversized or invalid.',
    });
  }, 1000);
});
