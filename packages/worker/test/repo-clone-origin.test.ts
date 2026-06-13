import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAuthenticatedUrl, gitSetOriginUrl } from '../src/repo/clone.js';

const exec = promisify(execFile);
const tmpDirs: string[] = [];

async function mkTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('clean-origin clone', () => {
  it('gitSetOriginUrl strips an embedded token from origin', async () => {
    const work = await mkTmp('clone-origin-');
    await exec('git', ['init', work]);
    // What a credentialed clone leaves behind: the token baked into origin.
    await exec('git', [
      '-C',
      work,
      'remote',
      'add',
      'origin',
      'https://user:ghp_secrettoken@github.com/owner/repo.git',
    ]);

    await gitSetOriginUrl(work, 'https://github.com/owner/repo.git');

    const after = await exec('git', ['-C', work, 'remote', 'get-url', 'origin']);
    expect(after.stdout.trim()).toBe('https://github.com/owner/repo.git');
    expect(after.stdout).not.toContain('ghp_secrettoken');
  });

  it('buildAuthenticatedUrl differs from the clean URL (so handleClone resets it)', () => {
    const clean = 'https://github.com/owner/repo.git';
    const authed = buildAuthenticatedUrl(clean, 'user', 'ghp_token');
    expect(authed).not.toBe(clean);
    expect(authed).toContain('user');
    expect(authed).toContain('ghp_token');
  });
});
