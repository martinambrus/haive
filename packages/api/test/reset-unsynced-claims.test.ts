import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ensureDirNoFollow,
  lstatNoFollow,
  readFileNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { logger } from '@haive/shared';
import { claimFileName, PROJECT_STATE_LIMITS } from '@haive/shared/project-state';

const h = vi.hoisted(() => ({ swap: '' }));
vi.mock('@haive/shared/fs-safe', async (load) => {
  const real = await load<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    readFileNoFollow: async (...args: Parameters<typeof real.readFileNoFollow>) => {
      const read = await real.readFileNoFollow(...args);
      if (args[1] === h.swap) {
        h.swap = '';
        await real.writeFileNoFollow(args[0], args[1], 'personal replacement');
      }
      return read;
    },
  };
});
import { resetOnboardingArtifacts } from '../src/routes/repos.js';

const state = '.haive-data/state';
const artifacts = `${state}/artifacts`;
const provenance = {
  writtenHashes: new Map<string, string>(),
  haiveDirs: new Set<string>(),
  haiveEntries: new Map<string, string | null>(),
};
const legacy = (path: string) => ({
  path,
  templateId: 'agent.code-reviewer',
  kind: 'agent',
  schemaVersion: 1,
  templateHash: 'a'.repeat(64),
  writtenHash: 'b'.repeat(64),
  haiveVersion: '0.1.0',
});
const file = (path: string) => `${state}/${claimFileName(path)}`;
const claimText = (path: string) => JSON.stringify(legacy(path));
const roots: string[] = [];
let template: string;
beforeAll(async () => {
  template = await mkdtemp(join(tmpdir(), 'reset-claim-template-'));
  await ensureDirNoFollow(template, artifacts);
  await writeFileNoFollow(template, `${state}/format.json`, '{"schemaVersion":1}');
});
afterAll(async () => {
  if (template) await rm(template, { recursive: true, force: true });
});
afterEach(async () => {
  h.swap = '';
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reset-claim-'));
  roots.push(root);
  await cp(template, root, { recursive: true });
  return root;
}
const read = async (root: string, rel: string) =>
  (await readFileNoFollow(root, rel, { strict: true }))?.data;

describe('unsynced claim sweep', () => {
  it('uses the record production limits', () => {
    expect(PROJECT_STATE_LIMITS).toEqual({
      maxEntries: 4096,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
    });
  });

  it('takes back codec-valid git-data aliases without touching the named git data', async () => {
    const root = await fixture();
    await ensureDirNoFollow(root, '.git');
    await writeFileNoFollow(root, '.git/config', 'git data');
    for (const path of ['.git/config', '.GIT./hooks/pre-commit']) {
      await writeFileNoFollow(root, file(path), claimText(path));
    }
    const result = await resetOnboardingArtifacts(root, provenance);
    for (const path of ['.git/config', '.GIT./hooks/pre-commit']) {
      expect(await lstatNoFollow(root, file(path))).toBeNull();
      expect(result.removed).toContain(file(path));
      expect(result.vacatedPaths.has(file(path))).toBe(true);
    }
    expect((await read(root, '.git/config'))?.toString()).toBe('git data');
  });

  it('keeps ordinary claims and everything the codec refuses, including an oversized file', async () => {
    const root = await fixture();
    const files = new Map<string, string | Buffer>([
      [file('README.md'), claimText('README.md')],
      [
        file('.git/bad-schema'),
        JSON.stringify({ ...legacy('.git/bad-schema'), schemaVersion: 'invalid' }),
      ],
      [file('../.git/config'), claimText('../.git/config')],
      [`${artifacts}/wrong.json`, claimText('.git/config')],
      [file('.git/marked'), claimText('.git/marked') + '\n<<<<<<< ours\n'],
      [file('.git/invalid-utf8'), Buffer.from([0xff])],
      [file('.git/oversized'), claimText('.git/oversized') + ' '.repeat(512)],
      [`${artifacts}/personal.txt`, 'personal'],
    ]);
    for (const [rel, text] of files) await writeFileNoFollow(root, rel, text);
    await resetOnboardingArtifacts(root, provenance, {
      claimSweepLimits: { ...PROJECT_STATE_LIMITS, maxFileBytes: 400 },
    });
    for (const [rel, text] of files) expect(await read(root, rel), rel).toEqual(Buffer.from(text));
  });

  it('keeps symlink and directory entries even at canonical claim names', async () => {
    const root = await fixture();
    await writeFileNoFollow(root, 'target.json', claimText('.git/linked'));
    await symlink(join(root, 'target.json'), join(root, file('.git/linked')));
    await ensureDirNoFollow(root, file('.git/directory'));
    await resetOnboardingArtifacts(root, provenance);
    expect(await lstatNoFollow(root, file('.git/linked'))).toMatchObject({ kind: 'symlink' });
    expect(await lstatNoFollow(root, file('.git/directory'))).toMatchObject({ kind: 'directory' });
    expect((await read(root, 'target.json'))?.toString()).toBe(claimText('.git/linked'));
  });

  it('refuses a linked claims directory and leaves its target alone', async () => {
    const root = await fixture();
    await rm(join(root, artifacts), { recursive: true });
    await ensureDirNoFollow(root, 'outside');
    const name = claimFileName('.git/config').slice('artifacts/'.length);
    await writeFileNoFollow(root, `outside/${name}`, claimText('.git/config'));
    await symlink(join(root, 'outside'), join(root, artifacts));
    const result = await resetOnboardingArtifacts(root, provenance);
    expect(result.skipped).toContainEqual({ path: artifacts, reason: expect.any(String) });
    expect((await read(root, `outside/${name}`))?.toString()).toBe(claimText('.git/config'));
  });

  it('logs and reports a capped listing, keeps every unlisted claim and still removes known claims', async () => {
    const root = await fixture();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    for (const path of ['.git/known', '.git/one', '.git/two', '.git/three']) {
      await writeFileNoFollow(root, file(path), claimText(path));
    }
    const result = await resetOnboardingArtifacts(
      root,
      {
        ...provenance,
        baseGitDataPaths: ['.git/known'],
      },
      { claimSweepLimits: { ...PROJECT_STATE_LIMITS, maxEntries: 2 } },
    );
    expect(await lstatNoFollow(root, file('.git/known'))).toBeNull();
    for (const path of ['.git/one', '.git/two', '.git/three']) {
      expect((await read(root, file(path)))?.toString()).toBe(claimText(path));
    }
    expect(warn).toHaveBeenCalledWith({ path: artifacts, maxEntries: 2 }, expect.any(String));
    expect(result.skipped).toContainEqual({
      path: artifacts,
      reason: expect.stringContaining('2-entry limit'),
    });
  });

  it('logs and reports exhaustion of its byte budget, leaving unread claims', async () => {
    const root = await fixture();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    for (const path of ['.git/one', '.git/two']) {
      await writeFileNoFollow(root, file(path), claimText(path));
    }
    const result = await resetOnboardingArtifacts(root, provenance, {
      claimSweepLimits: { ...PROJECT_STATE_LIMITS, maxTotalBytes: 8 },
    });
    for (const path of ['.git/one', '.git/two']) {
      expect((await read(root, file(path)))?.toString()).toBe(claimText(path));
    }
    expect(warn).toHaveBeenCalledWith({ path: artifacts, maxTotalBytes: 8 }, expect.any(String));
    expect(result.skipped).toContainEqual({
      path: artifacts,
      reason: expect.stringContaining('8-byte limit'),
    });
  });

  it('keeps a replacement saved after the codec read', async () => {
    const root = await fixture();
    h.swap = file('.git/config');
    await writeFileNoFollow(root, h.swap, claimText('.git/config'));
    await resetOnboardingArtifacts(root, provenance);
    expect((await read(root, file('.git/config')))?.toString()).toBe('personal replacement');
    expect(h.swap).toBe('');
  });
});
