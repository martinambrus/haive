import { mkdtemp, rm, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import { gitRun } from '../src/repo/git-exec.js';
import { fetchModuleSource, type FetchSource } from '../src/modules/source-fetch.js';
import { startGitHttpServer } from './support/git-http-fixture.js';

vi.mock('../src/modules/source-pin.js', () => ({
  resolveWorkerImage: vi.fn().mockResolvedValue('sha256:' + 'c'.repeat(64)),
  pinModuleTree: vi.fn(),
}));

const checkout = vi.hoisted(() => ({ count: 0, attempts: 0, transfers: [] as string[] }));
vi.mock('../src/repo/git-exec.js', async (original) => {
  const actual = await original<typeof import('../src/repo/git-exec.js')>();
  return {
    ...actual,
    gitRun: async (...args: Parameters<typeof actual.gitRun>) => {
      if (args[1].includes('checkout')) checkout.attempts++;
      if (args[1].includes('fetch')) checkout.transfers.push(args[0]);
      const result = await actual.gitRun(...args);
      if (args[1].includes('checkout') && result.code === 0) {
        expect((await actual.gitRun(args[0], ['symbolic-ref', '-q', 'HEAD'])).code).toBe(1);
        expect(await readdir(join(args[0], '.git', 'objects'))).not.toHaveLength(0);
        checkout.count++;
      }
      return result;
    },
  };
});

beforeEach(() => {
  checkout.count = 0;
  checkout.attempts = 0;
  checkout.transfers = [];
});
afterEach(() => vi.unstubAllEnvs());
it('refuses a real-git oversized blob before checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-source-large-blob-'));
  const fixture = await startGitHttpServer(root);
  const run = async (args: string[]) => {
    const result = await gitRun(root, args);
    expect(result.code, result.stderr).toBe(0);
  };
  try {
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
    await run(['init', '-b', 'main']);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@haive-module/alpha',
        exports: { './manifest': './manifest.js' },
      }),
    );
    // Incompressible bytes exercise the packed-object transfer bound, before checkout can run.
    await writeFile(join(root, 'blob'), randomBytes(65 * 1024 * 1024));
    await run(['add', 'package.json', 'blob']);
    await run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'large blob',
    ]);
    const pin = vi.fn();
    await expect(
      fetchModuleSource(
        {
          id: 'test',
          moduleId: 'alpha',
          kind: 'git',
          url: fixture.httpOrigin(root),
          ref: 'main',
          resolvedSha: null,
        },
        null,
        pin,
        undefined,
        (raw) => new URL(raw),
      ),
    ).rejects.toThrow('Module tree exceeds size limit');
    expect(checkout.attempts).toBe(0);
    expect(pin).not.toHaveBeenCalled();
    expect(checkout.transfers).toHaveLength(1);
    await expect(access(join(checkout.transfers[0]!, '..'))).rejects.toThrow();
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
it('resolves a raw SHA on its first real-git fetch and reports an unavailable object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'module-source-sha-'));
  const fixture = await startGitHttpServer(root);
  const run = async (args: string[]) => {
    const result = await gitRun(root, args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
    await run(['init', '-b', 'main']);
    await run(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@haive-module/alpha',
        exports: { './manifest': './manifest.js' },
      }),
    );
    await run(['add', 'package.json']);
    await run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    ]);
    const sha = await run(['rev-parse', 'HEAD']);
    const source: FetchSource = {
      id: 'test',
      moduleId: 'alpha',
      kind: 'git',
      url: fixture.httpOrigin(root),
      ref: sha,
      resolvedSha: null,
    };
    const pin = vi.fn();
    const resolved = vi.fn();
    const fetch = (ref: string) =>
      fetchModuleSource({ ...source, ref }, null, pin, resolved, (raw) => new URL(raw));
    expect(await fetch(sha)).toBe(sha);
    expect(resolved).toHaveBeenCalledWith(sha, null);
    expect(pin).toHaveBeenCalledOnce();
    pin.mockClear();
    resolved.mockClear();
    await expect(fetch('b'.repeat(40))).rejects.toThrow('module_source_ref_unavailable');
    expect(pin).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
it.each(['branch', 'tag', 'annotated tag'] as const)(
  'refuses a conflicting SHA-shaped %s before checkout and accepts one at the same commit',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'module-source-ambiguous-'));
    const fixture = await startGitHttpServer(root);
    const run = async (args: string[]) => {
      const result = await gitRun(root, args);
      expect(result.code, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
      vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
      await run(['init', '-b', 'main']);
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: '@haive-module/alpha', exports: { './manifest': './manifest.js' } }),
      );
      await run(['add', 'package.json']);
      const commit = async () =>
        run([
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ]);
      await commit();
      const first = await run(['rev-parse', 'HEAD']);
      await commit();
      const second = await run(['rev-parse', 'HEAD']);
      const nameRef = async (sha: string) => {
        // Use unambiguous revision expressions to create the deliberately ambiguous names.
        const target = sha === first ? 'HEAD~1' : 'HEAD';
        if (kind === 'branch') await run(['branch', '-f', first, target]);
        else {
          // A same-named branch at the requested commit must not hide a conflicting tag.
          await run(['branch', '-f', first, 'HEAD~1']);
          await run([
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            'tag',
            '-f',
            ...(kind === 'annotated tag' ? ['-a', '-m', 'fixture'] : []),
            first,
            target,
          ]);
        }
      };
      const pin = vi.fn();
      const resolved = vi.fn();
      const fetch = () =>
        fetchModuleSource(
          {
            id: 'test',
            moduleId: 'alpha',
            kind: 'git',
            url: fixture.httpOrigin(root),
            ref: first,
            resolvedSha: null,
          },
          null,
          pin,
          resolved,
          (raw) => new URL(raw),
        );
      await nameRef(second);
      await expect(fetch()).rejects.toThrow(
        'module_source_ref_ambiguous: A branch or tag is named like this commit',
      );
      expect(checkout.attempts).toBe(0);
      expect(pin).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      await nameRef(first);
      expect(await fetch()).toBe(first);
      expect(checkout.count).toBe(1);
      expect(pin).toHaveBeenCalledOnce();
      expect(resolved).toHaveBeenCalledWith(first, `refs/heads/${first}`);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
it('fetches real branches and tags, preserves a pin, and re-resolves only on Refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 't337-source-git-'));
  const fixture = await startGitHttpServer(root);
  const run = async (args: string[]) => {
    const result = await gitRun(root, args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    vi.stubEnv('HAIVE_OWN_MODULES_HOST_DIR', '/prepared');
    await run(['init', '-b', 'main']);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: '@haive-module/alpha', exports: { './manifest': './manifest.js' } }),
    );
    await writeFile(join(root, 'value'), 'first');
    const commit = async () => {
      await run(['add', 'package.json', 'value']);
      await run([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture',
      ]);
      return run(['rev-parse', 'HEAD']);
    };
    const first = await commit();
    await run([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'tag',
      '-a',
      'v1',
      '-m',
      'release',
    ]);
    const source: FetchSource = {
      id: 'test',
      moduleId: 'alpha',
      kind: 'git',
      url: fixture.httpOrigin(root),
      ref: 'main',
      resolvedSha: null,
    };
    const observed: string[] = [];
    const pin = async (tree: string) => {
      await expect(access(join(tree, '.git'))).rejects.toThrow();
      observed.push(await readFile(join(tree, 'value'), 'utf8'));
      expect(JSON.parse(await readFile(join(tree, '.haive-source.json'), 'utf8'))).toMatchObject({
        module_id: 'alpha',
        kind: 'git',
        sha: observed.at(-1) === 'first' ? first : second,
      });
    };
    const resolved = vi.fn();
    const fetch = (row: FetchSource) =>
      fetchModuleSource(row, null, pin, resolved, (raw) => new URL(raw));
    let second = '';
    expect(await fetch(source)).toBe(first);
    expect(resolved).toHaveBeenLastCalledWith(first, 'refs/heads/main');
    expect(await fetch({ ...source, ref: 'v1' })).toBe(first);
    await writeFile(join(root, 'value'), 'second');
    second = await commit();
    expect(second).not.toBe(first);
    expect(await fetch({ ...source, resolvedSha: first })).toBe(first);
    expect(await fetch({ ...source, resolvedSha: null })).toBe(second);
    expect(resolved).toHaveBeenLastCalledWith(second, 'refs/heads/main');
    await expect(fetch({ ...source, ref: '--upload-pack=bad' })).rejects.toThrow(
      'Invalid module branch or tag ref',
    );
    expect(observed).toEqual(['first', 'first', 'first', 'second']);
    expect(checkout.count).toBe(4);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    logger.info({ removed: root }, 'T337 real-git cleanup');
  }
});
